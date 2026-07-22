/**
 * Typed API client for the ChessRabbit backend.
 * Handles access-token storage and transparent refresh on 401.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface Me {
  id: number;
  email: string;
  display_name: string;
  plan: "free" | "pro";
  email_verified: boolean;
  analyses_today: number;
  daily_limit: number | null;
  max_depth: number;
  max_multipv: number;
  puzzle_rating: number;
}

export interface Puzzle {
  id: number;
  lichess_id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  game_url: string | null;
}

export interface PuzzleAttemptResult {
  solved: boolean;
  rating_before: number;
  rating_after: number;
  delta: number;
  puzzle_rating: number;
}

export interface PuzzleStats {
  puzzle_rating: number;
  solved: number;
  attempted: number;
  streak: number;
}

export interface PuzzleTheme {
  theme: string;
  count: number;
}

export interface Game {
  id: number;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  result: string;
  event: string;
  played_on: string | null;
  eco: string | null;
  opening: string | null;
  ply_count: number;
}

export interface GameDetail extends Game {
  movetext: string;
  annotations: Annotation[];
}

export interface Annotation {
  ply: number;
  nag: number | null;
  comment: string | null;
  eval_cp: number | null;
  best_uci: string | null;
  classification: Classification | null;
  review: string | null;
}

export type Classification =
  | "book"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder";

export interface ReviewSummary {
  accuracy: { white: number; black: number };
  classifications: {
    white: Partial<Record<Classification, number>>;
    black: Partial<Record<Classification, number>>;
  };
}

export interface EvalLine {
  depth: number;
  multipv: number;
  cp: number | null;
  mate: number | null;
  pv: string[];
}

export type ExplorerScope = "reference" | "mine" | "lichess_live";

export interface ExplorerMove {
  uci: string;
  san: string;
  games: number;
  white_wins: number;
  draws: number;
  black_wins: number;
  avg_elo: number | null;
  white_pct: number;
  draw_pct: number;
  black_pct: number;
}

export interface Repertoire {
  id: number;
  name: string;
  color: "white" | "black";
  card_count: number;
  due_count: number;
}

export interface TrainingCard {
  id: number;
  repertoire_id: number;
  repertoire_name: string;
  color: "white" | "black";
  fen: string;
  reps: number;
  interval_days: number;
}

export interface TrainingResult {
  correct: boolean;
  expected_uci: string;
  expected_san: string;
  next_due_days: number;
}

export interface ExternalAccount {
  platform: "lichess" | "chesscom";
  username: string;
  last_synced_at: string | null;
  last_status: string | null;
  games_imported: number;
}

export interface SyncResult {
  platform: string;
  username: string;
  fetched: number;
  imported: number;
  duplicates: number;
  capped: number;
  errors: string[];
}

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// --- token storage (in-memory + localStorage mirror) ---

let accessToken: string | null = null;

export function setTokens(pair: TokenPair) {
  accessToken = pair.access_token;
  if (typeof window !== "undefined") {
    localStorage.setItem("ob_refresh", pair.refresh_token);
    localStorage.setItem("ob_access", pair.access_token);
  }
}

export function getAccessToken(): string | null {
  if (accessToken) return accessToken;
  if (typeof window !== "undefined") {
    accessToken = localStorage.getItem("ob_access");
  }
  return accessToken;
}

export function clearTokens() {
  accessToken = null;
  if (typeof window !== "undefined") {
    localStorage.removeItem("ob_refresh");
    localStorage.removeItem("ob_access");
  }
}

async function refreshAccessToken(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const refresh = localStorage.getItem("ob_refresh");
  if (!refresh) return false;

  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) {
    clearTokens();
    return false;
  }
  setTokens(await res.json());
  return true;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (res.status === 401 && retry) {
    if (await refreshAccessToken()) {
      return request<T>(path, options, false);
    }
  }

  if (!res.ok) {
    let code = "error";
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.detail?.code ?? code;
      message = body.detail?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  register: (email: string, password: string, display_name = "") =>
    request<TokenPair>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name }),
    }),

  login: (email: string, password: string) =>
    request<TokenPair>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () => {
    const refresh =
      typeof window !== "undefined" ? localStorage.getItem("ob_refresh") : null;
    clearTokens();
    if (!refresh) return Promise.resolve();
    return request<void>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refresh }),
    });
  },

  me: () => request<Me>("/me"),

  listGames: (page = 1) => request<Game[]>(`/games?page=${page}`),

  getGame: (id: number) => request<GameDetail>(`/games/${id}`),

  importPgn: (pgn: string) =>
    request<{ imported: number; skipped: number; game_ids: number[] }>("/games", {
      method: "POST",
      body: JSON.stringify({ pgn }),
    }),

  deleteGame: (id: number) => request<void>(`/games/${id}`, { method: "DELETE" }),

  analysePosition: (fen: string, depth = 20, multipv = 3) =>
    request<{ job_id: number; status: string; cached: boolean; result: any }>(
      "/analysis/position",
      { method: "POST", body: JSON.stringify({ fen, depth, multipv }) }
    ),

  analyseGame: (gameId: number) =>
    request<{ job_id: number; status: string }>(`/analysis/game/${gameId}`, {
      method: "POST",
    }),

  getJob: (jobId: number) =>
    request<{ job_id: number; status: string; result: any }>(
      `/analysis/jobs/${jobId}`
    ),

  explorer: (fen: string, scope: ExplorerScope = "reference") =>
    request<{ fen: string; total_games: number; moves: ExplorerMove[] }>(
      "/explorer",
      { method: "POST", body: JSON.stringify({ fen, scope }) }
    ),

  searchPosition: (fen: string) =>
    request<Game[]>("/search/position", {
      method: "POST",
      body: JSON.stringify({ fen }),
    }),

  // ---- repertoire training ----

  createRepertoire: (name: string, color: "white" | "black", pgn: string) =>
    request<Repertoire>("/repertoires", {
      method: "POST",
      body: JSON.stringify({ name, color, pgn }),
    }),

  listRepertoires: () => request<Repertoire[]>("/repertoires"),

  deleteRepertoire: (id: number) =>
    request<void>(`/repertoires/${id}`, { method: "DELETE" }),

  syncBlunders: () =>
    request<{
      mistakes_found: number;
      cards_created: number;
      already_present: number;
      invalid: number;
    }>("/training/blunders/sync", { method: "POST" }),

  dueCards: (limit = 20, repertoire?: number) =>
    request<TrainingCard[]>(
      `/training/due?limit=${limit}${repertoire ? `&repertoire=${repertoire}` : ""}`
    ),

  answerCard: (card_id: number, answer_uci: string) =>
    request<TrainingResult>("/training/answer", {
      method: "POST",
      body: JSON.stringify({ card_id, answer_uci }),
    }),

  // ---- tactics puzzles ----

  nextPuzzle: (opts?: { theme?: string; rating?: number }) => {
    const q = new URLSearchParams();
    if (opts?.theme) q.set("theme", opts.theme);
    if (opts?.rating != null) q.set("rating", String(opts.rating));
    const qs = q.toString();
    return request<Puzzle>(`/puzzles/next${qs ? `?${qs}` : ""}`);
  },

  attemptPuzzle: (puzzle_id: number, solved: boolean) =>
    request<PuzzleAttemptResult>("/puzzles/attempt", {
      method: "POST",
      body: JSON.stringify({ puzzle_id, solved }),
    }),

  puzzleStats: () => request<PuzzleStats>("/puzzles/stats"),

  puzzleThemes: () => request<PuzzleTheme[]>("/puzzles/themes"),

  // ---- play vs computer ----

  playMove: (fen: string, level: number) =>
    request<{ move: string | null; game_over: boolean }>("/play/move", {
      method: "POST",
      body: JSON.stringify({ fen, level }),
    }),

  // ---- connected accounts (auto-import) ----

  listAccounts: () => request<ExternalAccount[]>("/me/accounts"),

  connectAccount: (platform: "lichess" | "chesscom", username: string) =>
    request<SyncResult>("/me/accounts", {
      method: "POST",
      body: JSON.stringify({ platform, username }),
    }),

  syncAccount: (platform: "lichess" | "chesscom") =>
    request<SyncResult>(`/me/accounts/${platform}/sync`, { method: "POST" }),

  disconnectAccount: (platform: "lichess" | "chesscom") =>
    request<void>(`/me/accounts/${platform}`, { method: "DELETE" }),

  // ---- billing ----

  checkout: (interval: "monthly" | "yearly" = "monthly") =>
    request<{ url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ interval }),
    }),

  billingPortal: () =>
    request<{ url: string }>("/billing/portal", { method: "POST" }),
};

export { ApiError, API_URL };
