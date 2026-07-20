# ChessRabbit Sprint 2: Auto-Import + Weekly Insights
## Execution Plan for Developers

**Estimated time:** 3-4 days (one developer)  
**Target:** Complete by end of week, ship with personal tree + blunder puzzles  
**Value:** Auto-onboarding + retention loop (weekly engagement signal)

---

## Feature Overview

### 3.3 Lichess/Chess.com Auto-Import

**What it does:**
- User signs up → selects Chess.com or Lichess username
- Games sync nightly (background job)
- New games appear in `/app` workspace automatically
- No manual PGN upload needed

**Why it matters:**
- Highest onboarding friction removed
- "Sign up in 30 seconds, start training" flow
- User database grows passively
- Analytics: engagement from day 1

**Technical approach:**
- Both platforms expose public game APIs (no OAuth, no credentials stored)
- Cron job: hourly check for new games (starts nightly, runs every hour)
- De-dupe on (source, source_game_id): won't re-import the same game
- Store import state in DB: last sync timestamp per account

### 3.4 Weekly Insights Email

**What it does:**
- Every Sunday midnight, send email with stats
- Sections: Accuracy trend (last 7d), Blunder rate by phase, Best/worst openings
- Pro: deep stats; Free: summary stats
- One click unsubscribe

**Why it matters:**
- Retention loop: weekly reminder to use the app
- Shows progress (accuracy going up = engagement signal)
- Opens door to premium insights ("Your openings need work")
- Post-email click-through is growth lever

**Technical approach:**
- Cron job: `0 0 * * 0` (every Sunday midnight UTC)
- Aggregate queries on `annotations` + `games` (all computed server-side)
- Use existing mailer service (works whether EMAIL_API_KEY is set or not)
- Store opt-out in `users.email_unsubscribed` (boolean)

---

## Detailed Execution (Task by Task)

### PHASE 1: Database & Schemas (1 hour)

#### 1.1 Migration: External Account Linking

File: `db/migrations/005_external_accounts.sql`

```sql
-- Store linked Chess.com and Lichess accounts for auto-import
CREATE TABLE IF NOT EXISTS linked_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE (source, user_id),  -- one Lichess, one Chess.com per user
  source TEXT NOT NULL,  -- 'lichess' or 'chess.com'
  username TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ,  -- last time we checked for new games
  sync_count INT DEFAULT 0,  -- number of syncs completed
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, source)
);

CREATE INDEX linked_accounts_user_id_idx ON linked_accounts(user_id);
CREATE INDEX linked_accounts_source_idx ON linked_accounts(source);
```

#### 1.2 Migration: User Preferences

File: `db/migrations/006_user_preferences.sql`

```sql
-- User email preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_unsubscribed BOOLEAN DEFAULT FALSE;

-- Track imported games by source (prevent re-import)
CREATE TABLE IF NOT EXISTS imported_games (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  source TEXT NOT NULL,  -- 'lichess' or 'chess.com'
  source_game_id TEXT NOT NULL,  -- unique ID from the external API
  game_id BIGINT NOT NULL,  -- our game ID after import
  imported_at TIMESTAMPTZ DEFAULT now(),
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  UNIQUE(user_id, source, source_game_id)
);

CREATE INDEX imported_games_user_idx ON imported_games(user_id, source);
```

#### 1.3 Update ORM Models

File: `apps/api/app/models/models.py`

Add classes:
```python
class LinkedAccount(Base):
    __tablename__ = "linked_accounts"
    
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(Text, nullable=False)  # 'lichess' or 'chess.com'
    username: Mapped[str] = mapped_column(Text, nullable=False)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sync_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    
    __table_args__ = (UniqueConstraint("user_id", "source"),)

class ImportedGame(Base):
    __tablename__ = "imported_games"
    
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(Text, nullable=False)
    source_game_id: Mapped[str] = mapped_column(Text, nullable=False)
    game_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("games.id", ondelete="CASCADE"))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    
    __table_args__ = (UniqueConstraint("user_id", "source", "source_game_id"),)
```

