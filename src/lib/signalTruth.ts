import { fetchDailyBars } from "@/lib/alpaca";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type TruthWindow = "24h" | "7d" | "30d" | "all";

export const signalTruthWindows: Record<TruthWindow, { label: string; interval: string | null }> = {
  "24h": { label: "Last 24 hours", interval: "24 hours" },
  "7d": { label: "Last 7 days", interval: "7 days" },
  "30d": { label: "Last 30 days", interval: "30 days" },
  all: { label: "All time", interval: null }
};

type OutcomeRow = {
  id: number;
  scored_signal_id: number;
  ticker: string;
  source_created_at: string;
  entry_price: string | null;
  latest_price: string | null;
  latest_return_percent: string | null;
  one_hour_return_percent: string | null;
  one_day_return_percent: string | null;
  three_day_return_percent: string | null;
  five_day_return_percent: string | null;
  max_favorable_return_percent: string | null;
  max_adverse_return_percent: string | null;
  status: string;
};

type BreakdownRow = {
  name: string;
  count: string;
  avg_latest_return: string | null;
  avg_one_day_return: string | null;
  avg_three_day_return: string | null;
  avg_five_day_return: string | null;
  wins: string;
  losses: string;
};

type LeaderRow = {
  ticker: string;
  source: string;
  action: string;
  final_score: number;
  latest_return_percent: string | null;
  one_day_return_percent: string | null;
  three_day_return_percent: string | null;
  five_day_return_percent: string | null;
  created_at: string;
};

function normalizeWindow(input?: string | null): TruthWindow {
  if (input === "24h" || input === "7d" || input === "30d" || input === "all") return input;
  return "7d";
}

