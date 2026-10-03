/**
 * Client for the /admin surface.
 *
 * A SEPARATE MODULE FROM lib/api.ts ON PURPOSE. It would be less code to add a
 * few methods there and reuse the request helper, and that is exactly the
 * mistake this file exists to prevent: lib/api.ts attaches the player access
 * token to every call and transparently refreshes it. Sharing that helper is
 * how an admin route eventually gets called with a player token, or worse, how
 * an admin token ends up on a player route.
 *
 * So the two clients share nothing:
 *   - different storage key (cr_admin_access vs ob_access)
 *   - different Authorization header source
 *   - NO refresh. The admin token cannot be refreshed by design; a 401 means
 *     the hour is up, and the only correct response is to sign in again.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const TOKEN_KEY = "cr_admin_access";
const EXPIRY_KEY = "cr_admin_expires";

// ---- types ----

export interface AdminToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  display_name: string;
}

/** A day and its count. Zero-filled by the server, so gaps are real zeros. */
export interface Point {
  day: string;
  value: number;
}

export interface Overview {
  days: number;
  live: {
    /** null when Redis could not answer — shown as "unavailable", never as 0. */
    online_now: number | null;
    active_today: number;
    active_7d: number;
    active_30d: number;
  };
  users: {
    total: number;
    verified: number;
    suspended: number;
    new_today: number;
    new_7d: number;
    new_30d: number;
    new_series: Point[];
  };
  engagement: {
    active_series: Point[];
    games_series: Point[];
    jobs_series: Point[];
  };
}

export interface PlatformStats {
  users_total: number;
  users_suspended: number;
  users_new_7d: number;
  user_games: number;
  reference_games: number;
  opening_tree_rows: number;
  cache_positions: number;
  jobs_queued: number;
  jobs_running: number;
  jobs_failed_7d: number;
  jobs_7d: number;
  engine_seconds_7d: number;
  db_size_mb: number;
}

export interface AdminUser {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
  suspended: boolean;
  email_verified: boolean;
  created_at: string;
  games: number;
  jobs_7d: number;
}

export interface UserPage {
  total: number;
  page: number;
  page_size: number;
  users: AdminUser[];
}

export interface AuditEntry {
  id: number;
  action: string;
  detail: Record<string, unknown>;
  ip: string | null;
  created_at: string;
  admin_id: number | null;
  admin_email: string | null;
  target_user_id: number | null;
  target_email: string | null;
}

export interface AuditPage {
  total: number;
  page: number;
  page_size: number;
  entries: AuditEntry[];
}

export class AdminApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// ---- token storage ----

export function setAdminToken(token: AdminToken) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token.access_token);
  // Stored so the shell can show a countdown and send the operator to the
  // login page before a half-loaded dashboard starts throwing 401s at them.
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + token.expires_in * 1000));
}

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;

  const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
  if (expiry && Date.now() >= expiry) {
    clearAdminToken();
    return null;
  }
  return token;
}

export function adminTokenExpiresAt(): number | null {
  if (typeof window === "undefined") return null;
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
  return expiry || null;
}

export function clearAdminToken() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (res.status === 401) {
    // No retry, no refresh. Drop the token so the guard in AdminShell sees an
    // unauthenticated state on its next render and returns to /admin.
    clearAdminToken();
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
    throw new AdminApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const adminApi = {
  login: (email: string, password: string) =>
    request<AdminToken>("/admin/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: async () => {
    try {
      await request<void>("/admin/auth/logout", { method: "POST" });
    } finally {
      clearAdminToken();
    }
  },

  me: () => request<{ id: number; email: string; display_name: string }>("/admin/me"),

  overview: (days = 30) => request<Overview>(`/admin/overview?days=${days}`),

  stats: () => request<PlatformStats>("/admin/stats"),

  users: (opts: { page?: number; q?: string; status?: string } = {}) => {
    const q = new URLSearchParams({ page: String(opts.page ?? 1) });
    if (opts.q) q.set("q", opts.q);
    if (opts.status) q.set("account_status", opts.status);
    return request<UserPage>(`/admin/users?${q.toString()}`);
  },

  suspend: (id: number) =>
    request<void>(`/admin/users/${id}/suspend`, { method: "POST" }),

  unsuspend: (id: number) =>
    request<void>(`/admin/users/${id}/unsuspend`, { method: "POST" }),

  audit: (page = 1) => request<AuditPage>(`/admin/audit?page=${page}`),
};