#### 1.4 Schemas for API

File: `apps/api/app/schemas/schemas.py`

```python
class LinkAccountIn(BaseModel):
    source: str = Field(pattern="^(lichess|chess\\.com)$")
    username: str = Field(min_length=1, max_length=200)

class LinkedAccountOut(BaseModel):
    id: int
    source: str
    username: str
    last_sync_at: datetime | None
    sync_count: int

class UnlinkAccountIn(BaseModel):
    source: str = Field(pattern="^(lichess|chess\\.com)$")
```

---

### PHASE 2: External API Integration (1 day)

#### 2.1 Create Lichess API Client

File: `apps/api/app/services/lichess_client.py`

```python
"""Lichess API client for game export."""
import httpx
from datetime import datetime

class LichessClient:
    BASE_URL = "https://lichess.org/api"
    TIMEOUT = 30
    
    @staticmethod
    async def user_exists(username: str) -> bool:
        """Check if a Lichess user exists."""
        async with httpx.AsyncClient(timeout=LichessClient.TIMEOUT) as client:
            try:
                resp = await client.get(
                    f"{LichessClient.BASE_URL}/user/{username}",
                    headers={"Accept": "application/json"},
                )
                return resp.status_code == 200
            except:
                return False
    
    @staticmethod
    async def get_games_since(username: str, since_timestamp: int | None = None) -> list[dict]:
        """
        Fetch PGN games for a user since a given timestamp.
        Returns list of dicts: {uci, game_id, white, black, result, timestamp}
        """
        params = {
            "max": "50",  # per-request limit
            "sort": "dateDesc",
        }
        if since_timestamp:
            params["until"] = str(since_timestamp + 1)
        
        games = []
        async with httpx.AsyncClient(timeout=LichessClient.TIMEOUT) as client:
            try:
                resp = await client.get(
                    f"{LichessClient.BASE_URL}/games/user/{username}",
                    params=params,
                    headers={"Accept": "application/x-chess-pgn"},
                )
                if resp.status_code != 200:
                    return []
                
                # Parse PGN response (will be multiple games concatenated)
                for game in parse_pgn(resp.text):
                    games.append({
                        "game_id": game.get("site_id", ""),
                        "white": game.get("white", ""),
                        "black": game.get("black", ""),
                        "result": game.get("result", "*"),
                        "timestamp": game.get("utc_date_iso", None),
                        "movetext": game.get("movetext", ""),
                        "white_elo": int(game.get("white_elo", 0)) or None,
                        "black_elo": int(game.get("black_elo", 0)) or None,
                    })
            except Exception as e:
                logging.error(f"Lichess fetch failed: {e}")
        
        return games
```

#### 2.2 Create Chess.com API Client

File: `apps/api/app/services/chesscom_client.py`

