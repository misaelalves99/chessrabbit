"""
Opening names, for the games whose PGN does not carry one.

Lichess sends an `Opening` header - the sync asks for it explicitly. Chess.com
never does: it sends `ECO` plus an `ECOUrl` whose slug *is* the name. Games
imported before we read that URL, and PGNs pasted from anywhere else, arrive
with a code and nothing else, which is why a whole Chess.com library used to
land in Insights as a single "Unknown opening" row.

Two resolutions, in order of how much the game actually told us:

1. `name_from_eco_url` - the exact variation Chess.com named.
2. `eco_family` - the family a code belongs to. Coarser than a real name
   ("Italian Game", not "Italian Game: Giuoco Pianissimo"), and deliberately
   so: a code alone cannot identify a variation, and a made-up variation would
   be worse than an honest family.

Names use the spelling Lichess and Chess.com use ("Defense", "Center Game"),
so a name derived here reads the same as one that arrived in a header and the
two never show up as separate rows for the same opening.
"""

from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

# Longest name we will keep. Both sources are far shorter; this only bounds
# what a hand-edited PGN can put on the page.
MAX_NAME = 200

# ECO code ranges -> the family the code belongs to. Ordered, first match wins.
# Split finer than A/B/C/D/E only where the sub-range is a distinct opening a
# player would recognise as their own (C50 Italian vs C55 Two Knights), because
# every row here is something a player has to see and identify with.
ECO_FAMILIES: tuple[tuple[str, str, str], ...] = (
    # A - flank and irregular openings, Indian defences
    ("A00", "A00", "Irregular Opening"),
    ("A01", "A01", "Nimzo-Larsen Attack"),
    ("A02", "A03", "Bird's Opening"),
    ("A04", "A09", "Reti Opening"),
    ("A10", "A39", "English Opening"),
    ("A40", "A42", "Queen's Pawn Opening"),
    ("A43", "A44", "Old Benoni Defense"),
    ("A45", "A46", "Queen's Pawn Game"),
    ("A47", "A47", "Queen's Indian Defense"),
    ("A48", "A49", "King's Indian Defense"),
    ("A50", "A50", "Queen's Pawn Game"),
    ("A51", "A52", "Budapest Gambit"),
    ("A53", "A55", "Old Indian Defense"),
    ("A56", "A56", "Benoni Defense"),
    ("A57", "A59", "Benko Gambit"),
    ("A60", "A79", "Benoni Defense"),
    ("A80", "A99", "Dutch Defense"),
    # B - semi-open games
    ("B00", "B00", "Uncommon King's Pawn Opening"),
    ("B01", "B01", "Scandinavian Defense"),
    ("B02", "B05", "Alekhine's Defense"),
    ("B06", "B06", "Modern Defense"),
    ("B07", "B09", "Pirc Defense"),
    ("B10", "B19", "Caro-Kann Defense"),
    ("B20", "B99", "Sicilian Defense"),
    # C - French and the open games
    ("C00", "C19", "French Defense"),
    ("C20", "C20", "King's Pawn Game"),
    ("C21", "C22", "Center Game"),
    ("C23", "C24", "Bishop's Opening"),
    ("C25", "C29", "Vienna Game"),
    ("C30", "C39", "King's Gambit"),
    ("C40", "C40", "King's Knight Opening"),
    ("C41", "C41", "Philidor Defense"),
    ("C42", "C43", "Petrov's Defense"),
    ("C44", "C44", "King's Pawn Game"),
    ("C45", "C45", "Scotch Game"),
    ("C46", "C46", "Three Knights Opening"),
    ("C47", "C49", "Four Knights Game"),
    ("C50", "C50", "Italian Game"),
    ("C51", "C52", "Evans Gambit"),
    ("C53", "C54", "Giuoco Piano"),
    ("C55", "C59", "Two Knights Defense"),
    ("C60", "C99", "Ruy Lopez"),
    # D - closed and semi-closed games
    ("D00", "D00", "Queen's Pawn Game"),
    ("D01", "D01", "Richter-Veresov Attack"),
    ("D02", "D05", "Queen's Pawn Game"),
    ("D06", "D09", "Queen's Gambit"),
    ("D10", "D19", "Slav Defense"),
    ("D20", "D29", "Queen's Gambit Accepted"),
    ("D30", "D42", "Queen's Gambit Declined"),
    ("D43", "D49", "Semi-Slav Defense"),
    ("D50", "D69", "Queen's Gambit Declined"),
    ("D70", "D79", "Neo-Grunfeld Defense"),
    ("D80", "D99", "Grunfeld Defense"),
    # E - Indian defences
    ("E00", "E09", "Catalan Opening"),
    ("E10", "E10", "Queen's Pawn Game"),
    ("E11", "E11", "Bogo-Indian Defense"),
    ("E12", "E19", "Queen's Indian Defense"),
    ("E20", "E59", "Nimzo-Indian Defense"),
    ("E60", "E99", "King's Indian Defense"),
)

UNKNOWN = "Unknown opening"

_CODE = re.compile(r"^[A-E][0-9]{2}$")

# A slug tail like "-4.d3-Nf6" or "-3...Nf6" is the line, not the name.
_MOVE_TOKEN = re.compile(r"^\d+\.")

# A URL slug cannot hold an apostrophe, so Chess.com writes "Kings-Indian".
# Put them back, or the same opening reads two ways and lands on two rows.
# Listed word by word rather than by rule: "Two Knights" is not a possessive.
_POSSESSIVE = {
    "Kings": "King's",
    "Queens": "Queen's",
    "Bishops": "Bishop's",
    "Alekhines": "Alekhine's",
    "Birds": "Bird's",
    "Philidors": "Philidor's",
    "Petrovs": "Petrov's",
    "Owens": "Owen's",
    "Grobs": "Grob's",
    "Englunds": "Englund's",
}


def normalize_eco(eco: str | None) -> str | None:
    """An ECO code in canonical form, or None if it is not one."""
    code = (eco or "").strip().upper()
    return code if _CODE.match(code) else None


def name_from_eco_url(url: str | None) -> str | None:
    """
    The opening name inside a Chess.com `ECOUrl`.

    ".../openings/Italian-Game-Giuoco-Pianissimo-4.d3-Nf6" -> "Italian Game
    Giuoco Pianissimo". The moves are dropped: they say which line was played,
    which the name already implies, and they would split one opening across a
    dozen rows.
    """
    if not url:
        return None

    path = urlsplit(url.strip()).path
    parts = [p for p in path.split("/") if p]
    # Only trust the shape we know. Anything else is a PGN making things up.
    if len(parts) < 2 or parts[-2] != "openings":
        return None

    words: list[str] = []
    for token in unquote(parts[-1]).split("-"):
        if _MOVE_TOKEN.match(token):
            break
        if token:
            words.append(_POSSESSIVE.get(token, token))

    return " ".join(words)[:MAX_NAME] or None


def eco_family(eco: str | None) -> str | None:
    """The opening family an ECO code belongs to, or None for a bad code."""
    code = normalize_eco(eco)
    if code is None:
        return None
    for low, high, name in ECO_FAMILIES:
        if low <= code <= high:
            return name
    return None


def opening_label(name: str | None, eco: str | None) -> str:
    """
    What to call a game's opening, given whatever the game recorded.

    The stored name wins; failing that the ECO family; failing both we say so
    rather than inventing one. Used at display time rather than at import, so
    games already in the database get named too.
    """
    stored = (name or "").strip()
    if stored and stored != "?":
        return stored[:MAX_NAME]
    return eco_family(eco) or UNKNOWN
