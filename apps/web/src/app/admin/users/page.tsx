"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/admin/AdminShell";
import { AdminApiError, AdminUser, UserPage, adminApi } from "@/lib/adminApi";

const PLANS = ["free", "pro", "master"] as const;

const STATUSES = [
  { id: "", label: "All" },
  { id: "active", label: "Active" },
  { id: "suspended", label: "Suspended" },
  { id: "unverified", label: "Unverified" },
] as const;

function planChip(plan: string): string {
  if (plan === "master") return "bg-brass/20 text-brassLit";
  if (plan === "pro") return "bg-good/20 text-good";
  return "bg-ivory/[0.07] text-muted";
}

/**
 * Prompt for the reason a manual plan change is being made.
 *
 * The API requires it and stores it on the audit row: this endpoint bypasses
 * Stripe, so this sentence is the only record of why somebody's plan changed.
 */
function PlanDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState(user.plan);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.setPlan(user.id, plan, reason);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : "Could not change the plan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Change plan</h2>
          <p className="mt-1 text-xs text-muted">{user.email}</p>
        </div>

        {error && <p className="text-sm text-bad">{error}</p>}

        <div className="seg">
          {PLANS.map((p) => (
            <button
              key={p}
              type="button"
              className={`seg-item ${plan === p ? "seg-item-on" : ""}`}
              onClick={() => setPlan(p)}
            >
              {p}
            </button>
          ))}
        </div>

        <input
          className="input"
          placeholder="Reason (recorded in the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={3}
          required
        />

        <p className="text-[11px] leading-relaxed text-muted/70">
          This bypasses Stripe. Accounts with a live subscription are refused —
          change those in Stripe, or the next webhook will undo this.
        </p>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn text-xs" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary text-xs" disabled={busy || plan === user.plan}>
            {busy ? "Saving…" : "Apply"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function AdminUsersPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<UserPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .users({ page, q: q || undefined, plan: plan || undefined, status: status || undefined })
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (err instanceof AdminApiError && err.status === 401) return;
        setError(err instanceof AdminApiError ? err.message : "Could not load users");
      })
      .finally(() => setLoading(false));
  }, [page, q, plan, status]);

  // Typing in the search box should not fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(id);
  }, [load, q]);

  /** Flip a row's suspended state locally, without refetching the page. */
  function patchUser(id: number, suspended: boolean) {
    setData((d) =>
      d
        ? { ...d, users: d.users.map((u) => (u.id === id ? { ...u, suspended } : u)) }
        : d
    );
  }

  async function toggleSuspend(user: AdminUser) {
    const next = !user.suspended;
    // The chip and the button label flip immediately; the reload afterwards is
    // what makes the audit trail and any server-side side effects show up. It
    // used to be the only thing that moved the row at all, so suspending an
    // account meant a POST plus a full page query before anything changed.
    patchUser(user.id, next);
    setError(null);
    try {
      await (user.suspended ? adminApi.unsuspend(user.id) : adminApi.suspend(user.id));
      load();
    } catch (err) {
      patchUser(user.id, user.suspended);
      setError(
        (err instanceof AdminApiError ? err.message : "Action failed") +
          ` — ${user.email} is still ${user.suspended ? "suspended" : "active"}.`
      );
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <AdminShell
      title="Users"
      actions={
        <span className="font-mono text-xs text-muted">
          {data ? `${data.total} accounts` : ""}
        </span>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder="Search by email…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <div className="seg">
          {STATUSES.map((s) => (
            <button
              key={s.id}
              className={`seg-item ${status === s.id ? "seg-item-on" : ""}`}
              onClick={() => {
                setStatus(s.id);
                setPage(1);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="seg">
          <button
            className={`seg-item ${plan === "" ? "seg-item-on" : ""}`}
            onClick={() => {
              setPlan("");
              setPage(1);
            }}
          >
            All plans
          </button>
          {PLANS.map((p) => (
            <button
              key={p}
              className={`seg-item ${plan === p ? "seg-item-on" : ""}`}
              onClick={() => {
                setPlan(p);
                setPage(1);
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-bad">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-ivory/[0.07] text-left">
              {["User", "Plan", "Joined", "Games", "Jobs 7d", "Status", ""].map((h) => (
                <th key={h} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id} className="border-b border-ivory/[0.04] last:border-0">
                <td className="px-3 py-2">
                  <div className="truncate font-medium">{u.email}</div>
                  <div className="truncate text-xs text-muted">
                    {u.display_name}
                    {u.is_admin && <span className="ml-2 text-brassLit">admin</span>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className={`chip ${planChip(u.plan)}`}>{u.plan}</span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{u.games}</td>
                <td className="px-3 py-2 font-mono text-xs">{u.jobs_7d}</td>
                <td className="px-3 py-2">
                  {u.suspended ? (
                    <span className="chip bg-bad/20 text-bad">suspended</span>
                  ) : !u.email_verified ? (
                    <span className="chip bg-ivory/[0.07] text-muted">unverified</span>
                  ) : (
                    <span className="chip bg-good/20 text-good">active</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1.5">
                    <button className="btn text-xs" onClick={() => setEditing(u)}>
                      Plan
                    </button>
                    <button
                      className="btn text-xs"
                      onClick={() => toggleSuspend(u)}
                      disabled={u.is_admin && !u.suspended}
                      title={
                        u.is_admin && !u.suspended
                          ? "Demote the admin flag first"
                          : undefined
                      }
                    >
                      {u.suspended ? "Unsuspend" : "Suspend"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {loading && <p className="px-3 py-4 text-sm text-muted">Loading…</p>}
        {!loading && data?.users.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted">
            No users match these filters.
          </p>
        )}
      </div>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <button className="btn text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="font-mono text-xs text-muted">
            {page} / {pages}
          </span>
          <button className="btn text-xs" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}

      {editing && (
        <PlanDialog user={editing} onClose={() => setEditing(null)} onDone={load} />
      )}
    </AdminShell>
  );
}
