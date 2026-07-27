#!/usr/bin/env python3
"""
Create (or reset) one demo account per plan tier.

    python pipeline/seed_demo_users.py

Idempotent: re-running re-hashes the same passwords and re-applies the plan,
so it doubles as a way to put a poked-at demo account back to a known state.
Passwords are hashed with the same argon2 helper the API uses, so these
accounts log in through the normal /auth/login path.
"""
import os

import psycopg
from argon2 import PasswordHasher

# Constructed exactly as app/core/security.py does it (default parameters), so
# the hashes written here verify against the API's own verify_password(). Kept
# standalone rather than importing that module, which would pull in the whole
# settings/config chain just to hash three strings.
hash_password = PasswordHasher().hash

# Not a .test/.local address: the API validates with Pydantic's EmailStr, which
# rejects reserved TLDs outright, so such an account could never log in.
DEMOS = [
    ("demo.free@chessrabbit.dev", "DemoFree123!", "Demo Free", "free"),
    ("demo.pro@chessrabbit.dev", "DemoPro123!", "Demo Pro", "pro"),
    ("demo.master@chessrabbit.dev", "DemoMaster123!", "Demo Master", "master"),
]

# The API speaks asyncpg; psycopg wants the plain driver name.
# Host port is 5433, not 5432 - see the note in docker-compose.yml.
dsn = os.getenv(
    "DATABASE_URL", "postgresql://chessrabbit:devpassword@localhost:5433/chessrabbit"
).replace("+asyncpg", "")

with psycopg.connect(dsn) as conn, conn.cursor() as cur:
    for email, password, name, plan in DEMOS:
        cur.execute(
            """
            INSERT INTO users (email, password_hash, display_name, plan, email_verified)
            VALUES (%s, %s, %s, %s, TRUE)
            ON CONFLICT (email) DO UPDATE
              SET password_hash  = EXCLUDED.password_hash,
                  display_name   = EXCLUDED.display_name,
                  plan           = EXCLUDED.plan,
                  email_verified = TRUE,
                  deleted_at     = NULL,
                  suspended_at   = NULL
            RETURNING id
            """,
            (email, hash_password(password), name, plan),
        )
        print(f"{plan:<7} {email:<30} {password:<16} (id {cur.fetchone()[0]})")
    conn.commit()

print("\nDone. These are dev fixtures - do not ship them to a public deployment.")
