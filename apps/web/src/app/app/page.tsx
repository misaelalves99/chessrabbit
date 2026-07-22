"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AnalysisBoard from "@/components/AnalysisBoard";
import {
  Annotation,
  api,
  ApiError,
  clearTokens,
  ExternalAccount,
  Game,
  Me,
  SyncResult,
} from "@/lib/api";

export default function AppPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [activePgn, setActivePgn] = useState<string | undefined>();
  const [activeLabel, setActiveLabel] = useState<string | undefined>();
  const [activeId, setActiveId] = useState<number | undefined>();
  const [activeAnnotations, setActiveAnnotations] = useState<Annotation[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [pgnText, setPgnText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accounts, setAccounts] = useState<ExternalAccount[]>([]);
  const [connectPlatform, setConnectPlatform] = useState<"lichess" | "chesscom">("lichess");
  const [connectUsername, setConnectUsername] = useState("");
  const [busyPlatform, setBusyPlatform] = useState<string | null>(null);

  const loadGames = useCallback(() => {
    api.listGames().then(setGames).catch(() => setGames([]));
  }, []);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        loadGames();
      })
      .catch(() => router.push("/login"));

    const params = new URLSearchParams(window.location.search);
    if (params.get("upgraded")) {
      setNotice("Welcome to Pro! Deeper analysis and unlimited games are now unlocked.");
      window.history.replaceState({}, "", "/app");
    } else if (params.get("canceled")) {
      setNotice("Checkout canceled - no charge was made.");
      window.history.replaceState({}, "", "/app");
    }
  }, [router, loadGames]);

  async function billingAction() {
    try {
      const { url } = me?.plan === "pro"
        ? await api.billingPortal()
        : await api.checkout("monthly");
      window.location.href = url;
    } catch (err) {
      setNotice(
        err instanceof ApiError && err.code === "billing_not_configured"
          ? "Billing isn't configured on this server yet (see README)."
          : "Billing request failed - try again shortly."
      );
    }
  }

  async function openGame(g: Game) {
    try {
      const detail = await api.getGame(g.id);
      setActivePgn(detail.movetext);
      setActiveId(g.id);
      setActiveAnnotations(detail.annotations);
      setActiveLabel(
        `${g.white} vs ${g.black} · ${g.result}${g.event ? ` · ${g.event}` : ""}`
      );
    } catch {
      setNotice("Could not load that game");
    }
  }

  async function doImport() {
    try {
      const res = await api.importPgn(pgnText);
      setNotice(`Imported ${res.imported} game(s)`);
      setPgnText("");
      setImportOpen(false);
      loadGames();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Import failed");
    }
  }

  function syncSummary(res: SyncResult): string {
    let msg = `${res.platform}: imported ${res.imported} game(s)`;
    if (res.duplicates) msg += `, ${res.duplicates} already here`;
    if (res.capped)
      msg += ` — ${res.capped} skipped (free plan is full; upgrade for unlimited)`;
    return msg;
  }

  async function openAccounts() {
    setAccountsOpen(true);
    api.listAccounts().then(setAccounts).catch(() => setAccounts([]));
  }

  async function doConnect() {
    setBusyPlatform(connectPlatform);
    try {
      const res = await api.connectAccount(connectPlatform, connectUsername.trim());
      setNotice(syncSummary(res));
      setConnectUsername("");
      api.listAccounts().then(setAccounts).catch(() => {});
      loadGames();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Could not connect account");
    } finally {
      setBusyPlatform(null);
    }
  }

  async function doSync(platform: "lichess" | "chesscom") {
    setBusyPlatform(platform);
    try {
      const res = await api.syncAccount(platform);
      setNotice(syncSummary(res));
      api.listAccounts().then(setAccounts).catch(() => {});
      loadGames();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Sync failed");
    } finally {
      setBusyPlatform(null);
    }
  }

  async function doDisconnect(platform: "lichess" | "chesscom") {
    try {
      await api.disconnectAccount(platform);
      setAccounts((a) => a.filter((x) => x.platform !== platform));
      setNotice(`Disconnected ${platform}. Imported games were kept.`);
    } catch {
      setNotice("Could not disconnect");
    }
  }

  async function signOut() {
    await api.logout().catch(() => {});
    clearTokens();
    router.push("/");
  }

  if (!me) {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted">
        Loading…
      </main>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-4 py-2 bg-panelAlt border-b border-white/10">
        <button
          className="btn lg:hidden"
          onClick={() => setSidebarOpen((s) => !s)}
        >
          ☰
        </button>
        <span className="font-bold">
          Chess<span className="text-accent">Rabbit</span>
        </span>
        <span className="text-xs text-muted">
          {me.display_name} ·{" "}
          <span className={me.plan === "pro" ? "text-accent" : ""}>
            {me.plan}
          </span>
          {me.daily_limit !== null &&
            ` · ${me.analyses_today}/${me.daily_limit} analyses today`}
        </span>
        <div className="ml-auto flex gap-2">
          <button className="btn" onClick={billingAction}>
            {me.plan === "pro" ? "Manage billing" : "★ Upgrade"}
          </button>
          <Link href="/train" className="btn">
            ♞ Train
          </Link>
          <Link href="/train/puzzles" className="btn">
            🧩 Puzzles
          </Link>
          <button className="btn" onClick={openAccounts}>
            ⇄ Accounts
          </button>
          <button className="btn" onClick={() => setImportOpen(true)}>
            + Import PGN
          </button>
          <button className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {notice && (
        <div
          className="bg-accent/20 text-sm px-4 py-2 cursor-pointer"
          onClick={() => setNotice(null)}
        >
          {notice} <span className="text-muted">(dismiss)</span>
        </div>
      )}

      <div className="flex flex-1">
        {/* Games sidebar */}
        {sidebarOpen && (
          <aside className="w-72 shrink-0 border-r border-white/10 bg-panel overflow-auto max-h-[calc(100vh-49px)]">
            <div className="p-3">
              <h2 className="text-sm font-semibold mb-2">
                My games{" "}
                <span className="text-muted font-normal">({games.length})</span>
              </h2>
              {games.length === 0 && (
                <p className="text-xs text-muted">
                  No games yet. Import a PGN to get started, or just move
                  pieces on the board.
                </p>
              )}
              <ul className="space-y-1">
                {games.map((g) => (
                  <li key={g.id}>
                    <button
                      onClick={() => openGame(g)}
                      className="w-full text-left text-xs p-2 rounded hover:bg-white/5"
                    >
                      <div className="font-medium truncate">
                        {g.white || "?"} — {g.black || "?"}
                      </div>
                      <div className="text-muted flex gap-2">
                        <span>{g.result}</span>
                        {g.eco && <span>{g.eco}</span>}
                        {g.played_on && <span>{g.played_on}</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        )}

        {/* Board workspace */}
        <div className="flex-1 overflow-auto">
          <AnalysisBoard
            initialPgn={activePgn}
            gameLabel={activeLabel}
            gameId={activeId}
            initialAnnotations={activeAnnotations}
          />
        </div>
      </div>

      {/* Connected accounts modal */}
      {accountsOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
          onClick={() => setAccountsOpen(false)}
        >
          <div
            className="bg-panelAlt rounded-lg p-4 w-full max-w-lg space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-semibold">Connected accounts</h2>
            <p className="text-xs text-muted">
              Link your Lichess or Chess.com username and your games import
              automatically — newest first, synced nightly.
            </p>

            {accounts.length > 0 && (
              <ul className="space-y-2">
                {accounts.map((a) => (
                  <li
                    key={a.platform}
                    className="flex items-center gap-2 text-sm bg-white/5 rounded p-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {a.platform === "lichess" ? "Lichess" : "Chess.com"} ·{" "}
                        {a.username}
                      </div>
                      <div className="text-xs text-muted truncate">
                        {a.games_imported} games imported
                        {a.last_synced_at &&
                          ` · last sync ${new Date(a.last_synced_at).toLocaleString()}`}
                        {a.last_status && a.last_status !== "ok" && (
                          <span className="text-red-400"> · {a.last_status}</span>
                        )}
                      </div>
                    </div>
                    <button
                      className="btn text-xs"
                      disabled={busyPlatform === a.platform}
                      onClick={() => doSync(a.platform)}
                    >
                      {busyPlatform === a.platform ? "Syncing…" : "Sync now"}
                    </button>
                    <button
                      className="btn text-xs"
                      onClick={() => doDisconnect(a.platform)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-2">
              <select
                className="input w-36"
                value={connectPlatform}
                onChange={(e) =>
                  setConnectPlatform(e.target.value as "lichess" | "chesscom")
                }
              >
                <option value="lichess">Lichess</option>
                <option value="chesscom">Chess.com</option>
              </select>
              <input
                className="input flex-1"
                placeholder="username"
                value={connectUsername}
                onChange={(e) => setConnectUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && connectUsername.trim()) doConnect();
                }}
              />
              <button
                className="btn-primary"
                disabled={!connectUsername.trim() || busyPlatform !== null}
                onClick={doConnect}
              >
                {busyPlatform ? "Importing…" : "Connect"}
              </button>
            </div>

            <div className="flex justify-end">
              <button className="btn" onClick={() => setAccountsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import modal */}
      {importOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
          onClick={() => setImportOpen(false)}
        >
          <div
            className="bg-panelAlt rounded-lg p-4 w-full max-w-lg space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-semibold">Import PGN</h2>
            <textarea
              className="input h-48 font-mono text-xs"
              placeholder={'[Event "..."]\n\n1. e4 e5 ...'}
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setImportOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={doImport}
                disabled={!pgnText.trim()}
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
