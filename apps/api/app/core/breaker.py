"""
Circuit breakers for the third-party APIs this service calls.

The failure this prevents: Lichess (or Chess.com, or Stripe) gets slow rather
than dead. Every request that touches it parks on a socket for the full
timeout, new requests keep arriving, and the pile of waiters starves the event
loop and the connection pool of work that has nothing to do with chess.com
being unwell. The endpoints that never call out - analysis, puzzles, the
opening explorer's local scope - go down with it.

Three mechanisms, all necessary:

- A **breaker**. Consecutive failures trip it; while open, calls fail
  immediately instead of waiting for a timeout that we already know is coming.
  After `reset_after` one trial call is allowed through, and its result decides
  whether the circuit closes or stays open for another interval.
- A **slow-call rule**. A call that returns successfully after 10 seconds is a
  failure for our purposes: it held a worker for 10 seconds. Slow calls count
  toward the same threshold as errors.
- A **bulkhead**. At most `max_concurrency` calls to one dependency may be in
  flight; the rest are rejected outright rather than queued. This is what caps
  the blast radius before the breaker has even tripped, and it stops us from
  DDoSing an upstream that is already struggling.

State is per process. With `uvicorn --workers 4` each worker learns
independently, which costs at most `failure_threshold` wasted calls per worker
per outage and needs no shared store - notably not Redis, which is itself a
dependency that can be the thing failing.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")

CLOSED, OPEN, HALF_OPEN = "closed", "open", "half_open"


class CircuitOpen(Exception):
    """The dependency is known-bad (or saturated); the call was not attempted."""


class CircuitBreaker:
    """One breaker per upstream dependency. Not shared between processes."""

    def __init__(
        self,
        name: str,
        *,
        failure_threshold: int = 5,
        reset_after: float = 30.0,
        slow_call_seconds: float | None = None,
        max_concurrency: int = 8,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_after = reset_after
        self.slow_call_seconds = slow_call_seconds
        self.max_concurrency = max_concurrency

        self._state = CLOSED
        self._failures = 0
        self._opened_at = 0.0
        self._in_flight = 0
        self._trial_running = False
        self._lock = asyncio.Lock()

    # -- introspection ------------------------------------------------

    @property
    def state(self) -> str:
        """Current state, resolving an elapsed open interval to half_open."""
        if self._state == OPEN and time.monotonic() - self._opened_at >= self.reset_after:
            return HALF_OPEN
        return self._state

    def snapshot(self) -> dict[str, Any]:
        """For /health. Cheap and side-effect free."""
        return {
            "state": self.state,
            "failures": self._failures,
            "in_flight": self._in_flight,
        }

    # -- the guarded call ---------------------------------------------

    async def call(self, fn: Callable[..., Awaitable[T]], *args: Any, **kwargs: Any) -> T:
        """
        Run `fn`, or raise CircuitOpen without running it.

        Any exception from `fn` counts as a failure and is re-raised unchanged,
        so callers keep their existing error handling; only the extra
        CircuitOpen case is new.
        """
        await self._acquire()
        started = time.monotonic()
        try:
            result = await fn(*args, **kwargs)
        except Exception:
            await self._record_failure("error")
            raise
        else:
            elapsed = time.monotonic() - started
            if self.slow_call_seconds is not None and elapsed >= self.slow_call_seconds:
                # Returned, but too late to be worth waiting for. Counted, not
                # raised: the caller asked for this data and it is here.
                await self._record_failure(f"slow ({elapsed:.1f}s)")
            else:
                await self._record_success()
            return result
        finally:
            self._in_flight -= 1

    async def _acquire(self) -> None:
        async with self._lock:
            state = self.state

            if state == OPEN:
                raise CircuitOpen(f"{self.name} is unavailable (circuit open)")

            if state == HALF_OPEN:
                # Exactly one probe at a time. Letting the whole backlog through
                # the moment the timer expires is how a recovering upstream gets
                # knocked over again.
                if self._trial_running:
                    raise CircuitOpen(f"{self.name} is recovering (circuit half-open)")
                self._state = HALF_OPEN
                self._trial_running = True
            elif self._in_flight >= self.max_concurrency:
                raise CircuitOpen(
                    f"{self.name} is at its concurrency limit "
                    f"({self.max_concurrency} in flight)"
                )

            self._in_flight += 1

    async def _record_success(self) -> None:
        async with self._lock:
            if self._state != CLOSED:
                log.info("Circuit %s closed after a successful call", self.name)
            self._state = CLOSED
            self._failures = 0
            self._trial_running = False

    async def _record_failure(self, reason: str) -> None:
        async with self._lock:
            self._trial_running = False
            self._failures += 1
            if self._state == HALF_OPEN or self._failures >= self.failure_threshold:
                if self._state != OPEN:
                    log.warning(
                        "Circuit %s opened after %d failures (%s); "
                        "failing fast for %.0fs",
                        self.name, self._failures, reason, self.reset_after,
                    )
                self._state = OPEN
                self._opened_at = time.monotonic()


# Registered here so /health can report them and so each dependency has exactly
# one breaker regardless of how many call sites it has.
BREAKERS: dict[str, CircuitBreaker] = {}


def breaker(name: str, **kwargs: Any) -> CircuitBreaker:
    """Get or create the breaker for a dependency."""
    if name not in BREAKERS:
        BREAKERS[name] = CircuitBreaker(name, **kwargs)
    return BREAKERS[name]


def snapshot_all() -> dict[str, dict[str, Any]]:
    return {name: b.snapshot() for name, b in BREAKERS.items()}
