import { fetchDailyBars } from "@/lib/alpaca";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type WindowKey = "1h" | "6h" | "12h" | "24h" | "7d";

const WINDOWS: Record<WindowKey, { label: string; hours: number }> = {
  "1h": { label: "Last 1 hour", hours: 1 },
  "6h": { label: "Last 6 hours", hours: 6 },
  "12h": { label: "Last 12 hours", hours: 12 },
  "24h": { label: "Last 24 hours", hours: 24 },
  "7d": { label: "Last 7 days", hours: 168 }
};

function windowKey(input?: string | null): WindowKey {
  if (input === "1h" || input === "6h" || input === "12h" || input === "24h" || input === "7d") return input;
  return "24h";
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "$0.00";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedPct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0.00%";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

async function ensurePerformanceTables() {
  await ensureRavenTables();
  const sql = db();

  await sql`
    create table if not exists paper_shadow_trades (
      id bigserial primary key,
      scored_signal_id bigint unique references scored_signals(id) on delete cascade,
      accession_number text,
      ticker text not null,
      action text not null,
      direction text not null default 'neutral',
      final_score integer not null default 0,
      entry_price numeric,
      current_price numeric,
      pnl_percent numeric,
      status text not null default 'active_shadow',
      reason text not null,
      raw_payload jsonb not null default '{}'::jsonb,
      entry_at timestamptz not null default now(),
      last_checked_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`alter table paper_shadow_trades add column if not exists scored_signal_id bigint`;
  await sql`alter table paper_shadow_trades add column if not exists accession_number text`;
  await sql`alter table paper_shadow_trades add column if not exists ticker text`;
  await sql`alter table paper_shadow_trades add column if not exists action text`;
  await sql`alter table paper_shadow_trades add column if not exists direction text not null default 'neutral'`;
  await sql`alter table paper_shadow_trades add column if not exists final_score integer not null default 0`;
  await sql`alter table paper_shadow_trades add column if not exists entry_price numeric`;
  await sql`alter table paper_shadow_trades add column if not exists current_price numeric`;
  await sql`alter table paper_shadow_trades add column if not exists pnl_percent numeric`;
  await sql`alter table paper_shadow_trades add column if not exists status text not null default 'active_shadow'`;
  await sql`alter table paper_shadow_trades add column if not exists reason text not null default 'near miss candidate'`;
  await sql`alter table paper_shadow_trades add column if not exists raw_payload jsonb not null default '{}'::jsonb`;
  await sql`alter table paper_shadow_trades add column if not exists entry_at timestamptz not null default now()`;
  await sql`alter table paper_shadow_trades add column if not exists last_checked_at timestamptz not null default now()`;
  await sql`alter table paper_shadow_trades add column if not exists created_at timestamptz not null default now()`;
  await sql`alter table paper_shadow_trades add column if not exists updated_at timestamptz not null default now()`;

  await sql`
    create index if not exists paper_shadow_trades_status_created_idx
    on paper_shadow_trades (status, created_at desc)
  `;

  await sql`
    create index if not exists paper_shadow_trades_ticker_created_idx
    on paper_shadow_trades (ticker, created_at desc)
  `;
}

function isShadowEligible(row: { final_score: number; action: string; direction: string; category: string; risk_level: string }) {
  const action = row.action.toLowerCase();
  const category = row.category.toLowerCase();
  const direction = row.direction.toLowerCase();

  if (row.final_score < 55) return false;
  if (!["high_watch", "watch_only", "paper_trade_candidate"].includes(action)) return false;
  if (["dilution_watch", "shelf_watch", "danger_watch", "late_filing_risk", "avoid", "ignore"].includes(action)) return false;
  if (category.includes("dilution") || category.includes("offering") || category.includes("shelf")) return false;
  if (direction === "bearish") return false;
  return true;
}

async function latestCloseForTicker(ticker: string): Promise<number | null> {
  try {
    const bars = await fetchDailyBars(ticker);
    return asNumber(bars.at(-1)?.c);
  } catch {
    return null;
  }
}

export async function syncShadowTrades(limit = 25) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      reviewed: 0,
      created: 0,
      updated: 0,
      active: 0,
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensurePerformanceTables();
  const sql = db();
  const rows = await sql<Array<{
    id: number;
    accession_number: string;
    ticker: string;
    action: string;
    direction: string;
    category: string;
    risk_level: string;
    final_score: number;
    readable_summary: string;
    raw_payload: Record<string, unknown>;
    created_at: string;
  }>>`
    select
      id,
      accession_number,
      ticker,
      action,
      direction,
      category,
      risk_level,
      final_score,
      readable_summary,
      raw_payload,
      created_at::text as created_at
    from scored_signals
    where created_at >= now() - interval '7 days'
    order by created_at desc
    limit ${limit}
  `;

  let created = 0;
  let updated = 0;
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const row of rows) {
    if (!isShadowEligible(row)) continue;
    const market = (row.raw_payload?.market || {}) as Record<string, unknown>;
    const entryPrice = asNumber(market.latestClose);
    if (!entryPrice || entryPrice <= 0) continue;
    const currentPrice = await latestCloseForTicker(row.ticker) || entryPrice;
    const pnlPercent = entryPrice > 0 ? round(((currentPrice - entryPrice) / entryPrice) * 100, 2) : 0;

    try {
      const inserted = await sql<Array<{ inserted: boolean }>>`
        insert into paper_shadow_trades (
          scored_signal_id,
          accession_number,
          ticker,
          action,
          direction,
          final_score,
          entry_price,
          current_price,
          pnl_percent,
          status,
          reason,
          raw_payload,
          entry_at,
          last_checked_at
        ) values (
          ${row.id},
          ${row.accession_number},
          ${row.ticker},
          ${row.action},
          ${row.direction},
          ${row.final_score},
          ${entryPrice},
          ${currentPrice},
          ${pnlPercent},
          'active_shadow',
          ${row.readable_summary},
          ${JSON.stringify({ category: row.category, riskLevel: row.risk_level, original: row.raw_payload })}::jsonb,
          ${row.created_at},
          now()
        )
        on conflict (scored_signal_id) do update set
          current_price = excluded.current_price,
          pnl_percent = excluded.pnl_percent,
          last_checked_at = now(),
          updated_at = now()
        returning (xmax = 0) as inserted
      `;

      if (inserted[0]?.inserted) created += 1;
      else updated += 1;
    } catch (error) {
      errors.push({ ticker: row.ticker, error: error instanceof Error ? error.message : "Unknown shadow sync failure" });
    }
  }

  const active = await sql<Array<{ count: number }>>`
    select count(*)::int as count
    from paper_shadow_trades
    where status = 'active_shadow'
  `;

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    reviewed: rows.length,
    created,
    updated,
    active: active[0]?.count || 0,
    errors
  };
}

function countList(items: string[]) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
}

export async function getPerformanceSnapshot(inputWindow?: string | null) {
  const key = windowKey(inputWindow);
  const window = WINDOWS[key];

  if (!hasDatabase()) {
    return {
      ok: false,
      phase: "RAVEN_PERFORMANCE",
      window: key,
      windowLabel: window.label,
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  const shadowSync = await syncShadowTrades().catch((error) => ({
    ok: false,
    database: "configured" as const,
    reviewed: 0,
    created: 0,
    updated: 0,
    active: 0,
    errors: [{ error: error instanceof Error ? error.message : "Unknown shadow sync failure" }]
  }));

  await ensurePerformanceTables();
  const sql = db();
  const hours = window.hours;

  const runRows = await sql<Array<{
    runs: number;
    failed_runs: number;
    steps_failed: number;
    sec_filings_found: number;
    ai_classified: number;
    alpaca_confirmed: number;
    signals_scored: number;
    paper_trades_opened: number;
    paper_trades_closed: number;
    paper_trades_rejected: number;
  }>>`
    select
      count(*)::int as runs,
      count(*) filter (where status <> 'completed')::int as failed_runs,
      coalesce(sum(steps_failed), 0)::int as steps_failed,
      coalesce(sum(sec_filings_found), 0)::int as sec_filings_found,
      coalesce(sum(ai_classified), 0)::int as ai_classified,
      coalesce(sum(alpaca_confirmed), 0)::int as alpaca_confirmed,
      coalesce(sum(signals_scored), 0)::int as signals_scored,
      coalesce(sum(paper_trades_opened), 0)::int as paper_trades_opened,
      coalesce(sum(paper_trades_closed), 0)::int as paper_trades_closed,
      coalesce(sum(paper_trades_rejected), 0)::int as paper_trades_rejected
    from pipeline_runs
    where created_at >= now() - (${hours}::int * interval '1 hour')
  `;

  const signalRows = await sql<Array<{ count: number }>>`
    select count(*)::int as count
    from signal_events
    where created_at >= now() - (${hours}::int * interval '1 hour')
  `;

  const scoredRows = await sql<Array<{ count: number }>>`
    select count(*)::int as count
    from scored_signals
    where created_at >= now() - (${hours}::int * interval '1 hour')
  `;

  const orderRows = await sql<Array<{ status: string; count: number }>>`
    select status, count(*)::int as count
    from paper_order_submissions
    where created_at >= now() - (${hours}::int * interval '1 hour')
    group by status
    order by count desc
  `;

  const lifecycleRows = await sql<Array<{ status: string; count: number }>>`
    select status, count(*)::int as count
    from paper_position_lifecycle
    where created_at >= now() - (${hours}::int * interval '1 hour') or updated_at >= now() - (${hours}::int * interval '1 hour')
    group by status
    order by count desc
  `;

  const shadowRows = await sql<Array<{
    id: number;
    ticker: string;
    final_score: number;
    action: string;
    entry_price: string | null;
    current_price: string | null;
    pnl_percent: string | null;
    reason: string;
    created_at: string;
  }>>`
    select
      id,
      ticker,
      final_score,
      action,
      entry_price::text,
      current_price::text,
      pnl_percent::text,
      reason,
      created_at::text
    from paper_shadow_trades
    where created_at >= now() - (${hours}::int * interval '1 hour')
    order by coalesce(pnl_percent, 0) desc, created_at desc
    limit 20
  `;

  const rejectRows = await sql<Array<{ reject_codes: unknown; ticker: string; final_score: number; action: string; created_at: string }>>`
    select reject_codes, ticker, final_score, action, created_at::text as created_at
    from paper_trade_decisions
    where created_at >= now() - (${hours}::int * interval '1 hour')
      and decision = 'reject'
    order by created_at desc
    limit 100
  `;

  const topTickers = await sql<Array<{ ticker: string; count: number }>>`
    select ticker, count(*)::int as count
    from signal_events
    where created_at >= now() - (${hours}::int * interval '1 hour')
      and ticker is not null
    group by ticker
    order by count desc
    limit 8
  `;

  const topSources = await sql<Array<{ source: string; count: number }>>`
    select source, count(*)::int as count
    from signal_events
    where created_at >= now() - (${hours}::int * interval '1 hour')
    group by source
    order by count desc
    limit 8
  `;

  const orderCounts = Object.fromEntries(orderRows.map((row) => [row.status, row.count]));
  const lifecycleCounts = Object.fromEntries(lifecycleRows.map((row) => [row.status, row.count]));
  const rejectCodes = rejectRows.flatMap((row) => {
    if (Array.isArray(row.reject_codes)) return row.reject_codes.map(String);
    if (typeof row.reject_codes === "string") {
      try {
        const parsed = JSON.parse(row.reject_codes);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    }
    return [];
  });

  const shadows = shadowRows.map((row) => ({
    id: row.id,
    ticker: row.ticker,
    finalScore: row.final_score,
    action: row.action,
    entryPrice: asNumber(row.entry_price),
    currentPrice: asNumber(row.current_price),
    pnlPercent: asNumber(row.pnl_percent) || 0,
    reason: row.reason,
    createdAt: row.created_at
  }));

  const avgShadowPnl = shadows.length ? round(shadows.reduce((sum, item) => sum + item.pnlPercent, 0) / shadows.length, 2) : 0;
  const bestShadow = shadows[0] || null;
  const worstShadow = shadows.length ? [...shadows].sort((a, b) => a.pnlPercent - b.pnlPercent)[0] : null;

  return {
    ok: true,
    phase: "RAVEN_PERFORMANCE",
    window: key,
    windowLabel: window.label,
    generatedAt: new Date().toISOString(),
    shadowSync,
    runs: runRows[0] || {},
    signals: {
      visibleEvents: signalRows[0]?.count || 0,
      scored: scoredRows[0]?.count || 0
    },
    orders: {
      submitted: num(orderCounts.submitted),
      filled: num(orderCounts.filled),
      rejected: num(orderCounts.rejected),
      error: num(orderCounts.error),
      byStatus: orderCounts
    },
    lifecycle: {
      open: num(lifecycleCounts.open),
      pendingEntry: num(lifecycleCounts.pending_entry),
      pendingExit: num(lifecycleCounts.pending_exit),
      closed: num(lifecycleCounts.closed),
      byStatus: lifecycleCounts
    },
    rejects: {
      count: rejectRows.length,
      topReasons: countList(rejectCodes)
    },
    radar: {
      topTickers,
      topSources
    },
    shadows: {
      count: shadows.length,
      avgPnlPercent: avgShadowPnl,
      best: bestShadow,
      worst: worstShadow,
      items: shadows.slice(0, 8)
    },
    errors: [
      ...(Array.isArray(shadowSync.errors) ? shadowSync.errors : [])
    ]
  };
}

export function buildPerformanceReport(snapshot: Awaited<ReturnType<typeof getPerformanceSnapshot>>) {
  if (!snapshot.ok) {
    return `RAVEN PERFORMANCE REPORT\n========================\nStatus: needs attention\nWindow: ${snapshot.windowLabel}\n\nERRORS\n------\n${JSON.stringify(snapshot.errors || [])}\n`;
  }

  const runs = snapshot.runs as Record<string, unknown>;
  const orders = snapshot.orders || { submitted: 0, filled: 0, rejected: 0, error: 0, byStatus: {} };
  const lifecycle = snapshot.lifecycle || { open: 0, pendingEntry: 0, pendingExit: 0, closed: 0, byStatus: {} };
  const rejects = snapshot.rejects || { count: 0, topReasons: [] };
  const radar = snapshot.radar || { topTickers: [], topSources: [] };
  const shadows = snapshot.shadows || { count: 0, avgPnlPercent: 0, best: null, worst: null, items: [] };
  const shadowItems = shadows.items || [];
  const lines = [
    "RAVEN PERFORMANCE REPORT",
    "========================",
    `Status: ok`,
    `Window: ${snapshot.windowLabel}`,
    `Generated: ${snapshot.generatedAt}`,
    "",
    "OPERATOR READ",
    "-------------",
    orders.submitted > 0
      ? `Raven submitted ${orders.submitted} paper order(s) in this window.`
      : shadows.count > 0
        ? `No paper orders submitted. Raven tracked ${shadows.count} near-miss shadow candidate(s) so we can judge whether the gates are too strict.`
        : `No paper orders submitted and no shadow candidates qualified in this window. Keep collecting data before loosening gates.`,
    "",
    "RUNS",
    "----",
    `Runs completed: ${num(runs.runs)}`,
    `Failed runs: ${num(runs.failed_runs)}`,
    `Steps failed: ${num(runs.steps_failed)}`,
    `SEC filings scanned: ${num(runs.sec_filings_found)}`,
    `AI classified: ${num(runs.ai_classified)}`,
    `Alpaca confirmations: ${num(runs.alpaca_confirmed)}`,
    `Signals scored: ${num(runs.signals_scored)}`,
    "",
    "PAPER TRADING",
    "-------------",
    `Paper orders submitted: ${orders.submitted}`,
    `Lifecycle open: ${lifecycle.open}`,
    `Lifecycle pending entries: ${lifecycle.pendingEntry}`,
    `Lifecycle pending exits: ${lifecycle.pendingExit}`,
    `Lifecycle closed: ${lifecycle.closed}`,
    `Rejected candidates: ${rejects.count}`,
    "",
    "SHADOW TRADES",
    "-------------",
    `Shadow candidates: ${shadows.count}`,
    `Average shadow P/L: ${signedPct(shadows.avgPnlPercent)}`,
    shadows.best ? `Best shadow: ${shadows.best.ticker} ${signedPct(shadows.best.pnlPercent)} | score ${shadows.best.finalScore}` : "Best shadow: none",
    shadows.worst ? `Worst shadow: ${shadows.worst.ticker} ${signedPct(shadows.worst.pnlPercent)} | score ${shadows.worst.finalScore}` : "Worst shadow: none",
    ...shadowItems.slice(0, 5).map((item) => `- ${item.ticker} | ${signedPct(item.pnlPercent)} | score ${item.finalScore} | ${item.action} | entry ${money(item.entryPrice)} current ${money(item.currentPrice)}`),
    "",
    "TOP REJECT REASONS",
    "------------------",
    ...(rejects.topReasons.length ? rejects.topReasons.map((item) => `- ${item.name}: ${item.count}`) : ["None"]),
    "",
    "MOST ACTIVE TICKERS",
    "-------------------",
    ...(radar.topTickers.length ? radar.topTickers.map((item) => `- ${item.ticker}: ${item.count}`) : ["None"]),
    "",
    "SOURCE ACTIVITY",
    "---------------",
    ...(radar.topSources.length ? radar.topSources.map((item) => `- ${item.source}: ${item.count}`) : ["None"]),
    "",
    "COPY NOTE",
    "---------",
    "Paste this report into ChatGPT when you want Raven performance/tuning help."
  ];

  return `${lines.join("\n")}\n`;
}

export const performanceWindows = WINDOWS;