function scoreBucket(score: number) {
  if (score >= 70) return "70+ candidate";
  if (score >= 55) return "55-69 watch";
  if (score >= 40) return "40-54 weak watch";
  return "0-39 ignore";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round(value: number | null, decimals = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function pctChange(latest: number | null, entry: number | null) {
  if (latest === null || entry === null || entry <= 0) return null;
  return round(((latest - entry) / entry) * 100, 2);
}

function windowFilterSql(window: TruthWindow) {
  const item = signalTruthWindows[window];
  if (!item.interval) return "";
  return `where created_at >= now() - interval '${item.interval}'`;
}

function sourceLabel(source: string | null) {
  if (!source) return "SEC";
  return source;
}

async function ensureSignalTruthSeeds(limit = 100) {
  const sql = db();
  const rows = await sql<Array<{
    id: number;
    accession_number: string;
    ticker: string;
    form: string | null;
    category: string | null;
    direction: string;
    action: string;
    final_score: number;
    market_confirmation: string | null;
    latest_close: string | null;
    source: string | null;
    created_at: string;
    raw_payload: unknown;
  }>>`
    select
      s.id,
      s.accession_number,
      s.ticker,
      s.form,
      s.category,
      s.direction,
      s.action,
      s.final_score,
      s.market_confirmation,
      c.latest_close::text as latest_close,
      e.source,
      s.created_at::text as created_at,
      s.raw_payload
    from scored_signals s
    left join alpaca_market_confirmations c on c.id = s.confirmation_id
    left join signal_events e on e.source_event_id = s.accession_number
    left join signal_outcomes o on o.scored_signal_id = s.id
    where o.id is null
    order by s.created_at desc
    limit ${limit}
  `;

  let created = 0;
  for (const row of rows) {
    const entryPrice = asNumber(row.latest_close) ?? asNumber((row.raw_payload as { market?: { latestClose?: unknown } } | null)?.market?.latestClose);
    await sql`
      insert into signal_outcomes (
        scored_signal_id,
        accession_number,
        ticker,
        source,
        form,
        category,
        direction,
        action,
        final_score,
        score_bucket,
        market_confirmation,
        entry_price,
        latest_price,
        latest_return_percent,
        source_created_at,
        raw_payload
      ) values (
        ${row.id},
        ${row.accession_number},
        ${row.ticker},
        ${sourceLabel(row.source)},
        ${row.form},
        ${row.category},
        ${row.direction},
        ${row.action},
        ${row.final_score},
        ${scoreBucket(row.final_score)},
        ${row.market_confirmation},
        ${entryPrice},
        ${entryPrice},
        0,
        ${row.created_at},
        ${JSON.stringify({ seededFrom: "scored_signals", originalPayload: row.raw_payload })}::jsonb
      )
      on conflict (scored_signal_id) do nothing
    `;
    created += 1;
  }

  return created;
}

async function latestCloseForTicker(ticker: string): Promise<number | null> {
  try {
    const bars = await fetchDailyBars(ticker);
    return asNumber(bars.at(-1)?.c);
  } catch {
    return null;
  }
}

export async function syncSignalTruthOutcomes(limit = 25) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      created: 0,
      updated: 0,
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const sql = db();
  const created = await ensureSignalTruthSeeds(100);
  const rows = await sql<OutcomeRow[]>`
    select
      id,
      scored_signal_id,
      ticker,
      source_created_at::text as source_created_at,
      entry_price::text,
      latest_price::text,
      latest_return_percent::text,
      one_hour_return_percent::text,
      one_day_return_percent::text,
      three_day_return_percent::text,
      five_day_return_percent::text,
      max_favorable_return_percent::text,
      max_adverse_return_percent::text,
      status
    from signal_outcomes
    where entry_price is not null
      and (
        last_checked_at is null
        or last_checked_at < now() - interval '45 minutes'
        or status = 'tracking'
      )
    order by source_created_at desc
    limit ${limit}
  `;

  let updated = 0;
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const row of rows) {
    try {
      const entryPrice = asNumber(row.entry_price);
      const latestPrice = await latestCloseForTicker(row.ticker);
      const latestReturn = pctChange(latestPrice, entryPrice);
      const ageMs = Date.now() - new Date(row.source_created_at).getTime();
      const ageHours = ageMs / 3_600_000;
      const existingReturns = [
        asNumber(row.latest_return_percent),
        asNumber(row.one_hour_return_percent),
        asNumber(row.one_day_return_percent),
        asNumber(row.three_day_return_percent),
        asNumber(row.five_day_return_percent),
        latestReturn
      ].filter((value): value is number => value !== null);
      const maxFavorable = existingReturns.length ? Math.max(...existingReturns) : null;
      const maxAdverse = existingReturns.length ? Math.min(...existingReturns) : null;
      const complete = ageHours >= 120;

      await sql`
        update signal_outcomes set
          latest_price = coalesce(${latestPrice}, latest_price),
          latest_return_percent = coalesce(${latestReturn}, latest_return_percent),
          one_hour_price = case when one_hour_price is null and ${ageHours} >= 1 then coalesce(${latestPrice}, one_hour_price) else one_hour_price end,
          one_hour_return_percent = case when one_hour_return_percent is null and ${ageHours} >= 1 then coalesce(${latestReturn}, one_hour_return_percent) else one_hour_return_percent end,
          one_day_price = case when one_day_price is null and ${ageHours} >= 24 then coalesce(${latestPrice}, one_day_price) else one_day_price end,
          one_day_return_percent = case when one_day_return_percent is null and ${ageHours} >= 24 then coalesce(${latestReturn}, one_day_return_percent) else one_day_return_percent end,
          three_day_price = case when three_day_price is null and ${ageHours} >= 72 then coalesce(${latestPrice}, three_day_price) else three_day_price end,
          three_day_return_percent = case when three_day_return_percent is null and ${ageHours} >= 72 then coalesce(${latestReturn}, three_day_return_percent) else three_day_return_percent end,
          five_day_price = case when five_day_price is null and ${ageHours} >= 120 then coalesce(${latestPrice}, five_day_price) else five_day_price end,
          five_day_return_percent = case when five_day_return_percent is null and ${ageHours} >= 120 then coalesce(${latestReturn}, five_day_return_percent) else five_day_return_percent end,
          max_favorable_return_percent = coalesce(${round(maxFavorable)}, max_favorable_return_percent),
          max_adverse_return_percent = coalesce(${round(maxAdverse)}, max_adverse_return_percent),
          status = case when ${complete} then 'complete_5d' else 'tracking' end,
          last_checked_at = now(),
          updated_at = now(),
          raw_payload = raw_payload || ${JSON.stringify({ lastSync: new Date().toISOString(), latestPrice, latestReturn, ageHours: round(ageHours, 2) })}::jsonb
        where id = ${row.id}
      `;
      updated += 1;
    } catch (error) {
      errors.push({ ticker: row.ticker, error: error instanceof Error ? error.message : "Unknown signal truth sync failure" });
    }
  }

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    created,
    updated,
    checked: rows.length,
    errors
  };
}

