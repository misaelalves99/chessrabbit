"""Verified upstream Windows runtimes, corresponding engine source and notices."""

import hashlib
from importlib import metadata
import json
from pathlib import Path
import shutil
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".test-cache" / "desktop-downloads"
DEST = ROOT / "dist" / "desktop-assets"
DOWNLOADS = {
    "postgresql-16.15.zip": (
        "https://get.enterprisedb.com/postgresql/postgresql-16.15-1-windows-x64-binaries.zip",
        "25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e",
    ),
    "stockfish-19.zip": (
        "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip",
        "3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7",
    ),
}


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    DEST.mkdir(parents=True, exist_ok=True)
    for name, (url, checksum) in DOWNLOADS.items():
        archive = CACHE / name
        if not archive.exists():
            temporary = archive.with_suffix(".part")
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(archive)
        with archive.open("rb") as handle:
            if hashlib.file_digest(handle, "sha256").hexdigest() != checksum:
                raise RuntimeError(f"Checksum mismatch: {name}. Remove this cached download and retry.")
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                if entry.is_dir():
                    continue
                if name.startswith("postgresql"):
                    if not (entry.filename.startswith(("pgsql/bin/", "pgsql/lib/", "pgsql/share/"))
                            or entry.filename in {"pgsql/server_license.txt", "pgsql/commandlinetools_3rd_party_licenses.txt"}):
                        continue
                output = (DEST / entry.filename).resolve()
                if not output.is_relative_to(DEST.resolve()):
                    raise RuntimeError(f"Unsafe archive path: {entry.filename}")
                output.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, output.open("wb") as target:
                    shutil.copyfileobj(source, target)
            if name.startswith("postgresql"):
                for dll in ("vcruntime140.dll", "vcruntime140_1.dll"):
                    (DEST / "pgsql" / "bin" / dll).write_bytes(bundle.read(f"pgsql/pgAdmin 4/python/{dll}"))
    # Freeze environments do not always keep distribution notices; collect them explicitly.
    licenses = DEST / "python-licenses"
    records = []
    for distribution in metadata.distributions():
        name = distribution.metadata["Name"]
        if name in {"pytest", "ruff", "pyinstaller", "pip", "setuptools"}:
            continue
        records.append({"name": name, "version": distribution.version,
                        "license": distribution.metadata.get("License-Expression") or distribution.metadata.get("License", "See packaged notices")})
        for entry in distribution.files or []:
            if any(part.lower().startswith(("license", "copying", "notice", "authors")) for part in entry.parts):
                source = Path(distribution.locate_file(entry))
                if source.is_file():
                    target = licenses / name / str(entry)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
    (DEST / "python-dependencies.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    for filename in ("LICENSE.txt", "LICENSE"):
        python_license = Path(sys.base_prefix) / filename
        if python_license.exists():
            shutil.copyfile(python_license, DEST / "PYTHON-LICENSE.txt")
            break
    print(f"Prepared verified native resources in {DEST}")


if __name__ == "__main__":
    main()
