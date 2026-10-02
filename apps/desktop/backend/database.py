"""A private PostgreSQL cluster; no system service or existing database is used."""

import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile

import psycopg
from psycopg import sql


def write_json(path: Path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


class LocalDatabase:
    def __init__(self, resources: Path, data: Path):
        self.bin = resources / "runtime" / "pgsql" / "bin"
        self.cluster = data / "postgres"
        self.data = data
        self.started = False
        config = data / "database.json"
        if not config.exists():
            write_json(config, {"password": secrets.token_urlsafe(48), "jwt_secret": secrets.token_urlsafe(48)})
        self.config = json.loads(config.read_text(encoding="utf-8"))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.dsn = f"postgresql://chessrabbit:{self.config['password']}@127.0.0.1:{self.port}/chessrabbit"

    def run(self, program, *args, **kwargs):
        # pg_ctl's Windows server child can inherit stdout. A pipe would wait
        # for the server to exit before seeing EOF, even after pg_ctl returns.
        with tempfile.TemporaryFile(dir=self.data) as output:
            result = subprocess.run(
                [str(self.bin / f"{program}.exe"), *map(str, args)],
                stdout=output, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                timeout=90, **kwargs,
            )
            if result.returncode:
                output.seek(0)
                raise RuntimeError(f"{program} failed: {output.read().decode(errors='replace')[-5000:]}")
        return result

    def start(self, migrations: Path):
        if not (self.cluster / "PG_VERSION").exists():
            password_file = self.data / "initdb-password.tmp"
            password_file.write_text(self.config["password"], encoding="utf-8")
            try:
                self.run("initdb", "-D", self.cluster, "-U", "chessrabbit", "--encoding=UTF8", "--no-locale",
                         "--auth=scram-sha-256", "--pwfile", password_file)
            finally:
                password_file.unlink(missing_ok=True)
        if (self.cluster / "PG_VERSION").read_text().strip() != "16":
            raise RuntimeError("This version requires a PostgreSQL 16 workspace. Your data has been preserved.")
        self.run("pg_ctl", "-D", self.cluster, "-l", self.data / "postgres.log", "-w", "-t", "60",
                 "-o", f"-h 127.0.0.1 -p {self.port} -c max_connections=30 -c shared_buffers=32MB", "start")
        self.started = True
        with psycopg.connect(self.dsn.rsplit("/", 1)[0] + "/postgres", autocommit=True) as conn:
            if not conn.execute("SELECT 1 FROM pg_database WHERE datname = 'chessrabbit'").fetchone():
                conn.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8'").format(sql.Identifier("chessrabbit")))
        with psycopg.connect(self.dsn) as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS desktop_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)")
            conn.commit()
            applied = dict(conn.execute("SELECT name, checksum FROM desktop_schema_migrations").fetchall())
            for path in sorted(migrations.glob("*.sql")):
                content = path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(content.encode()).hexdigest()
                if path.name in applied:
                    if applied[path.name] != checksum:
                        raise RuntimeError(f"Applied migration changed: {path.name}. Your data has been preserved.")
                    continue
                with conn.transaction():
                    conn.execute(content, prepare=False)
                    conn.execute("INSERT INTO desktop_schema_migrations VALUES (%s, %s)", (path.name, checksum))
            conn.execute("UPDATE analysis_jobs SET status='failed', error='Application closed before analysis finished', finished_at=now() WHERE status IN ('queued', 'running')")
            conn.commit()

    def stop(self):
        if self.started:
            self.run("pg_ctl", "-D", self.cluster, "-m", "fast", "-w", "-t", "30", "stop")
            self.started = False