```python
"""Chess.com API client for game export."""
import httpx
import calendar
from datetime import datetime

class ChessComClient:
    BASE_URL = "https://api.chess.com/pub"
    TIMEOUT = 30
    
    @staticmethod
    async def user_exists(username: str) -> bool:
        """Check if a Chess.com user exists."""
        async with httpx.AsyncClient(timeout=ChessComClient.TIMEOUT) as client:
            try:
                resp = await client.get(
                    f"{ChessComClient.BASE_URL}/player/{username}",
                    headers={"User-Agent": "ChessRabbit"},
                )
                return resp.status_code == 200
            except:
                return False
    
    @staticmethod
    async def get_games_since(username: str, since_timestamp: int | None = None) -> list[dict]:
        """
        Fetch games for a user since a given timestamp.
        Chess.com API requires looping through year/month archives.
        """
        games = []
        async with httpx.AsyncClient(timeout=ChessComClient.TIMEOUT) as client:
            try:
                # Get list of available archives
                resp = await client.get(
                    f"{ChessComClient.BASE_URL}/player/{username}/games/archives",
                    headers={"User-Agent": "ChessRabbit"},
                )
                if resp.status_code != 200:
                    return []
                
                archives = resp.json().get("archives", [])
                
                # Iterate archives (most recent first)
                for archive_url in sorted(archives, reverse=True):
                    # Get games from this month
                    resp = await client.get(
                        archive_url,
                        headers={"User-Agent": "ChessRabbit"},
                    )
                    if resp.status_code != 200:
                        continue
                    
                    month_games = resp.json().get("games", [])
                    for game in month_games:
                        # Filter by timestamp if provided
                        ts = game.get("end_time", 0)
                        if since_timestamp and ts <= since_timestamp:
                            continue
                        
                        # Extract players
                        white = game.get("white", {})
                        black = game.get("black", {})
                        
                        # Result from our perspective (player's side)
                        result = game.get("pgn", "").split(" ")[-1] if game.get("pgn") else "*"
                        
                        games.append({
                            "game_id": game.get("url", "").split("/")[-1],
                            "white": white.get("username", ""),
                            "black": black.get("username", ""),
                            "result": result,
                            "timestamp": ts,
                            "movetext": game.get("pgn", ""),
                            "white_elo": white.get("rating", None),
                            "black_elo": black.get("rating", None),
                        })
                    
                    # Stop if we're past the sync timestamp
                    if since_timestamp and games:
                        break
            except Exception as e:
                logging.error(f"Chess.com fetch failed: {e}")
        
        return games
```

---

### PHASE 3: Backend Routes (1 day)

#### 3.1 Linking Routes

File: `apps/api/app/routers/integrations.py` (new file)

```python
"""Lichess and Chess.com account linking for auto-import."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models import LinkedAccount, User
from app.schemas import LinkAccountIn, UnlinkAccountIn, LinkedAccountOut
from app.services.lichess_client import LichessClient
from app.services.chesscom_client import ChessComClient

router = APIRouter(prefix="/integrations", tags=["integrations"])

@router.post("/link", response_model=LinkedAccountOut, status_code=status.HTTP_201_CREATED)
async def link_account(
    payload: LinkAccountIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Link a Lichess or Chess.com account for auto-import."""
    # Validate the username exists on the platform
    if payload.source == "lichess":
        exists = await LichessClient.user_exists(payload.username)
    else:
        exists = await ChessComClient.user_exists(payload.username)
    
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "user_not_found", "message": f"No {payload.source} user '{payload.username}'"},
        )
    
    # Check if already linked
    existing = await db.execute(
        select(LinkedAccount).where(
            LinkedAccount.user_id == user.id,
            LinkedAccount.source == payload.source,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "already_linked", "message": f"Already linked to a {payload.source} account"},
        )
    
    # Create link
    acc = LinkedAccount(
        user_id=user.id,
        source=payload.source,
        username=payload.username,
    )
    db.add(acc)
    await db.commit()
    await db.refresh(acc)
    
    return LinkedAccountOut(
        id=acc.id, source=acc.source, username=acc.username,
        last_sync_at=acc.last_sync_at, sync_count=acc.sync_count,
    )

@router.get("/linked", response_model=list[LinkedAccountOut])
async def get_linked_accounts(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all linked accounts for the current user."""
    accs = await db.execute(
        select(LinkedAccount).where(LinkedAccount.user_id == user.id)
    )
    return [
        LinkedAccountOut(
            id=a.id, source=a.source, username=a.username,
            last_sync_at=a.last_sync_at, sync_count=a.sync_count,
        )
        for a in accs.scalars().all()
    ]

@router.post("/unlink", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_account(
    payload: UnlinkAccountIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Unlink a Lichess or Chess.com account."""
    acc = await db.execute(
        select(LinkedAccount).where(
            LinkedAccount.user_id == user.id,
            LinkedAccount.source == payload.source,
        )
    )
    linked = acc.scalar_one_or_none()
    if not linked:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    
    await db.delete(linked)
    await db.commit()
```

#### 3.2 Sync Endpoint (Manual + Scheduled)

File: `apps/api/app/routers/integrations.py` (extend above)

