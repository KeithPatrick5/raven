import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { watchlist } from "@/lib/watchlist";

export type RadarTicker = {
  id: number;
  ticker: string;
  source: string;
  reason: string;
  score: number;
  status: string;
  first_seen: string;
  last_seen: string;
  expires_at: string | null;
  evidence: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

const CORE_TICKERS = new Set(watchlist.map((item) => item.symbol));

type SignalEventRadarRow = {
  ticker: string;
  source: string;
  headline: string;
  confidence: number;
  action: string;
  priority: string;
  materiality: string;
  event_type: string;
  event_time: string | null;
  created_at: string;
};

function asEvidence(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function cleanTicker(value: unknown) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
}

function sourceLabel(source: string) {
  if (source === "FED_REG") return "FED REG";
  return source;
}

function buildReason(events: Array<{ source: string; headline: string; confidence: number; action: string }>) {
  const top = events
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((event) => `${sourceLabel(event.source)}: ${event.headline}`);

  return top.join(" | ").slice(0, 900) || "Active Raven signal cluster.";
}

export async function syncRadarFromSignalEvents(limit = 250) {
  if (!hasDatabase()) {
    return { ok: false, database: "not_configured" as const, upserted: 0, radarCount: 0, errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }] };
  }

  await ensureRavenTables();
  const sql = db();

  const rows = await sql<Array<SignalEventRadarRow>>`
    select
      upper(ticker) as ticker,
      source,
      headline,
      confidence,
      action,
      priority,
      materiality,
      event_type,
      event_time::text as event_time,
      created_at::text as created_at
    from signal_events
    where ticker is not null
      and ticker <> ''
      and created_at >= now() - interval '14 days'
      and action <> 'ignore'
      and status <> 'ignored'
    order by confidence desc, created_at desc
    limit ${limit}
  `;

  const byTicker = new Map<string, SignalEventRadarRow[]>();
  for (const row of rows) {
    const ticker = cleanTicker(row.ticker);
    if (!ticker) continue;
    const list = byTicker.get(ticker) || [];
    list.push({ ...row, ticker });
    byTicker.set(ticker, list);
  }

  let upserted = 0;

  for (const [ticker, events] of byTicker.entries()) {
    const sources = Array.from(new Set(events.map((event) => event.source))).sort();
    const maxConfidence = Math.max(...events.map((event) => Number(event.confidence) || 0));
    const materialCount = events.filter((event) => event.materiality === "material" || event.materiality === "possibly_material").length;
    const highPriorityCount = events.filter((event) => event.priority === "critical" || event.priority === "high").length;
    const score = Math.max(0, Math.min(100, Math.round(maxConfidence + Math.min(20, sources.length * 5) + Math.min(10, materialCount * 2) + Math.min(10, highPriorityCount * 3))));

    if (score < 50) continue;

    const best = events.slice().sort((a, b) => b.confidence - a.confidence)[0];
    const evidence = {
      coreWatchlist: CORE_TICKERS.has(ticker),
      sourceCount: sources.length,
      eventCount: events.length,
      sources,
      strongestSource: best?.source || "unknown",
      strongestConfidence: maxConfidence,
      bestEvents: events
        .slice()
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5)
        .map((event) => ({
          source: event.source,
          headline: event.headline,
          confidence: event.confidence,
          action: event.action,
          priority: event.priority,
          materiality: event.materiality,
          eventType: event.event_type,
          createdAt: event.created_at
        }))
    };

    await sql`
      insert into radar_tickers (
        ticker,
        source,
        reason,
        score,
        status,
        first_seen,
        last_seen,
        expires_at,
        evidence
      ) values (
        ${ticker},
        ${sources.join(",") || "signal_events"},
        ${buildReason(events)},
        ${score},
        ${CORE_TICKERS.has(ticker) ? "core_radar" : "active_radar"},
        now(),
        now(),
        now() + interval '72 hours',
        ${JSON.stringify(evidence)}::jsonb
      )
      on conflict (ticker) do update set
        source = excluded.source,
        reason = excluded.reason,
        score = excluded.score,
        status = case
          when radar_tickers.status = 'ignored' then radar_tickers.status
          else excluded.status
        end,
        last_seen = now(),
        expires_at = excluded.expires_at,
        evidence = excluded.evidence,
        updated_at = now()
    `;

    upserted += 1;
  }

  await sql`
    update radar_tickers
    set status = 'expired', updated_at = now()
    where status in ('active_radar', 'core_radar')
      and expires_at is not null
      and expires_at < now()
  `;

  const countRows = await sql<Array<{ count: number }>>`
    select count(*)::int as count
    from radar_tickers
    where status in ('active_radar', 'core_radar')
  `;

  return { ok: true, database: "configured" as const, scannedEvents: rows.length, upserted, radarCount: countRows[0]?.count || 0, errors: [] };
}

export async function getActiveRadarTickers(limit = 12): Promise<RadarTicker[]> {
  if (!hasDatabase()) return [];
  await ensureRavenTables();
  const sql = db();

  const rows = await sql<Array<RadarTicker>>`
    select
      id,
      ticker,
      source,
      reason,
      score,
      status,
      first_seen::text as first_seen,
      last_seen::text as last_seen,
      expires_at::text as expires_at,
      evidence,
      created_at::text as created_at,
      updated_at::text as updated_at
    from radar_tickers
    where status in ('active_radar', 'core_radar')
    order by score desc, last_seen desc
    limit ${limit}
  `;

  return rows.map((row) => ({ ...row, evidence: asEvidence(row.evidence) }));
}

export async function getRadarSnapshot(limit = 12) {
  const sync = await syncRadarFromSignalEvents().catch((error) => ({ ok: false, database: hasDatabase() ? "configured" : "not_configured", upserted: 0, radarCount: 0, errors: [{ error: error instanceof Error ? error.message : "Unknown radar sync failure" }] }));
  const radar = await getActiveRadarTickers(limit).catch(() => []);

  return {
    ok: Boolean(sync.ok),
    phase: "RADAR_FOUNDATION",
    mode: "watchlist_plus_radar",
    coreWatchlist: watchlist.map((item) => ({ ticker: item.symbol, focus: item.focus, status: item.status })),
    sync,
    radarCount: radar.length,
    radar
  };
}
