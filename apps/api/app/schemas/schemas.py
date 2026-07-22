"""Pydantic request/response schemas."""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, EmailStr, Field


# ---------- auth ----------

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    display_name: str = Field(default="", max_length=100)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class ForgotRequest(BaseModel):
    email: EmailStr


class ResetRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=200)


# ---------- user ----------

class UserOut(BaseModel):
    id: int
    email: str
    display_name: str
    plan: str
    email_verified: bool
    created_at: datetime
    puzzle_rating: int = 1200

    class Config:
        from_attributes = True


class MeOut(UserOut):
    analyses_today: int
    daily_limit: int | None
    max_depth: int
    max_multipv: int


# ---------- games ----------

class GameOut(BaseModel):
    id: int
    white: str
    black: str
    white_elo: int | None
    black_elo: int | None
    result: str
    event: str
    played_on: date | None
    eco: str | None
    opening: str | None
    ply_count: int

    class Config:
        from_attributes = True


class GameDetail(GameOut):
    movetext: str
    annotations: list["AnnotationOut"] = []


class ImportPgnRequest(BaseModel):
    pgn: str = Field(max_length=5_000_000)


class ImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[str] = []
    game_ids: list[int] = []


class GameUpdate(BaseModel):
    white: str | None = None
    black: str | None = None
    event: str | None = None
    result: str | None = None


# ---------- annotations ----------

class AnnotationIn(BaseModel):
    ply: int
    nag: int | None = None
    comment: str | None = Field(default=None, max_length=2000)


class AnnotationOut(BaseModel):
    ply: int
    nag: int | None
    comment: str | None
    eval_cp: int | None
    best_uci: str | None = None
    classification: str | None = None
    review: str | None = None

    class Config:
        from_attributes = True


# ---------- analysis ----------

class AnalysePositionRequest(BaseModel):
    fen: str = Field(max_length=200)
    depth: int = Field(default=20, ge=1, le=40)
    multipv: int = Field(default=1, ge=1, le=5)


class AnalysisJobOut(BaseModel):
    job_id: int
    status: str
    cached: bool = False
    result: dict | None = None


# ---------- explorer ----------

class ExplorerRequest(BaseModel):
    fen: str = Field(max_length=200)
    min_elo: int | None = Field(default=None, ge=0, le=3500)
    scope: str = Field(default="reference", pattern="^(reference|mine|lichess_live)$")


class ExplorerMove(BaseModel):
    uci: str
    san: str
    games: int
    white_wins: int
    draws: int
    black_wins: int
    avg_elo: int | None
    white_pct: float
    draw_pct: float
    black_pct: float


class ExplorerOut(BaseModel):
    fen: str
    total_games: int
    moves: list[ExplorerMove]


# ---------- puzzles ----------

class PuzzleOut(BaseModel):
    id: int
    lichess_id: str
    fen: str
    moves: list[str]           # UCI solution line; moves[0] is the setup move
    rating: int
    themes: list[str]
    game_url: str | None = None


class PuzzleAttemptIn(BaseModel):
    puzzle_id: int
    solved: bool


class PuzzleAttemptResult(BaseModel):
    solved: bool
    rating_before: int
    rating_after: int
    delta: int
    puzzle_rating: int


class PuzzleStats(BaseModel):
    puzzle_rating: int
    solved: int
    attempted: int
    streak: int


class PuzzleTheme(BaseModel):
    theme: str
    count: int


# ---------- play vs computer ----------

class PlayMoveIn(BaseModel):
    fen: str = Field(max_length=200)
    level: int = Field(default=4, ge=1, le=8)


class PlayMoveOut(BaseModel):
    move: str | None          # UCI, or null if the game is already over
    game_over: bool


# ---------- opening catalog ----------

class OpeningOut(BaseModel):
    id: str
    name: str
    color: str
    eco: str
    description: str
    moves: str                # PGN with the opponent's alternatives in ( )


# ---------- collections ----------

class CollectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class CollectionOut(BaseModel):
    id: int
    name: str
    game_count: int = 0

    class Config:
        from_attributes = True


GameDetail.model_rebuild()


# ---------- connected accounts (auto-import) ----------

class ConnectAccountRequest(BaseModel):
    platform: str = Field(pattern="^(lichess|chesscom)$")
    username: str = Field(min_length=2, max_length=50, pattern=r"^[\w.-]+$")


class ExternalAccountOut(BaseModel):
    platform: str
    username: str
    last_synced_at: datetime | None
    last_status: str | None
    games_imported: int

    class Config:
        from_attributes = True


class SyncResult(BaseModel):
    platform: str
    username: str
    fetched: int
    imported: int
    duplicates: int
    capped: int  # games skipped because the free-tier storage cap was hit
    errors: list[str] = []


# ---------- repertoire training ----------

class RepertoireCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(pattern="^(white|black)$")
    pgn: str = Field(max_length=500_000)


class RepertoireOut(BaseModel):
    id: int
    name: str
    color: str
    card_count: int = 0
    due_count: int = 0

    class Config:
        from_attributes = True


class TrainingCardOut(BaseModel):
    id: int
    repertoire_id: int
    repertoire_name: str
    color: str
    fen: str
    reps: int
    interval_days: float

    class Config:
        from_attributes = True


class TrainingAnswer(BaseModel):
    card_id: int
    answer_uci: str = Field(min_length=4, max_length=5)


class TrainingResult(BaseModel):
    correct: bool
    expected_uci: str
    expected_san: str
    next_due_days: float
