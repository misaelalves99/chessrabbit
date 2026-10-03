import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function browser() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return storage;
}

it("shares one personal-session bootstrap across simultaneous initial requests", async () => {
  browser();
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/app-config")) return Response.json({ local_mode: true });
    if (url.endsWith("/auth/local-session")) return Response.json({ access_token: "local", refresh_token: "refresh" });
    expect((options?.headers as Record<string, string>).Authorization).toBe("Bearer local");
    return Response.json(url.endsWith("/me") ? { id: 1 } : []);
  });
  vi.stubGlobal("fetch", fetcher);
  const { api } = await import("./api");
  await Promise.all([api.me(), api.listGames()]);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/local-session"))).toHaveLength(1);
});

it("renews an expired session once and keeps analysis engine parameters", async () => {
  const storage = browser();
  storage.setItem("ob_access", "expired"); storage.setItem("ob_refresh", "refresh");
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/auth/refresh")) return Response.json({ access_token: "renewed", refresh_token: "next" });
    if ((options?.headers as Record<string, string>).Authorization === "Bearer expired") return new Response(null, { status: 401 });
    if (url.endsWith("/analysis/position")) expect(JSON.parse(options?.body as string)).toEqual({ fen: "position", depth: 18, multipv: 2, engine: "lc0" });
    return Response.json({ id: 1 });
  });
  vi.stubGlobal("fetch", fetcher);
  const { api } = await import("./api");
  await Promise.all([api.me(), api.analysePosition("position", 18, 2, "lc0")]);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/refresh"))).toHaveLength(1);
});