```python
@router.post("/sync", status_code=status.HTTP_204_NO_CONTENT)
async def sync_linked_games(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Manually trigger sync of all linked accounts.
    Also called by background job nightly.
    """
    accs = await db.execute(
        select(LinkedAccount).where(LinkedAccount.user_id == user.id)
    )
    
    for acc in accs.scalars().all():
        await _sync_one_account(db, user.id, acc)

async def _sync_one_account(db: AsyncSession, user_id: int, acc: LinkedAccount):
    """Sync one linked account (factored for reuse in cron job)."""
    if acc.source == "lichess":
        games = await LichessClient.get_games_since(
            acc.username, 
            int(acc.last_sync_at.timestamp()) if acc.last_sync_at else None,
        )
    else:
        games = await ChessComClient.get_games_since(
            acc.username,
            int(acc.last_sync_at.timestamp()) if acc.last_sync_at else None,
        )
    
    # Import each game, de-dupe on (source, source_game_id)
    from app.core.chess_utils import parse_pgn
    
    imported = 0
    for game_data in games:
        # Check if already imported
        dup = await db.execute(
            select(ImportedGame).where(
                ImportedGame.user_id == user_id,
                ImportedGame.source == acc.source,
                ImportedGame.source_game_id == game_data["game_id"],
            )
        )
        if dup.scalar_one_or_none():
            continue
        
        # Parse the PGN and import
        try:
            parsed = parse_pgn(game_data["movetext"])
            if not parsed:
                continue
            
            pgn_game = parsed[0]
            
            # Determine game owner
            our_username = acc.username
            owner_is_white = pgn_game.get("white", "").lower() == our_username.lower()
            owner_is_black = pgn_game.get("black", "").lower() == our_username.lower()
            
            if not (owner_is_white or owner_is_black):
                continue
            
            # Create game record
            from app.models import Game
            game = Game(
                owner_id=user_id,
                white=pgn_game.get("white", "Unknown"),
                black=pgn_game.get("black", "Unknown"),
                result=pgn_game.get("result", "*"),
                white_elo=pgn_game.get("white_elo", None),
                black_elo=pgn_game.get("black_elo", None),
                ply_count=len(pgn_game.get("moves", [])),
                movetext=game_data["movetext"],
                event=pgn_game.get("event", ""),
            )
            db.add(game)
            await db.flush()
            
            # Record import
            imp = ImportedGame(
                user_id=user_id,
                source=acc.source,
                source_game_id=game_data["game_id"],
                game_id=game.id,
            )
            db.add(imp)
            imported += 1
        except Exception as e:
            logging.error(f"Failed to import game {game_data['game_id']}: {e}")
    
    # Update sync timestamp
    acc.last_sync_at = datetime.now(timezone.utc)
    acc.sync_count += 1
    
    await db.commit()
    logging.info(f"Synced {imported} games for user {user_id} from {acc.source}")
```

#### 3.3 Wire Routes to App

File: `apps/api/app/main.py`

```python
from app.routers import integrations

app.include_router(integrations.router)
```

---

### PHASE 4: Insights Email (1 day)

#### 4.1 Insights Engine

File: `apps/api/app/services/insights.py`

