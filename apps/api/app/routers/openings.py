"""
Curated opening repertoires, tiered.

The catalog is ordered by popularity per colour (rank 1 = most played).
Entitlements come from the plan: free = top 3 per colour, pro = top 12
White / top 10 Black, master = everything. The lock state is computed
server-side and enforced again on /openings/{id}/train, so the client can
only ever start a repertoire it is entitled to.

Each entry is a PGN with the opponent's main alternatives in parentheses,
feeding the same extract_repertoire -> SM-2 pipeline as pasted PGN.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.bulk import bulk_insert
from app.core.chess_utils import extract_repertoire
from app.core.db import get_db
from app.core.deps import get_current_user, get_optional_user
from app.core.tiers import UNLIMITED, TIERS, tier_for
from app.models import Repertoire, TrainingCard, User
from app.schemas import OpeningOut, RepertoireOut
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["openings"])

# Ordered by rank within each colour: list position = popularity.
OPENINGS: list[dict] = [
    # ---------------- White (rank = position among white entries) ----------
    {
        "id": "italian", "name": "Italian Game", "color": "white", "eco": "C50",
        "description": "Classical 1.e4 e5 opening. Fast development, aim at f7.",
        "moves": "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 (3... Nf6 4. d3 Bc5 5. c3) "
                 "4. c3 Nf6 5. d3 *",
    },
    {
        "id": "ruy-lopez", "name": "Ruy Lopez", "color": "white", "eco": "C60",
        "description": "The Spanish. Pressure the knight on c6 and the e5 pawn.",
        "moves": "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O) 4. Ba4 Nf6 "
                 "5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *",
    },
    {
        "id": "queens-gambit", "name": "Queen's Gambit", "color": "white", "eco": "D06",
        "description": "1.d4 d5 2.c4 — fight for the centre with a pawn offer.",
        "moves": "1. d4 d5 2. c4 e6 (2... c6 3. Nf3) (2... dxc4 3. e3) "
                 "3. Nc3 Nf6 4. Bg5 *",
    },
    {
        "id": "london", "name": "London System", "color": "white", "eco": "D02",
        "description": "Solid, low-theory setup with Bf4 you can play vs almost anything.",
        "moves": "1. d4 Nf6 (1... d5 2. Bf4) 2. Bf4 d5 3. e3 e6 4. Nf3 c5 5. c3 *",
    },
    {
        "id": "english", "name": "English Opening", "color": "white", "eco": "A20",
        "description": "1.c4 — flank play, flexible pawn structures.",
        "moves": "1. c4 e5 (1... Nf6 2. Nc3) (1... c5 2. Nc3) 2. Nc3 Nf6 "
                 "3. Nf3 Nc6 4. g3 *",
    },
    {
        "id": "scotch", "name": "Scotch Game", "color": "white", "eco": "C45",
        "description": "Open the centre on move three and develop with tempo.",
        "moves": "1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6 (4... Bc5 5. Be3) "
                 "5. Nc3 *",
    },
    {
        "id": "vienna", "name": "Vienna Game", "color": "white", "eco": "C25",
        "description": "2.Nc3 keeps f4 in reserve — gambit spirit, sound footing.",
        "moves": "1. e4 e5 2. Nc3 Nf6 (2... Nc6 3. Bc4) 3. f4 d5 4. fxe5 Nxe4 *",
    },
    {
        "id": "four-knights", "name": "Four Knights Game", "color": "white", "eco": "C47",
        "description": "Symmetrical development, easy plans, hard to go wrong.",
        "moves": "1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4 5. O-O O-O 6. d3 *",
    },
    {
        "id": "catalan", "name": "Catalan Opening", "color": "white", "eco": "E00",
        "description": "d4+c4 with a g2 bishop — long-term squeeze, elite favourite.",
        "moves": "1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 Be7 5. Nf3 O-O 6. O-O *",
    },
    {
        "id": "reti", "name": "Réti Opening", "color": "white", "eco": "A11",
        "description": "1.Nf3 and c4 — control the centre from the flanks.",
        "moves": "1. Nf3 d5 2. c4 e6 (2... c6 3. b3) (2... dxc4 3. e3) "
                 "3. g3 Nf6 4. Bg2 *",
    },
    {
        "id": "kings-gambit", "name": "King's Gambit", "color": "white", "eco": "C30",
        "description": "1.e4 e5 2.f4 — the romantic attack, alive and dangerous.",
        "moves": "1. e4 e5 2. f4 exf4 (2... d5 3. exd5) 3. Nf3 g5 4. h4 *",
    },
    {
        "id": "colle", "name": "Colle System", "color": "white", "eco": "D05",
        "description": "Quiet d4-e3 setup, then the thematic e4 break.",
        "moves": "1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3 c5 5. c3 *",
    },
    {
        "id": "trompowsky", "name": "Trompowsky Attack", "color": "white", "eco": "A45",
        "description": "2.Bg5 — sidestep theory and pose problems from move two.",
        "moves": "1. d4 Nf6 2. Bg5 e6 (2... d5 3. Bxf6 exf6 4. e3) 3. e4 h6 "
                 "4. Bxf6 Qxf6 *",
    },
    {
        "id": "stonewall-attack", "name": "Stonewall Attack", "color": "white", "eco": "D00",
        "description": "Pawns on d4-e3-f4: a kingside battering ram.",
        "moves": "1. d4 d5 2. e3 Nf6 3. Bd3 c5 4. c3 Nc6 5. f4 *",
    },
    # ---------------- Black (rank = position among black entries) ----------
    {
        "id": "sicilian-najdorf", "name": "Sicilian Najdorf", "color": "black", "eco": "B90",
        "description": "The sharpest answer to 1.e4. Counterattack from move one.",
        "moves": "1. e4 c5 2. Nf3 (2. Nc3 Nc6) d6 3. d4 cxd4 4. Nxd4 Nf6 "
                 "5. Nc3 a6 *",
    },
    {
        "id": "french", "name": "French Defense", "color": "black", "eco": "C00",
        "description": "1...e6 — a rock-solid pawn chain and later ...c5 break.",
        "moves": "1. e4 e6 2. d4 d5 3. Nc3 (3. Nd2 Nf6) (3. e5 c5) Bb4 4. e5 c5 *",
    },
    {
        "id": "caro-kann", "name": "Caro-Kann Defense", "color": "black", "eco": "B10",
        "description": "1...c6 — solid structure without shutting in the bishop.",
        "moves": "1. e4 c6 2. d4 d5 3. Nc3 (3. e5 Bf5) dxe4 4. Nxe4 Bf5 *",
    },
    {
        "id": "kings-indian", "name": "King's Indian Defense", "color": "black", "eco": "E60",
        "description": "Let White build the centre, then blow it up with ...e5/...f5.",
        "moves": "1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O *",
    },
    {
        "id": "scandinavian", "name": "Scandinavian Defense", "color": "black", "eco": "B01",
        "description": "1...d5 — trade into an easy, understandable game.",
        "moves": "1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 *",
    },
    {
        "id": "qgd", "name": "Queen's Gambit Declined", "color": "black", "eco": "D30",
        "description": "Decline the pawn, hold the centre — timeless and sound.",
        "moves": "1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O *",
    },
    {
        "id": "petroff", "name": "Petroff Defense", "color": "black", "eco": "C42",
        "description": "Answer 2.Nf3 with 2...Nf6 — famously hard to beat.",
        "moves": "1. e4 e5 2. Nf3 Nf6 3. Nxe5 (3. Nc3 Nc6) d6 4. Nf3 Nxe4 *",
    },
    {
        "id": "slav", "name": "Slav Defense", "color": "black", "eco": "D10",
        "description": "Defend d5 with ...c6 and keep the light bishop free.",
        "moves": "1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4 *",
    },
    {
        "id": "nimzo-indian", "name": "Nimzo-Indian Defense", "color": "black", "eco": "E20",
        "description": "...Bb4 pins the knight and fights for e4 without pawns.",
        "moves": "1. d4 Nf6 2. c4 e6 3. Nc3 (3. Nf3 b6) Bb4 4. e3 O-O *",
    },
    {
        "id": "grunfeld", "name": "Grünfeld Defense", "color": "black", "eco": "D80",
        "description": "Give White the big centre, then hammer it with pieces.",
        "moves": "1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5 5. e4 Nxc3 "
                 "6. bxc3 Bg7 *",
    },
    {
        "id": "dutch", "name": "Dutch Defense", "color": "black", "eco": "A80",
        "description": "1...f5 — seize e4 and attack on the kingside.",
        "moves": "1. d4 f5 2. g3 Nf6 3. Bg2 e6 4. Nf3 Be7 *",
    },
    {
        "id": "pirc", "name": "Pirc Defense", "color": "black", "eco": "B07",
        "description": "Flexible ...d6/...g6 — invite the centre, then strike it.",
        "moves": "1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7 *",
    },
]


def _ranked() -> list[dict]:
    """Attach per-colour rank and the minimum tier that unlocks each entry."""
    out = []
    counters = {"white": 0, "black": 0}
    for o in OPENINGS:
        counters[o["color"]] += 1
        rank = counters[o["color"]]
        min_tier = "master"
        for tid in ("free", "pro"):
            t = TIERS[tid]
            allowed = t.openings_white if o["color"] == "white" else t.openings_black
            if allowed == UNLIMITED or rank <= allowed:
                min_tier = tid
                break
        out.append({**o, "rank": rank, "tier": min_tier})
    return out


_RANKED = _ranked()
_TIER_ORDER = {"free": 0, "pro": 1, "master": 2}


def _unlocked(entry: dict, plan: str) -> bool:
    return _TIER_ORDER[entry["tier"]] <= _TIER_ORDER.get(plan, 0)


@router.get("/openings", response_model=list[OpeningOut])
async def list_openings(user: User | None = Depends(get_optional_user)):
    """The catalog with lock state for the caller (logged-out = free)."""
    plan = user.plan if user else "free"
    return [
        OpeningOut(**{k: o[k] for k in
                      ("id", "name", "color", "eco", "description", "moves", "rank", "tier")},
                   locked=not _unlocked(o, plan))
        for o in _RANKED
    ]


@router.post("/openings/{opening_id}/train", response_model=RepertoireOut,
             status_code=status.HTTP_201_CREATED)
async def train_opening(
    opening_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a repertoire from a catalog opening, enforcing the tier lock."""
    entry = next((o for o in _RANKED if o["id"] == opening_id), None)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Opening not found"},
        )
    if not _unlocked(entry, user.plan):
        tier = tier_for(user.plan)
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "upgrade_required",
                "message": f"{entry['name']} is a {entry['tier'].capitalize()} opening. "
                           f"Your {tier.label} plan unlocks the top "
                           f"{tier.openings_white if entry['color'] == 'white' else tier.openings_black} "
                           f"{entry['color']} openings.",
            },
        )

    cards = extract_repertoire(entry["moves"], entry["color"])
    rep = Repertoire(user_id=user.id, name=entry["name"], color=entry["color"])
    db.add(rep)
    await db.flush()
    await bulk_insert(
        db,
        TrainingCard,
        [
            {
                "repertoire_id": rep.id, "user_id": user.id,
                "zobrist": c["zobrist"], "fen": c["fen"],
                "expected_uci": c["expected_uci"], "expected_san": c["expected_san"],
            }
            for c in cards
        ],
        ignore_conflicts=True,
    )
    await db.commit()
    return RepertoireOut(
        id=rep.id, name=rep.name, color=rep.color,
        card_count=len(cards), due_count=len(cards),
    )
