"use client";

import { useEffect, useState } from "react";
import AdminShell from "@/components/admin/AdminShell";
import ChartCard, { StatTile } from "@/components/charts/ChartCard";
import AreaChart, { Point as ChartPoint } from "@/components/charts/AreaChart";
import Columns from "@/components/charts/Columns";
import Donut from "@/components/charts/Donut";
import {
  AdminApiError, Overview, Point, PlatformStats, adminApi,
} from "@/lib/adminApi";
import { SERIES, seriesColor } from "@/lib/vizTheme";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  master: "Master",
};

/** "4 Jun" — the axis has a hundred of these, so it stays short. */
function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function toPoints(series: Point[], noun: string): ChartPoint[] {
  return series.map((p) => ({
    label: dayLabel(p.day),
    value: p.value,
    note: `${p.value} ${p.value === 1 ? noun : `${noun}s`}`,
  }));
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** A running total, so the growth chart shows the curve rather than the noise. */
function cumulative(series: Point[], start: number): ChartPoint[] {
  // The window only holds `days` of signups, so it has to be anchored on the
  // total minus what arrived inside it — otherwise the curve starts at zero and
  // implies the product launched this month.
  const inWindow = series.reduce((sum, p) => sum + p.value, 0);
  let running = start - inWindow;
  return series.map((p) => {
    running += p.value;
    return { label: dayLabel(p.day), value: running, note: `+${p.value} that day` };
  });
}

export default function AdminDashboardPage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Overview | null>(null);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    Promise.all([adminApi.overview(days), adminApi.stats()])
      .then(([overview, platform]) => {
        if (stale) return;
        setData(overview);
        setStats(platform);
        setError(null);
      })
      .catch((err) => {
        if (stale) return;
        // A 401 is not an error worth showing: AdminShell is already on its way
        // to the login page.
        if (err instanceof AdminApiError && err.status === 401) return;
        setError(err instanceof AdminApiError ? err.message : "Could not load the dashboard");
      })
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [days]);

  const ranges = (
    <div className="seg">
      {RANGES.map((r) => (
        <button
          key={r.days}
          className={`seg-item ${days === r.days ? "seg-item-on" : ""}`}
          onClick={() => setDays(r.days)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  return (
    <AdminShell title="Dashboard" actions={ranges}>
      {error && <p className="mb-4 text-sm text-bad">{error}</p>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}

      {data && (
        <div className="space-y-4">
          {/* ---- Right now ---- */}
          <section>
            <h2 className="eyebrow mb-2">Right now</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile
                value={
                  data.live.online_now === null ? "—" : String(data.live.online_now)
                }
                label="Online now"
                sub={
                  data.live.online_now === null
                    ? "presence unavailable"
                    : "seen in the last 5 min"
                }
                tone={data.live.online_now === null ? "ink" : "accent"}
              />
              <StatTile
                value={String(data.live.active_today)}
                label="Active today"
                sub="distinct users"
              />
              <StatTile
                value={String(data.live.active_7d)}
                label="Active 7d"
              />
              <StatTile
                value={String(data.live.active_30d)}
                label="Active 30d"
              />
            </div>
          </section>

          {/* ---- Users ---- */}
          <section>
            <h2 className="eyebrow mb-2">Users</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile value={String(data.users.total)} label="Total users" />
              <StatTile
                value={String(data.users.new_today)}
                label="New today"
                tone={data.users.new_today > 0 ? "good" : "ink"}
              />
              <StatTile value={String(data.users.new_7d)} label="New this week" />
              <StatTile
                value={String(data.users.suspended)}
                label="Suspended"
                tone={data.users.suspended > 0 ? "bad" : "ink"}
              />
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard
                title="New signups per day"
                hint={`Registrations over the last ${data.days} days. Days with no signups are zeros, not gaps.`}
              >
                <AreaChart
                  points={toPoints(data.users.new_series, "signup")}
                  color={SERIES[0]}
                  min={0}
                />
              </ChartCard>

              <ChartCard
                title="Total users"
                hint="Cumulative, anchored on today's total."
              >
                <AreaChart
                  points={cumulative(data.users.new_series, data.users.total)}
                  color={SERIES[1]}
                />
              </ChartCard>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard title="Plan mix" hint="Every account, by the plan it is on.">
                <Columns
                  columns={Object.entries(PLAN_LABELS).map(([id, label], i) => ({
                    key: id,
                    label,
                    value: data.users.by_plan[id] ?? 0,
                    color: seriesColor(i),
                  }))}
                  max={Math.max(1, ...Object.values(data.users.by_plan))}
                  emptyNote="No users yet"
                />
              </ChartCard>

              <ChartCard
                title="Verified email"
                hint="Unverified accounts cannot receive password resets."
              >
                <Donut
                  slices={[
                    { key: "v", label: "Verified", value: data.users.verified },
                    {
                      key: "u",
                      label: "Unverified",
                      value: data.users.total - data.users.verified,
                    },
                  ]}
                  centerValue={String(data.users.total)}
                  centerLabel="accounts"
                />
              </ChartCard>
            </div>
          </section>

          {/* ---- Revenue ---- */}
          <section>
            <h2 className="eyebrow mb-2">Subscriptions</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile
                value={money(data.revenue.mrr_cents)}
                label="MRR"
                sub="active + trialing"
                tone="good"
              />
              <StatTile value={String(data.revenue.paying)} label="Paying users" />
              <StatTile
                value={`${data.revenue.conversion_pct}%`}
                label="Conversion"
                sub="of all accounts"
              />
              <StatTile
                value={`${data.revenue.churn_pct}%`}
                label="Churn"
                sub={`over ${data.days} days`}
                tone={data.revenue.churn_pct > 5 ? "bad" : "ink"}
              />
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard
                title="New subscriptions per day"
                hint="From the billing ledger. History begins when the ledger was added — earlier subscriptions are not in this line."
              >
                <AreaChart
                  points={toPoints(data.revenue.new_series, "subscription")}
                  color={SERIES[4]}
                  min={0}
                />
              </ChartCard>

              <ChartCard
                title="Cancellations per day"
                hint={`${data.revenue.payment_failed} failed payment(s) in this window — those precede churn.`}
              >
                <AreaChart
                  points={toPoints(data.revenue.canceled_series, "cancellation")}
                  color={SERIES[3]}
                  min={0}
                />
              </ChartCard>
            </div>

            <div className="mt-3">
              <ChartCard
                title="Subscription status"
                hint="What Stripe currently says about every subscription we mirror."
              >
                <Donut
                  slices={Object.entries(data.revenue.by_status).map(([status, n]) => ({
                    key: status,
                    label: status,
                    value: n,
                  }))}
                  centerValue={String(
                    Object.values(data.revenue.by_status).reduce((a, b) => a + b, 0)
                  )}
                  centerLabel="subscriptions"
                />
              </ChartCard>
            </div>
          </section>

          {/* ---- Engagement ---- */}
          <section>
            <h2 className="eyebrow mb-2">Engagement</h2>
            <div className="grid gap-3 lg:grid-cols-3">
              {/* Sits beside two charts with months of history. Without this
                  note the short series reads as a collapse in engagement
                  rather than as a metric that only started recently. */}
              <ChartCard
                title="Daily active users"
                hint="Distinct users seen each day. Starts when activity tracking was added — earlier days are absent, not zero."
              >
                <AreaChart
                  points={toPoints(data.engagement.active_series, "user")}
                  color={SERIES[1]}
                  min={0}
                  height={140}
                />
              </ChartCard>
              <ChartCard title="Games imported" hint="Into user libraries.">
                <AreaChart
                  points={toPoints(data.engagement.games_series, "game")}
                  color={SERIES[2]}
                  min={0}
                  height={140}
                />
              </ChartCard>
              <ChartCard title="Engine jobs" hint="Analyses and game reviews queued.">
                <AreaChart
                  points={toPoints(data.engagement.jobs_series, "job")}
                  color={SERIES[5]}
                  min={0}
                  height={140}
                />
              </ChartCard>
            </div>
          </section>

          {/* ---- System ---- */}
          {stats && (
            <section>
              <h2 className="eyebrow mb-2">System</h2>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                <StatTile
                  value={String(stats.jobs_queued)}
                  label="Jobs queued"
                  tone={stats.jobs_queued > 20 ? "bad" : "ink"}
                />
                <StatTile value={String(stats.jobs_running)} label="Jobs running" />
                <StatTile
                  value={String(stats.jobs_failed_7d)}
                  label="Failed 7d"
                  tone={stats.jobs_failed_7d > 0 ? "bad" : "ink"}
                />
                <StatTile
                  value={`${Math.round(stats.engine_seconds_7d / 3600)}h`}
                  label="Engine time 7d"
                />
                <StatTile
                  value={stats.cache_positions.toLocaleString()}
                  label="Cached positions"
                />
                <StatTile value={`${stats.db_size_mb} MB`} label="Database" />
              </div>
            </section>
          )}
        </div>
      )}
    </AdminShell>
  );
}