export async function getSignalTruthSnapshot(windowInput: string | null = "7d") {
  const window = normalizeWindow(windowInput);
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      window,
      label: signalTruthWindows[window].label,
      totals: { signals: 0, tracking: 0, complete: 0, avgLatestReturn: null, avgOneDayReturn: null, winRateLatest: null },
      bySource: [],
      byAction: [],
      byScoreBucket: [],
      leaders: [],
      laggards: [],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const sql = db();
  await ensureSignalTruthSeeds(100);
  const filter = windowFilterSql(window);

  const totals = await sql.unsafe(`
    select
      count(*)::text as signals,
      count(*) filter (where status = 'tracking')::text as tracking,
      count(*) filter (where status = 'complete_5d')::text as complete,
      avg(latest_return_percent)::text as avg_latest_return,
      avg(one_day_return_percent)::text as avg_one_day_return,
      avg(three_day_return_percent)::text as avg_three_day_return,
      avg(five_day_return_percent)::text as avg_five_day_return,
      count(*) filter (where latest_return_percent > 0)::text as wins_latest,
      count(*) filter (where latest_return_percent < 0)::text as losses_latest
    from signal_outcomes
    ${filter}
  `) as Array<{
    signals: string;
    tracking: string;
    complete: string;
    avg_latest_return: string | null;
    avg_one_day_return: string | null;
    avg_three_day_return: string | null;
    avg_five_day_return: string | null;
    wins_latest: string;
    losses_latest: string;
  }>;

  async function breakdown(column: "source" | "action" | "score_bucket") {
    return await sql.unsafe(`
      select
        ${column} as name,
        count(*)::text as count,
        avg(latest_return_percent)::text as avg_latest_return,
        avg(one_day_return_percent)::text as avg_one_day_return,
        avg(three_day_return_percent)::text as avg_three_day_return,
        avg(five_day_return_percent)::text as avg_five_day_return,
        count(*) filter (where latest_return_percent > 0)::text as wins,
        count(*) filter (where latest_return_percent < 0)::text as losses
      from signal_outcomes
      ${filter}
      group by ${column}
      order by count(*) desc, avg(latest_return_percent) desc nulls last
      limit 12
    `) as BreakdownRow[];
  }

  const leaders = await sql.unsafe(`
    select
      ticker,
      source,
      action,
      final_score,
      latest_return_percent::text,
      one_day_return_percent::text,
      three_day_return_percent::text,
      five_day_return_percent::text,
      created_at::text
    from signal_outcomes
    ${filter}
    order by latest_return_percent desc nulls last, final_score desc
    limit 8
  `) as LeaderRow[];

  const laggards = await sql.unsafe(`
    select
      ticker,
      source,
      action,
      final_score,
      latest_return_percent::text,
      one_day_return_percent::text,
      three_day_return_percent::text,
      five_day_return_percent::text,
      created_at::text
    from signal_outcomes
    ${filter}
    order by latest_return_percent asc nulls last, final_score desc
    limit 8
  `) as LeaderRow[];

  const total = totals[0] || { signals: "0", tracking: "0", complete: "0", avg_latest_return: null, avg_one_day_return: null, avg_three_day_return: null, avg_five_day_return: null, wins_latest: "0", losses_latest: "0" };
  const wins = Number(total.wins_latest || 0);
  const losses = Number(total.losses_latest || 0);

  return {
    ok: true,
    database: "configured" as const,
    window,
    label: signalTruthWindows[window].label,
    totals: {
      signals: Number(total.signals || 0),
      tracking: Number(total.tracking || 0),
      complete: Number(total.complete || 0),
      avgLatestReturn: round(asNumber(total.avg_latest_return)),
      avgOneDayReturn: round(asNumber(total.avg_one_day_return)),
      avgThreeDayReturn: round(asNumber(total.avg_three_day_return)),
      avgFiveDayReturn: round(asNumber(total.avg_five_day_return)),
      winsLatest: wins,
      lossesLatest: losses,
      winRateLatest: wins + losses > 0 ? round((wins / (wins + losses)) * 100, 1) : null
    },
    bySource: await breakdown("source"),
    byAction: await breakdown("action"),
    byScoreBucket: await breakdown("score_bucket"),
    leaders,
    laggards,
    notes: [
      "This is an outcome audit, not a live-trading signal.",
      "Outcome windows use the latest available Alpaca daily close snapshot during each cron sync.",
      "The point is to prove which signal types deserve more attention before adding more sources."
    ]
  };
}

