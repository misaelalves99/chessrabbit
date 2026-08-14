"""
Stripe billing.

Design notes (BLUEPRINT.md Phase 2):

- Stripe is the source of truth for subscription state. Our `subscriptions`
  table is a mirror updated ONLY by webhooks, never by client requests.
- The plan flip (free <-> pro) happens exclusively in the webhook handler.
  A user cannot become pro by calling our API; only a signed Stripe event
  can do that.
- Webhook signatures are verified manually (HMAC-SHA256 over "{t}.{body}"
  with the endpoint secret, per Stripe's documented scheme). No Stripe SDK
  dependency: the two API calls we make (checkout session, portal session)
  are plain form-encoded POSTs via httpx.
- Idempotency: every event id is inserted into processed_webhook_events
  first; a conflict means we've seen it and we return 200 without acting.
  Stripe retries aggressively - this table is what makes retries safe.

Local testing without Stripe:
    Events can be constructed and signed with STRIPE_WEBHOOK_SECRET by any
    test harness - see tests. For live testing:
    stripe listen --forward-to localhost:8000/billing/webhook
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.breaker import CircuitOpen, breaker
from app.core.config import settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.models import Subscription, User

log = logging.getLogger(__name__)
router = APIRouter(prefix="/billing", tags=["billing"])

STRIPE_API = "https://api.stripe.com/v1"
SIGNATURE_TOLERANCE_S = 300

# Stripe subscription statuses that grant pro access
ACTIVE_STATUSES = {"active", "trialing"}


def _require_stripe_config() -> None:
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "billing_not_configured",
                "message": "Billing is not configured on this server "
                           "(STRIPE_SECRET_KEY is unset).",
            },
        )


# Checkout and portal are the only outbound Stripe calls, and both sit in front
# of a user waiting on a button. There is no useful fallback for "start a
# payment", so the breaker's job here is purely to stop a wedged Stripe from
# holding 20 seconds of worker per click during an incident.
_stripe_breaker = breaker(
    "stripe",
    failure_threshold=5,
    reset_after=30.0,
    slow_call_seconds=10.0,
    max_concurrency=8,
)


async def _stripe_request(path: str, data: dict) -> httpx.Response:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            f"{STRIPE_API}{path}",
            auth=(settings.STRIPE_SECRET_KEY, ""),
            data=data,
        )
    # 5xx means Stripe is unwell and the breaker should hear about it; 4xx
    # means we sent something wrong, which retrying elsewhere will not fix and
    # which must not trip the circuit for everyone else.
    if resp.status_code >= 500:
        log.error("Stripe %s failed (%s): %s", path, resp.status_code, resp.text[:300])
        raise httpx.HTTPStatusError(
            f"stripe {resp.status_code}", request=resp.request, response=resp
        )
    return resp


async def _stripe_post(path: str, data: dict) -> dict:
    try:
        resp = await _stripe_breaker.call(_stripe_request, path, data)
    except CircuitOpen as exc:
        log.warning("Stripe circuit open, refusing %s: %s", path, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "stripe_unavailable",
                "message": "The payment provider is not responding. "
                           "Please try again in a minute.",
            },
        ) from exc
    except httpx.HTTPError as exc:
        log.error("Stripe %s errored: %s", path, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "stripe_error", "message": "Payment provider request failed"},
        ) from exc

    if resp.status_code >= 400:
        log.error("Stripe %s failed (%s): %s", path, resp.status_code, resp.text[:300])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "stripe_error", "message": "Payment provider request failed"},
        )
    return resp.json()


# ------------------------------------------------------------------
# Checkout & portal (require live Stripe keys)
# ------------------------------------------------------------------

@router.post("/checkout")
async def create_checkout_session(
    payload: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start a Stripe Checkout session for the Pro subscription."""
    _require_stripe_config()

    interval = payload.get("interval", "monthly")
    price = (
        settings.STRIPE_PRICE_PRO_YEARLY
        if interval == "yearly"
        else settings.STRIPE_PRICE_PRO_MONTHLY
    )
    if not price:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "billing_not_configured", "message": "Price IDs are unset"},
        )
    from app.core.tiers import is_paid

    if is_paid(user.plan):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "already_pro", "message": "You already have a paid subscription"},
        )

    data = {
        "mode": "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        # client_reference_id ties the eventual webhook back to our user
        "client_reference_id": str(user.id),
        "customer_email": user.email,
        "success_url": f"{settings.APP_BASE_URL}/app?upgraded=1",
        "cancel_url": f"{settings.APP_BASE_URL}/app?canceled=1",
    }

    # Returning customers reuse their Stripe customer id
    sub_row = await db.execute(select(Subscription).where(Subscription.user_id == user.id))
    existing = sub_row.scalar_one_or_none()
    if existing:
        data.pop("customer_email")
        data["customer"] = existing.stripe_customer_id

    session = await _stripe_post("/checkout/sessions", data)
    return {"url": session["url"]}


