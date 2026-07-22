"""
The three plans and everything they entitle.

free   - 3 game reviews/day, 5 puzzles/day, 1 Puzzle Rush/day,
         3 openings per colour
pro    - $4.99/mo: unlimited reviews, puzzles, and Rush; top 12 White
         openings + top 10 Black defences
master - $9.99/mo: everything unlimited, every opening, opponent prep,
         the newest engine build

Engine honesty: both paid tiers run the newest official Stockfish we ship
server-side. Leela joins the master tier when a GPU host exists - the
pricing page says "coming soon", never claims it early.
"""

from __future__ import annotations

from dataclasses import dataclass

UNLIMITED = -1


@dataclass(frozen=True)
class Tier:
    id: str
    label: str
    price_monthly: float        # USD, 0 for free
    reviews_per_day: int        # UNLIMITED for paid tiers
    puzzles_per_day: int
    rush_per_day: int
    openings_white: int         # catalog ranks unlocked; UNLIMITED = all
    openings_black: int
    opponent_prep: bool


TIERS: dict[str, Tier] = {
    "free": Tier(
        id="free", label="Free", price_monthly=0,
        reviews_per_day=3, puzzles_per_day=5, rush_per_day=1,
        openings_white=3, openings_black=3, opponent_prep=False,
    ),
    "pro": Tier(
        id="pro", label="Pro", price_monthly=4.99,
        reviews_per_day=UNLIMITED, puzzles_per_day=UNLIMITED, rush_per_day=UNLIMITED,
        openings_white=12, openings_black=10, opponent_prep=False,
    ),
    "master": Tier(
        id="master", label="Master", price_monthly=9.99,
        reviews_per_day=UNLIMITED, puzzles_per_day=UNLIMITED, rush_per_day=UNLIMITED,
        openings_white=UNLIMITED, openings_black=UNLIMITED, opponent_prep=True,
    ),
}


def tier_for(plan: str) -> Tier:
    """Unknown plans degrade safely to free."""
    return TIERS.get(plan, TIERS["free"])


def is_paid(plan: str) -> bool:
    return plan in ("pro", "master")