```python
"""Generate weekly insights email from user game data."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import text, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Annotation, Game, User

async def generate_insights_for_user(db: AsyncSession, user: User) -> dict:
    """
    Compute stats for the last 7 days of games.
    Returns dict with sections for email template.
    """
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    
    # Get all games in the past week
    rows = await db.execute(
        select(Game).where(
            Game.owner_id == user.id,
            Game.created_at >= week_ago,
        )
    )
    games = rows.scalars().all()
    
    if not games:
        return {"has_data": False}
    
    # Accuracy: average of all annotations' implicit score
    accuracy_rows = await db.execute(
        text("""
            SELECT avg(
              CASE WHEN eval_cp IS NULL THEN 50
                   WHEN abs(eval_cp) > 300 THEN 20
                   WHEN abs(eval_cp) > 150 THEN 40
                   WHEN abs(eval_cp) > 50 THEN 70
                   ELSE 90
              END
            ) as avg_accuracy
            FROM annotations
            WHERE game_id IN (
              SELECT id FROM games WHERE owner_id = :uid AND created_at >= :week
            )
        """),
        {"uid": user.id, "week": week_ago},
    )
    accuracy = accuracy_rows.scalar() or 50
    
    # Blunder rate by phase
    phases = await db.execute(
        text("""
            SELECT
              CASE WHEN ply <= 10 THEN 'Opening'
                   WHEN ply <= 30 THEN 'Midgame'
                   ELSE 'Endgame'
              END as phase,
              count(*) filter (where nag in (2,4)) as blunders,
              count(*) as total
            FROM annotations
            WHERE game_id IN (
              SELECT id FROM games WHERE owner_id = :uid AND created_at >= :week
            )
            GROUP BY 1
        """),
        {"uid": user.id, "week": week_ago},
    )
    
    phase_stats = {}
    for phase, blunders, total in phases:
        if total > 0:
            phase_stats[phase] = {"blunders": blunders, "rate": round(100 * blunders / total)}
    
    # Best/worst openings (by ECO)
    eco_rows = await db.execute(
        text("""
            SELECT eco, count(*) as games, 
                   sum(case when result = '1-0' then 1 else 0 end) as wins,
                   sum(case when result = '1/2-1/2' then 1 else 0 end) as draws
            FROM games
            WHERE owner_id = :uid AND created_at >= :week
            GROUP BY eco
            ORDER BY games DESC
            LIMIT 5
        """),
        {"uid": user.id, "week": week_ago},
    )
    
    best_opening = None
    worst_opening = None
    eco_list = []
    
    for eco, games, wins, draws in eco_rows:
        if eco:
            losses = games - wins - draws
            score_pct = (wins + draws * 0.5) / games * 100 if games else 0
            eco_list.append({
                "eco": eco,
                "games": games,
                "score_pct": round(score_pct, 1),
                "record": f"{wins}-{draws}-{losses}",
            })
    
    if eco_list:
        best_opening = max(eco_list, key=lambda x: x["score_pct"])
        worst_opening = min(eco_list, key=lambda x: x["score_pct"])
    
    return {
        "has_data": True,
        "week_start": week_ago.strftime("%b %d"),
        "accuracy": round(accuracy),
        "phase_stats": phase_stats,
        "best_opening": best_opening,
        "worst_opening": worst_opening,
        "games_count": len(games),
    }
```

#### 4.2 Email Template

File: `apps/api/app/services/mailer.py` (extend existing)

```python
async def send_weekly_insights_email(user: User, insights: dict) -> bool:
    """Send weekly insights digest."""
    if not insights.get("has_data"):
        subject = "Your ChessRabbit Weekly Digest"
        body = f"""Hi {user.display_name},

No games analyzed yet this week. Import some games and let ChessRabbit find your weak spots!

Cheers,
ChessRabbit
"""
    else:
        best = insights.get("best_opening", {})
        worst = insights.get("worst_opening", {})
        phases = insights.get("phase_stats", {})
        
        body = f"""Hi {user.display_name},

Here's your ChessRabbit digest for the week of {insights.get('week_start')}:

📊 ACCURACY
Your average accuracy: {insights['accuracy']}%

🎯 BLUNDERS BY PHASE
"""
        for phase, stats in sorted(phases.items()):
            body += f"  {phase}: {stats['blunders']} blunders ({stats['rate']}%)\n"
        
        body += f"""
🏆 BEST OPENING
  {best.get('eco')}: {best.get('score_pct')}% score ({best.get('record')})

⚠️  WORST OPENING
  {worst.get('eco')}: {worst.get('score_pct')}% score ({worst.get('record')})

📈 {insights['games_count']} games analyzed

Ready to improve? Open ChessRabbit and sync your blunder puzzles!

Cheers,
ChessRabbit
"""
    
    return await send_email(
        recipient=user.email,
        subject=subject,
        body=body,
    )
```