function pct(value: string | number | null | undefined) {
  const n = asNumber(value);
  if (n === null) return "--";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function rowLine(row: BreakdownRow) {
  const wins = Number(row.wins || 0);
  const losses = Number(row.losses || 0);
  const rate = wins + losses > 0 ? `${round((wins / (wins + losses)) * 100, 1)}%` : "--";
  return `${row.name}: ${row.count} signals | latest ${pct(row.avg_latest_return)} | 1d ${pct(row.avg_one_day_return)} | 3d ${pct(row.avg_three_day_return)} | win rate ${rate}`;
}

export async function getSignalTruthReport(windowInput: string | null = "7d") {
  const snapshot = await getSignalTruthSnapshot(windowInput);
  if (!snapshot.ok) {
    return [
      "RAVEN SIGNAL TRUTH AUDIT",
      "=========================",
      "Database is not configured.",
      "Set DATABASE_URL or STORAGE_URL to enable outcome tracking."
    ].join("\n");
  }

  const lines = [
    "RAVEN SIGNAL TRUTH AUDIT",
    "=========================",
    `Window: ${snapshot.label}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "SUMMARY",
    "-------",
    `Signals tracked: ${snapshot.totals.signals}`,
    `Tracking: ${snapshot.totals.tracking}`,
    `Complete 5d: ${snapshot.totals.complete}`,
    `Average latest return: ${pct(snapshot.totals.avgLatestReturn)}`,
    `Average 1d return: ${pct(snapshot.totals.avgOneDayReturn)}`,
    `Average 3d return: ${pct(snapshot.totals.avgThreeDayReturn)}`,
    `Average 5d return: ${pct(snapshot.totals.avgFiveDayReturn)}`,
    `Latest win rate: ${snapshot.totals.winRateLatest === null ? "--" : `${snapshot.totals.winRateLatest}%`}`,
    "",
    "BY SOURCE",
    "---------",
    ...((snapshot.bySource as BreakdownRow[]).length ? (snapshot.bySource as BreakdownRow[]).map(rowLine) : ["No source breakdown yet."]),
    "",
    "BY ACTION",
    "---------",
    ...((snapshot.byAction as BreakdownRow[]).length ? (snapshot.byAction as BreakdownRow[]).map(rowLine) : ["No action breakdown yet."]),
    "",
    "BY SCORE BUCKET",
    "---------------",
    ...((snapshot.byScoreBucket as BreakdownRow[]).length ? (snapshot.byScoreBucket as BreakdownRow[]).map(rowLine) : ["No score bucket breakdown yet."]),
    "",
    "BEST LATEST MOVES",
    "-----------------",
    ...((snapshot.leaders as LeaderRow[]).length ? (snapshot.leaders as LeaderRow[]).map((row) => `${row.ticker} | ${row.source} | ${row.action} | score ${row.final_score} | latest ${pct(row.latest_return_percent)} | 1d ${pct(row.one_day_return_percent)}`) : ["No leaders yet."]),
    "",
    "WORST LATEST MOVES",
    "------------------",
    ...((snapshot.laggards as LeaderRow[]).length ? (snapshot.laggards as LeaderRow[]).map((row) => `${row.ticker} | ${row.source} | ${row.action} | score ${row.final_score} | latest ${pct(row.latest_return_percent)} | 1d ${pct(row.one_day_return_percent)}`) : ["No laggards yet."]),
    "",
    "NOTES",
    "-----",
    ...((snapshot.notes || []).map((note) => `- ${note}`))
  ];

  return lines.join("\n");
}
