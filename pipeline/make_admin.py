#!/usr/bin/env python3
"""Grant admin to an account:  python pipeline/make_admin.py you@example.com"""
import os
import sys
import psycopg

if len(sys.argv) != 2:
    sys.exit("usage: make_admin.py <email>")

dsn = os.getenv("DATABASE_URL", "postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit")
with psycopg.connect(dsn) as conn, conn.cursor() as cur:
    cur.execute("UPDATE users SET is_admin = TRUE WHERE email = %s RETURNING id", (sys.argv[1],))
    row = cur.fetchone()
    conn.commit()
print(f"user {row[0]} is now an admin" if row else "no such user")
