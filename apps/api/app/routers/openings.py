"""
Curated opening repertoires.

A small catalog of well-known openings, each as a PGN with the opponent's main
alternatives in parentheses. Picking one feeds the very same repertoire pipeline
as a pasted PGN (extract_repertoire -> SM-2 cards), so "train this opening" is
just a one-click way to seed a repertoire without hunting down move lists.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.schemas import OpeningOut

router = APIRouter(tags=["openings"])

# color = the side the trainee plays. Opponent replies live in ( ) so the
# extractor drills every one of them; our own moves stay single (one repertoire).
OPENINGS: list[dict] = [
    {
        "id": "italian",
        "name": "Italian Game",
        "color": "white",
        "eco": "C50",
        "description": "Classical 1.e4 e5 opening. Fast development, aim at f7.",
        "moves": "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 (3... Nf6 4. d3 Bc5 5. c3) "
                 "4. c3 Nf6 5. d3 *",
    },
    {
        "id": "ruy-lopez",
        "name": "Ruy Lopez",
        "color": "white",
        "eco": "C60",
        "description": "The Spanish. Pressure the knight on c6 and the e5 pawn.",
        "moves": "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O) 4. Ba4 Nf6 "
                 "5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *",
    },
    {
        "id": "queens-gambit",
        "name": "Queen's Gambit",
        "color": "white",
        "eco": "D06",
        "description": "1.d4 d5 2.c4 — fight for the centre with a pawn offer.",
        "moves": "1. d4 d5 2. c4 e6 (2... c6 3. Nf3) (2... dxc4 3. e3) "
                 "3. Nc3 Nf6 4. Bg5 *",
    },
    {
        "id": "london",
        "name": "London System",
        "color": "white",
        "eco": "D02",
        "description": "Solid, low-theory setup with Bf4 you can play vs almost anything.",
        "moves": "1. d4 Nf6 (1... d5 2. Bf4) 2. Bf4 d5 3. e3 e6 4. Nf3 c5 5. c3 *",
    },
    {
        "id": "english",
        "name": "English Opening",
        "color": "white",
        "eco": "A20",
        "description": "1.c4 — flank play, flexible pawn structures.",
        "moves": "1. c4 e5 (1... Nf6 2. Nc3) (1... c5 2. Nc3) 2. Nc3 Nf6 "
                 "3. Nf3 Nc6 4. g3 *",
    },
    {
        "id": "sicilian-najdorf",
        "name": "Sicilian Najdorf",
        "color": "black",
        "eco": "B90",
        "description": "The sharpest answer to 1.e4. Counterattack from move one.",
        "moves": "1. e4 c5 2. Nf3 (2. Nc3 Nc6) d6 3. d4 cxd4 4. Nxd4 Nf6 "
                 "5. Nc3 a6 *",
    },
    {
        "id": "french",
        "name": "French Defense",
        "color": "black",
        "eco": "C00",
        "description": "1...e6 — a rock-solid pawn chain and later ...c5 break.",
        "moves": "1. e4 e6 2. d4 d5 3. Nc3 (3. Nd2 Nf6) (3. e5 c5) Bb4 4. e5 c5 *",
    },
    {
        "id": "caro-kann",
        "name": "Caro-Kann Defense",
        "color": "black",
        "eco": "B10",
        "description": "1...c6 — solid structure without shutting in the bishop.",
        "moves": "1. e4 c6 2. d4 d5 3. Nc3 (3. e5 Bf5) dxe4 4. Nxe4 Bf5 *",
    },
    {
        "id": "kings-indian",
        "name": "King's Indian Defense",
        "color": "black",
        "eco": "E60",
        "description": "Let White build the centre, then blow it up with ...e5/...f5.",
        "moves": "1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O *",
    },
    {
        "id": "scandinavian",
        "name": "Scandinavian Defense",
        "color": "black",
        "eco": "B01",
        "description": "1...d5 — trade into an easy, understandable game.",
        "moves": "1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 *",
    },
]


@router.get("/openings", response_model=list[OpeningOut])
async def list_openings():
    """The opening catalog. Static reference data - no auth required."""
    return [OpeningOut(**o) for o in OPENINGS]