@router.post("/portal")
async def create_portal_session(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Stripe customer portal: manage payment method, cancel, invoices."""
    _require_stripe_config()

    sub_row = await db.execute(select(Subscription).where(Subscription.user_id == user.id))
    sub = sub_row.scalar_one_or_none()
    if sub is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "no_subscription", "message": "No billing history for this account"},
        )

    session = await _stripe_post(
        "/billing_portal/sessions",
        {"customer": sub.stripe_customer_id, "return_url": f"{settings.APP_BASE_URL}/app"},
    )
    return {"url": session["url"]}


# ------------------------------------------------------------------
# Webhook (fully testable offline)
# ------------------------------------------------------------------

def verify_stripe_signature(payload: bytes, header: str, secret: str) -> bool:
    """
    Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]
    Valid iff any v1 equals HMAC_SHA256(secret, f"{t}.{payload}") and t is
    within tolerance. Constant-time comparison throughout.
    """
    try:
        parts = dict(
            item.split("=", 1) for item in header.split(",") if "=" in item
        )
        t = parts.get("t", "")
        timestamp = int(t)
    except (ValueError, AttributeError):
        return False

    if abs(time.time() - timestamp) > SIGNATURE_TOLERANCE_S:
        return False

    signed = f"{t}.".encode() + payload
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    candidates = [v for k, v in
                  (item.split("=", 1) for item in header.split(",") if "=" in item)
                  if k == "v1"]
    return any(hmac.compare_digest(expected, c) for c in candidates)


async def _mark_processed(db: AsyncSession, event_id: str) -> bool:
    """Insert-first idempotency. Returns True if this is the first sighting."""
    result = await db.execute(
        text(
            "INSERT INTO processed_webhook_events (event_id) VALUES (:id) "
            "ON CONFLICT (event_id) DO NOTHING"
        ),
        {"id": event_id},
    )
    return result.rowcount == 1


async def _set_plan(db: AsyncSession, user_id: int, plan: str) -> None:
    await db.execute(
        text("UPDATE users SET plan = :plan WHERE id = :uid"),
        {"plan": plan, "uid": user_id},
    )


async def _upsert_subscription(
    db: AsyncSession, user_id: int, customer: str,
    subscription: str | None, sub_status: str, period_end: int | None,
) -> None:
    await db.execute(
        text(
            """
            INSERT INTO subscriptions
              (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
            VALUES (:uid, :cust, :sub, :st, to_timestamp(:pe))
            ON CONFLICT (user_id) DO UPDATE SET
              stripe_customer_id = EXCLUDED.stripe_customer_id,
              stripe_subscription_id = EXCLUDED.stripe_subscription_id,
              status = EXCLUDED.status,
              current_period_end = EXCLUDED.current_period_end,
              updated_at = now()
            """
        ),
        {"uid": user_id, "cust": customer, "sub": subscription,
         "st": sub_status, "pe": period_end or 0},
    )


async def _user_by_customer(db: AsyncSession, customer: str) -> int | None:
    row = await db.execute(
        select(Subscription.user_id).where(Subscription.stripe_customer_id == customer)
    )
    return row.scalar_one_or_none()


async def _record_event(
    db: AsyncSession, user_id: int, event_type: str, plan: str,
    sub_status: str | None = None, stripe_event_id: str | None = None,
) -> None:
    """
    Append to the billing ledger (migration 013).

    `subscriptions` is overwritten in place by each webhook, so a cancellation
    used to erase the fact that the subscription had ever existed - churn and
    new-subscriptions-per-day were not computable from it at any price. This
    table is the history the admin dashboard reads.

    The amount is snapshotted from the tier price at event time rather than
    joined at read time, so repricing a tier does not rewrite past revenue.
    """
    from app.core.tiers import tier_for

    await db.execute(
        text(
            """
            INSERT INTO subscription_events
              (user_id, event_type, plan, status, amount_cents, stripe_event_id)
            VALUES (:uid, :type, :plan, :status, :amount, :event_id)
            """
        ),
        {
            "uid": user_id, "type": event_type, "plan": plan, "status": sub_status,
            "amount": round(tier_for(plan).price_monthly * 100),
            "event_id": stripe_event_id,
        },
    )


@router.post("/webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(default="", alias="Stripe-Signature"),
    db: AsyncSession = Depends(get_db),
):
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "billing_not_configured", "message": "Webhook secret unset"},
        )

    payload = await request.body()
    if not verify_stripe_signature(payload, stripe_signature, settings.STRIPE_WEBHOOK_SECRET):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_signature", "message": "Webhook signature check failed"},
        )

    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_payload", "message": "Body is not JSON"},
        )

    event_id = event.get("id", "")
    event_type = event.get("type", "")
    obj = event.get("data", {}).get("object", {}) or {}

    if not event_id:
        raise HTTPException(status_code=400, detail={"code": "invalid_payload", "message": "Missing event id"})

    if not await _mark_processed(db, event_id):
        await db.commit()
        log.info("Webhook %s already processed; skipping", event_id)
        return {"received": True, "duplicate": True}

    handled = True

    if event_type == "checkout.session.completed":
        user_id = int(obj.get("client_reference_id") or 0)
        customer = obj.get("customer") or ""
        subscription = obj.get("subscription")
        # "Completed" means the customer finished the flow, not that money
        # moved. Delayed methods (bank debits, vouchers) complete the session
        # with payment_status "unpaid" and settle days later - or never. Cards
        # settle immediately and arrive here as "paid", so this changes nothing
        # for the common path and closes the one where a subscription is
        # granted for a payment that has not happened yet. The later
        # customer.subscription.updated event grants the plan once it does.
        payment_status = obj.get("payment_status", "paid")
        if payment_status not in ("paid", "no_payment_required"):
            log.info(
                "Checkout %s completed but payment_status=%s; leaving plan unchanged",
                obj.get("id"), payment_status,
            )
        elif user_id and customer:
            await _upsert_subscription(db, user_id, customer, subscription, "active", None)
            await _set_plan(db, user_id, "pro")
            await _record_event(db, user_id, "subscribed", "pro", "active", event_id)
            log.info("User %s upgraded to pro (checkout %s)", user_id, obj.get("id"))
        else:
            log.warning("checkout.session.completed missing reference/customer: %s", event_id)

    elif event_type == "customer.subscription.updated":
        customer = obj.get("customer") or ""
        user_id = await _user_by_customer(db, customer)
        if user_id:
            sub_status = obj.get("status", "")
            await _upsert_subscription(
                db, user_id, customer, obj.get("id"),
                sub_status, obj.get("current_period_end"),
            )
            plan = "pro" if sub_status in ACTIVE_STATUSES else "free"
            await _set_plan(db, user_id, plan)
            # A still-active subscription that fired an update is a renewal;
            # anything else is a state change worth distinguishing on the
            # dashboard, since the second kind is what precedes churn.
            await _record_event(
                db, user_id,
                "renewed" if sub_status in ACTIVE_STATUSES else "status_changed",
                plan, sub_status, event_id,
            )
            log.info("User %s subscription -> %s (plan=%s)", user_id, sub_status, plan)
        else:
            log.warning("subscription.updated for unknown customer %s", customer)

    elif event_type == "customer.subscription.deleted":
        customer = obj.get("customer") or ""
        user_id = await _user_by_customer(db, customer)
        if user_id:
            await _upsert_subscription(db, user_id, customer, obj.get("id"), "canceled", None)
            await db.execute(
                text("UPDATE subscriptions SET canceled_at = now() WHERE user_id = :uid"),
                {"uid": user_id},
            )
            await _set_plan(db, user_id, "free")
            # Priced at the plan they are leaving, not the free plan they land
            # on - this row is what churned MRR is summed from.
            await _record_event(db, user_id, "canceled", "pro", "canceled", event_id)
            log.info("User %s subscription canceled -> free", user_id)

    elif event_type == "invoice.payment_failed":
        customer = obj.get("customer") or ""
        user_id = await _user_by_customer(db, customer)
        if user_id:
            await _record_event(db, user_id, "payment_failed", "pro", "past_due", event_id)
        log.warning("Payment failed for customer %s (dunning handled by Stripe)", customer)

    else:
        handled = False
        log.info("Ignoring webhook type %s", event_type)

    await db.commit()
    return {"received": True, "handled": handled}
