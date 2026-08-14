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

from app.core.breaker import CircuitOpen, breaker
from app.core.config import settings
from app.core.redact import mask_email

log = logging.getLogger(__name__)

RESEND_API = "https://api.resend.com/emails"

# Sends already run in a BackgroundTask, so a slow provider does not delay the
# response - but it does hold a task and a socket per registration for the full
# timeout. Once the provider is clearly down, stop dialling: the send fails
# either way, and the user's next attempt should not be queued behind ours.
_breaker = breaker(
    "email",
    failure_threshold=5,
    reset_after=60.0,
    slow_call_seconds=5.0,
    max_concurrency=10,
)


async def _post(to: str, subject: str, text: str) -> httpx.Response:
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
    if resp.status_code >= 500:
        raise httpx.HTTPStatusError(
            f"email provider {resp.status_code}", request=resp.request, response=resp
        )
    return resp


async def send_email(to: str, subject: str, text: str) -> bool:
    """Send an email. Returns True if handed off successfully."""
    if not settings.EMAIL_API_KEY:
        # The console backend prints the whole message, and the whole message
        # is what contains the password-reset link. That is exactly what makes
        # it useful in development and exactly what makes it a credential leak
        # anywhere else: anyone who can read the application log - a shipped
        # log drain, a support engineer, a compromised aggregator - can take
        # over any account by triggering a reset and reading the token.
        #
        # config.py refuses to boot production without EMAIL_API_KEY, so this
        # is the second lock on the same door rather than the only one.
        if settings.is_production:
            log.error(
                "Email to %s not sent: no EMAIL_API_KEY configured. Refusing to "
                "fall back to the console backend in production - it would "
                "print the reset link to the log.",
                mask_email(to),
            )
            return False

        log.info(
            "EMAIL (console backend)\n  to: %s\n  subject: %s\n  body:\n%s",
            to, subject, "\n".join(f"    {line}" for line in text.splitlines()),
        )
        return True

    try:
        resp = await _breaker.call(_post, to, subject, text)
    except CircuitOpen as exc:
        log.error("Email not sent to %s: %s", mask_email(to), exc)
        return False
    except httpx.HTTPError as exc:
        log.error("Email send error: %s", exc)
        return False

    if resp.status_code >= 400:
        # The provider echoes the recipient back in its error body, so the
        # status is logged and the body is not.
        log.error("Email send failed for %s (HTTP %s)", mask_email(to), resp.status_code)
        return False
    return True


async def send_verification_email(to: str, token: str) -> bool:
    link = f"{settings.APP_BASE_URL}/verify?token={token}"
    return await send_email(
        to,
        "Verify your ChessRabbit email",
        f"Welcome to ChessRabbit!\n\n"
        f"Confirm your email address by opening this link:\n\n  {link}\n\n"
        f"The link expires in {settings.VERIFY_TOKEN_TTL_HOURS} hours. If you didn't "
        f"create an account, ignore this.",
    )


async def send_reset_email(to: str, token: str) -> bool:
    link = f"{settings.APP_BASE_URL}/reset?token={token}"
    return await send_email(
        to,
        "Reset your ChessRabbit password",
        f"Someone requested a password reset for this address.\n\n"
        f"Set a new password here:\n\n  {link}\n\n"
        f"The link expires in {settings.RESET_TOKEN_TTL_MIN} minutes. If this wasn't "
        f"you, you can safely ignore it - "
        f"your password has not changed.",
    )