#### 4.3 Cron Job

File: `pipeline/send_weekly_insights.py` (new file)

```python
#!/usr/bin/env python3
"""
Send weekly insights emails every Sunday at midnight UTC.
Run this from cron: 0 0 * * 0 cd /path && python3 pipeline/send_weekly_insights.py
"""
import os
import asyncio
from datetime import datetime, timezone

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from app.models import User
from app.services.insights import generate_insights_for_user
from app.services.mailer import send_weekly_insights_email
from app.core.config import settings

async def main():
    engine = create_engine(settings.DATABASE_URL.replace("+asyncpg", ""))
    Session = sessionmaker(bind=engine)
    session = Session()
    
    # Get all users not unsubscribed
    users = session.execute(
        select(User).where(User.email_unsubscribed == False, User.deleted_at.is_(None))
    ).scalars().all()
    
    sent = 0
    for user in users:
        try:
            # Generate insights
            insights = await generate_insights_for_user(session, user)
            
            # Send email
            ok = await send_weekly_insights_email(user, insights)
            if ok:
                sent += 1
                print(f"Sent insights to {user.email}")
        except Exception as e:
            print(f"Failed to send insights to {user.email}: {e}")
    
    session.close()
    print(f"Weekly insights sent to {sent} users")

if __name__ == "__main__":
    asyncio.run(main())
```

---

### PHASE 5: Frontend (1 day)

#### 5.1 Linking UI

File: `apps/web/src/components/LinkedAccounts.tsx` (new)

```typescript
import { useState } from "react";
import { api } from "@/lib/api";

export function LinkedAccounts() {
  const [linked, setLinked] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newSource, setNewSource] = useState<"lichess" | "chess.com">("lichess");
  const [newUsername, setNewUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function link() {
    try {
      await api.linkAccount({
        source: newSource,
        username: newUsername,
      });
      setNewUsername("");
      refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Failed to link account"
      );
    }
  }

  async function unlink(source: string) {
    try {
      await api.unlinkAccount({ source });
      refresh();
    } catch (e) {
      setError("Failed to unlink");
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const accs = await api.getLinkedAccounts();
      setLinked(accs);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>Connected Accounts</h2>
      <p className="text-sm text-muted mb-4">
        Link your Chess.com or Lichess account to auto-import games
      </p>

      {error && <div className="text-red-500 mb-2">{error}</div>}

      <div className="gap-2 mb-4">
        <select
          value={newSource}
          onChange={(e) => setNewSource(e.target.value as "lichess" | "chess.com")}
          className="input"
        >
          <option value="lichess">Lichess</option>
          <option value="chess.com">Chess.com</option>
        </select>
        <input
          type="text"
          placeholder="Username"
          value={newUsername}
          onChange={(e) => setNewUsername(e.target.value)}
          className="input"
        />
        <button onClick={link} className="btn" disabled={loading}>
          Link
        </button>
      </div>

      <div className="space-y-2">
        {linked.map((acc) => (
          <div key={acc.id} className="border rounded p-3 flex justify-between">
            <div>
              <div className="font-semibold">{acc.source}</div>
              <div className="text-sm text-muted">{acc.username}</div>
              <div className="text-xs text-muted">
                {acc.last_sync_at ? `Last synced: ${new Date(acc.last_sync_at).toLocaleDateString()}` : "Never synced"}
              </div>
            </div>
            <button
              onClick={() => unlink(acc.source)}
              className="btn btn-sm bg-red-500"
            >
              Unlink
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### 5.2 Add to Settings Page

File: `apps/web/src/app/settings/page.tsx` (new route or extend /app)

Include the `<LinkedAccounts />` component with manual sync button.

#### 5.3 Update API Client

File: `apps/web/src/lib/api.ts`

```typescript
linkAccount: (data: { source: string; username: string }) =>
  request("/integrations/link", { method: "POST", body: JSON.stringify(data) }),

getLinkedAccounts: () => request("/integrations/linked", { method: "GET" }),

