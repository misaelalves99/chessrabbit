"""
Circuit breaker behaviour.

These are the properties the outage story depends on: that a dependency which
is failing stops being called, that it is retried exactly once when the
cooldown expires, that a recovered dependency closes the circuit, and that a
saturated one is rejected rather than queued.
"""

import asyncio

import pytest

from app.core.breaker import CLOSED, HALF_OPEN, OPEN, CircuitBreaker, CircuitOpen


async def boom():
    raise RuntimeError("upstream is down")


async def fine():
    return "ok"


@pytest.mark.asyncio
async def test_opens_after_threshold_then_fails_without_calling():
    calls = {"n": 0}

    async def counted():
        calls["n"] += 1
        raise RuntimeError("down")

    cb = CircuitBreaker("t", failure_threshold=3, reset_after=60.0)

    for _ in range(3):
        with pytest.raises(RuntimeError):
            await cb.call(counted)
    assert cb.state == OPEN
    assert calls["n"] == 3

    # Open circuit: rejected without touching the dependency.
    for _ in range(10):
        with pytest.raises(CircuitOpen):
            await cb.call(counted)
    assert calls["n"] == 3


@pytest.mark.asyncio
async def test_one_probe_at_a_time_when_half_open():
    cb = CircuitBreaker("t", failure_threshold=1, reset_after=0.05)
    with pytest.raises(RuntimeError):
        await cb.call(boom)
    assert cb.state == OPEN

    await asyncio.sleep(0.06)
    assert cb.state == HALF_OPEN

    gate = asyncio.Event()

    async def slow_probe():
        await gate.wait()
        return "ok"

    probe = asyncio.create_task(cb.call(slow_probe))
    await asyncio.sleep(0)  # let the probe take the half-open slot

    # A second caller must not be let through alongside the probe.
    with pytest.raises(CircuitOpen):
        await cb.call(fine)

    gate.set()
    assert await probe == "ok"
    assert cb.state == CLOSED


@pytest.mark.asyncio
async def test_failed_probe_reopens_for_another_interval():
    cb = CircuitBreaker("t", failure_threshold=1, reset_after=0.05)
    with pytest.raises(RuntimeError):
        await cb.call(boom)

    await asyncio.sleep(0.06)
    with pytest.raises(RuntimeError):
        await cb.call(boom)
    assert cb.state == OPEN

    with pytest.raises(CircuitOpen):
        await cb.call(fine)


@pytest.mark.asyncio
async def test_recovery_closes_the_circuit():
    cb = CircuitBreaker("t", failure_threshold=2, reset_after=0.05)
    for _ in range(2):
        with pytest.raises(RuntimeError):
            await cb.call(boom)

    await asyncio.sleep(0.06)
    assert await cb.call(fine) == "ok"
    assert cb.state == CLOSED
    assert await cb.call(fine) == "ok"


@pytest.mark.asyncio
async def test_slow_success_counts_as_a_failure():
    cb = CircuitBreaker(
        "t", failure_threshold=2, reset_after=60.0, slow_call_seconds=0.02
    )

    async def slow():
        await asyncio.sleep(0.03)
        return "late"

    # The value still comes back - a slow call is served, just held against
    # the dependency's record.
    assert await cb.call(slow) == "late"
    assert await cb.call(slow) == "late"
    assert cb.state == OPEN


@pytest.mark.asyncio
async def test_bulkhead_rejects_rather_than_queues():
    cb = CircuitBreaker("t", failure_threshold=99, reset_after=60.0, max_concurrency=2)
    gate = asyncio.Event()

    async def held():
        await gate.wait()
        return "ok"

    running = [asyncio.create_task(cb.call(held)) for _ in range(2)]
    await asyncio.sleep(0)

    with pytest.raises(CircuitOpen):
        await cb.call(fine)

    gate.set()
    assert await asyncio.gather(*running) == ["ok", "ok"]

    # Slots are returned, so the next caller gets through.
    assert await cb.call(fine) == "ok"
