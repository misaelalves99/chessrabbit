#!/usr/bin/env python3
"""
Create (or reset) one demo account per plan tier, plus a demo admin.

    python pipeline/seed_demo_users.py

Idempotent: re-running re-hashes the same passwords and re-applies the plan and
the admin flag, so it doubles as a way to put a poked-at demo account back to a
known state - including revoking an admin flag somebody granted by hand.
Passwords are hashed with the same argon2 helper the API uses, so these
accounts log in through the normal /auth/login path.

THESE ARE DEV FIXTURES WITH PASSWORDS PUBLISHED IN THIS REPOSITORY. The admin
one in particular grants the /admin surface - every customer's email address,
and the ability to change what they pay. It must never exist on a public
deployment, so this script refuses to run against ENVIRONMENT=production. For a
real operator account use `python pipeline/make_admin.py you@example.com`, which
promotes an account whose password only that person knows.
"""
import os
import sys

import psycopg
from argon2 import PasswordHasher

# Constructed exactly as app/core/security.py does it (default parameters), so
# the hashes written here verify against the API's own verify_password(). Kept
# standalone rather than importing that module, which would pull in the whole
# settings/config chain just to hash three strings.
hash_password = PasswordHasher().hash

# Not a .test/.local address: the API validates with Pydantic's EmailStr, which
# rejects reserved TLDs outright, so such an account could never log in.
#
# (email, password, display name, plan, is_admin)
DEMOS = [
    ("demo.free@chessrabbit.dev", "DemoFree123!", "Demo Free", "free", False),
    ("demo.pro@chessrabbit.dev", "DemoPro123!", "Demo Pro", "pro", False),
    ("demo.master@chessrabbit.dev", "DemoMaster123!", "Demo Master", "master", False),
    # Signs in at /admin, NOT through the normal login form - the admin surface
    # issues its own token type and refuses player tokens. See docs/DEPLOYMENT.md.
    ("demo.admin@chessrabbit.dev", "DemoAdmin123!", "Demo Admin", "master", True),
]

# Fails CLOSED. The previous check refused only when ENVIRONMENT was literally
# "production", so running this on a server where that variable happened to be
# unset - a fresh shell, a cron entry, a one-off `docker exec` - seeded a
# working admin account whose password is printed in this file. An unset
# variable is not evidence that this is a development machine, so it is no
# longer treated as permission.
_environment = os.getenv("ENVIRONMENT")
if _environment != "development":
    sys.exit(
        f"Refusing to seed demo accounts (ENVIRONMENT={_environment or 'unset'}). "
        "Their passwords are published in this repository and one of them is an "
        "admin, so this runs only with ENVIRONMENT=development set explicitly. "
        "For a real operator account use: python pipeline/make_admin.py you@example.com"
    )

# The API speaks asyncpg; psycopg wants the plain driver name.
# Host port is 5433, not 5432 - see the note in docker-compose.yml.
dsn = os.getenv(
    "DATABASE_URL", "postgresql://chessrabbit:devpassword@localhost:5433/chessrabbit"
).replace("+asyncpg", "")

with psycopg.connect(dsn) as conn, conn.cursor() as cur:
    for email, password, name, plan, is_admin in DEMOS:
        cur.execute(
            """
            INSERT INTO users
              (email, password_hash, display_name, plan, email_verified, is_admin)
            VALUES (%s, %s, %s, %s, TRUE, %s)
            ON CONFLICT (email) DO UPDATE
              SET password_hash  = EXCLUDED.password_hash,
                  display_name   = EXCLUDED.display_name,
                  plan           = EXCLUDED.plan,
                  email_verified = TRUE,
                  is_admin       = EXCLUDED.is_admin,
                  deleted_at     = NULL,
                  suspended_at   = NULL
            RETURNING id
            """,
            (email, hash_password(password), name, plan, is_admin),
        )
        tag = "ADMIN" if is_admin else plan
        print(f"{tag:<7} {email:<30} {password:<16} (id {cur.fetchone()[0]})")
    conn.commit()

print("\nDemo admin signs in at /admin - a separate door from the player login.")
print("These are dev fixtures - do not ship them to a public deployment.")
