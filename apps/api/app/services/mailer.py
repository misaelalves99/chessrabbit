"""
Outbound email.

Two backends, selected by whether EMAIL_API_KEY is set:

- Console (dev): logs the full message. Verification/reset links appear in the
  API logs so the flow is testable without any provider.
- HTTP (prod): POSTs to a Resend-compatible API. Swap `_send_http` for your
  provider of choice (Postmark, SES, Mailgun) - it is the only coupled code.

All sends are best-effort: a mail failure must never fail the API request that
triggered it. Callers should not await delivery guarantees.
"""

from __future__ import annotations

import logging

import httpx

from app.core.config import settings

log = logging.getLogger(__name__)

RESEND_API = "https://api.resend.com/emails"


async def send_email(to: str, subject: str, text: str) -> bool:
    """Send an email. Returns True if handed off successfully."""
    if not settings.EMAIL_API_KEY:
        log.info(
            "EMAIL (console backend)\n  to: %s\n  subject: %s\n  body:\n%s",
            to, subject, "\n".join(f"    {line}" for line in text.splitlines()),
        )
        return True

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                RESEND_API,
                headers={"Authorization": f"Bearer {settings.EMAIL_API_KEY}"},
                json={
                    "from": settings.EMAIL_FROM,
                    "to": [to],
                    "subject": subject,
                    "text": text,
                },
            )
        if resp.status_code >= 400:
            log.error("Email send failed (%s): %s", resp.status_code, resp.text[:300])
            return False
        return True
    except httpx.HTTPError as exc:
        log.error("Email send error: %s", exc)
        return False


async def send_verification_email(to: str, token: str) -> bool:
    link = f"{settings.APP_BASE_URL}/verify?token={token}"
    return await send_email(
        to,
        "Verify your ChessRabbit email",
        f"Welcome to ChessRabbit!\n\n"
        f"Confirm your email address by opening this link:\n\n  {link}\n\n"
        f"The link expires in 48 hours. If you didn't create an account, ignore this.",
    )


async def send_reset_email(to: str, token: str) -> bool:
    link = f"{settings.APP_BASE_URL}/reset?token={token}"
    return await send_email(
        to,
        "Reset your ChessRabbit password",
        f"Someone requested a password reset for this address.\n\n"
        f"Set a new password here:\n\n  {link}\n\n"
        f"The link expires in 1 hour. If this wasn't you, you can safely ignore it - "
        f"your password has not changed.",
    )
