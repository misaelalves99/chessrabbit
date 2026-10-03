"use client";

import { useEffect, useState } from "react";
import { adminApi, Overview, PlatformStats } from "@/lib/adminApi";
import AdminShell from "@/components/admin/AdminShell";

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([adminApi.overview(), adminApi.stats()]).then(([o, s]) => {
      setOverview(o); setStats(s);
    }).catch((err) => setError(err.message));
  }, []);
  return <AdminShell title="Community installation"><div className="space-y-6">
    <h1 className="font-display text-2xl">Community installation</h1>
    {error && <p className="text-bad">{error}</p>}
    {overview && <div className="grid gap-3 sm:grid-cols-3">
      {[['Accounts', overview.users.total], ['Online now', overview.live.online_now ?? 'Unavailable'], ['Active this week', overview.live.active_7d]].map(([name, value]) =>
        <div className="card p-4" key={name}><p className="text-xs text-muted">{name}</p><p className="mt-2 font-mono text-2xl">{value}</p></div>)}
    </div>}
    {stats && <dl className="card grid grid-cols-2 gap-3 p-4 text-sm">
      <dt>Personal games</dt><dd>{stats.user_games}</dd>
      <dt>Reference games</dt><dd>{stats.reference_games}</dd>
      <dt>Cached positions</dt><dd>{stats.cache_positions}</dd>
      <dt>Queued / running jobs</dt><dd>{stats.jobs_queued} / {stats.jobs_running}</dd>
      <dt>Failed jobs this week</dt><dd>{stats.jobs_failed_7d}</dd>
      <dt>Database size</dt><dd>{stats.db_size_mb} MB</dd>
    </dl>}
  </div></AdminShell>;
}