unlinkAccount: (data: { source: string }) =>
  request("/integrations/unlink", { method: "POST", body: JSON.stringify(data) }),

syncLinkedGames: () =>
  request("/integrations/sync", { method: "POST" }),
```

---

## Testing Checklist

### Unit Tests
- [ ] `LichessClient.user_exists()` returns true/false correctly
- [ ] `ChessComClient.user_exists()` returns true/false correctly
- [ ] `_sync_one_account()` dedupes on (source, source_game_id)
- [ ] Insights queries handle empty data gracefully

### Integration Tests
- [ ] Register → link Lichess → sync → games appear in `/app`
- [ ] Link same source twice → 409 error
- [ ] Unlink → link different user → no cross-contamination
- [ ] Insights email generated correctly
- [ ] Email subject/body renders without errors

### Manual Testing
- [ ] Sign up, link Lichess username (use your own account)
- [ ] Wait for manual sync (or call `/integrations/sync`)
- [ ] Check `/games` list shows new games
- [ ] Check `/train` can build repertoires from imported games
- [ ] Unlink, verify games remain (soft link only)
- [ ] Trigger weekly insights email via `send_weekly_insights.py`

---

## Deployment Steps

1. **Create migrations in order:**
   ```bash
   PGPASSWORD=devpassword psql -h localhost -U chessrabbit -d chessrabbit -f db/migrations/005_external_accounts.sql
   PGPASSWORD=devpassword psql -h localhost -U chessrabbit -d chessrabbit -f db/migrations/006_user_preferences.sql
   ```

2. **Update ORM models** and verify imports:
   ```bash
   python3 -c "from app.models import LinkedAccount, ImportedGame; print('OK')"
   ```

3. **Add env vars (optional, defaults fine):**
   ```bash
   # .env already has everything needed; no new secrets
   ```

4. **Set up cron job** on production server:
   ```bash
   # /etc/cron.d/chessrabbit
   0 0 * * 0 cd /app && python3 pipeline/send_weekly_insights.py >> /var/log/chessrabbit_insights.log 2>&1
   ```

5. **Add hourly game sync** (optional, for continuous import):
   ```bash
   # /etc/cron.d/chessrabbit
   0 * * * * cd /app && python3 -c "from app.services.integrations import sync_all_users; import asyncio; asyncio.run(sync_all_users())" >> /var/log/chessrabbit_sync.log 2>&1
   ```

---

## Estimated Effort Breakdown

| Task | Time | Notes |
|------|------|-------|
| DB migrations + ORM | 1h | Straightforward schema additions |
| Lichess client | 1.5h | API is well-documented |
| Chess.com client | 1.5h | Archives pattern a bit complex |
| Sync endpoint + logic | 2h | De-dupe logic, error handling |
| Insights engine | 1.5h | SQL aggregations, template |
| Frontend linking UI | 2h | Form + list + button states |
| Testing | 2h | Manual E2E most important |
| **Total** | **11.5h** | ~1.5 days full-time |

---

## Success Criteria

- [ ] User can link Lichess/Chess.com account in UI
- [ ] Linked games appear in `/app` within 1 hour (or on manual sync)
- [ ] Weekly email sends Sunday midnight with stats
- [ ] Games never re-imported (dedup works)
- [ ] No external API errors crash the app (all wrapped in try/catch)
- [ ] Unsubscribe link in email works

---

## Notes for Developer

- **External API resilience:** Both Lichess and Chess.com can be slow. All calls are wrapped in timeouts + try/catch. If sync fails, it retries next cron run.
- **Timestamp handling:** Lichess uses Unix timestamps; Chess.com uses ISO strings. Both handled in respective clients.
- **De-duplication:** Critical. Check `imported_games` table before creating each game record.
- **PGN normalization:** The existing `parse_pgn()` handles most PGN quirks. Test with real export files first.
- **Email delivery:** The mailer service already handles both console (dev) and HTTP (prod) backends. Unsub works automatically if EMAIL_API_KEY is set; otherwise unsubscribe button logs a message.

