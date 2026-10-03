"""
Redaction helpers for anything that reaches a log.

Application logs are not a private place. They are shipped to aggregators,
read by whoever is on call, kept far longer than the data they describe, and
are outside the deletion path a user gets when they close their account - so an
email address written to a log line is a copy of personal data we cannot easily
find again, let alone erase.

The rule this module encodes: logs identify records, they do not contain them.
A user id is enough to investigate an incident and means nothing to anyone who
steals the log. Where a human genuinely needs to recognise the value - a failed
sign-in for an address that does not exist, say - `mask_email` keeps just
enough shape to match it against a report without disclosing the address.

The deliberate exception is the admin_audit table: that is an access-controlled
record inside the database, subject to the same retention and deletion rules as
everything else, and it stores full values on purpose.
"""

from __future__ import annotations


def mask_email(email: str | None) -> str:
    """
    ``alice@example.com`` -> ``a***e@example.com``; short locals fully masked.

    The domain survives because it is what makes a log line actionable - a
    burst of failures against one corporate domain is a different incident from
    a burst spread across providers - and because a domain on its own does not
    identify anybody.
    """
    if not email:
        return "<none>"
    local, _, domain = email.partition("@")
    if not domain:
        return "<malformed>"
    if len(local) <= 2:
        masked = "*" * len(local)
    else:
        masked = f"{local[0]}{'*' * (len(local) - 2)}{local[-1]}"
    return f"{masked}@{domain}"


def mask_token(token: str | None) -> str:
    """
    Enough of a token to correlate two log lines, never enough to use one.

    Eight characters of a 64-character secret is not a meaningful brute-force
    head start; the whole token in a log is an account takeover waiting for
    somebody to read it.
    """
    if not token:
        return "<none>"
    return f"{token[:8]}…({len(token)} chars)"
