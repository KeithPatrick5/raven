import { fetchDailyBars, hasAlpacaProvider } from "@/lib/alpaca";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { watchlist } from "@/lib/watchlist";

type Bar = { c?: number; h?: number; l?: number; o?: number; t?: string; v?: number };

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round(value: number | null, decimals = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function avg(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function safeTicker(ticker: string) {
  return /^[A-Z]{1,5}$/.test(ticker.toUpperCase());
}

function anomalyStatus(score: number) {
  if (score >= 75) return "strong_anomaly";
  if (score >= 55) return "active_watch";
  if (score >= 35) return "normal_watch";
  return "quiet";
}

function analyzeBars(ticker: string, bars: Bar[]) {
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const latestClose = num(latest?.c);
  const previousClose = num(previous?.c);
  const latestOpen = num(latest?.o);
  const latestHigh = num(latest?.h);
  const latestLow = num(latest?.l);
  const latestVolume = num(latest?.v);
  const prior = bars.slice(-21, -1);
  const avg20Volume = avg(prior.map((bar) => num(bar.v)).filter((value): value is number => value !== null));
  const priorHigh = Math.max(...prior.map((bar) => num(bar.h)).filter((value): value is number => value !== null));
  const priorLow = Math.min(...prior.map((bar) => num(bar.l)).filter((value): value is number => value !== null));
  const priceChangePercent = latestClose !== null && previousClose !== null && previousClose > 0 ? ((latestClose - previousClose) / previousClose) * 100 : null;
  const intradayMovePercent = latestClose !== null && latestOpen !== null && latestOpen > 0 ? ((latestClose - latestOpen) / latestOpen) * 100 : null;
  const relativeVolume = latestVolume !== null && avg20Volume !== null && avg20Volume > 0 ? latestVolume / avg20Volume : null;
  const breaksHigh = latestClose !== null && Number.isFinite(priorHigh) && priorHigh > 0 && latestClose > priorHigh;
  const breaksLow = latestClose !== null && Number.isFinite(priorLow) && priorLow > 0 && latestClose < priorLow;

  let score = 0;
  const reasons: string[] = [];
  if (relativeVolume !== null) {
    if (relativeVolume >= 3) { score += 35; reasons.push(`Relative volume ${round(relativeVolume)}x is very high.`); }
    else if (relativeVolume >= 2) { score += 25; reasons.push(`Relative volume ${round(relativeVolume)}x is elevated.`); }
    else if (relativeVolume >= 1.5) { score += 15; reasons.push(`Relative volume ${round(relativeVolume)}x is active.`); }
  }
  if (priceChangePercent !== null) {
    if (Math.abs(priceChangePercent) >= 8) { score += 30; reasons.push(`Price move ${round(priceChangePercent)}% is large.`); }
    else if (Math.abs(priceChangePercent) >= 4) { score += 20; reasons.push(`Price move ${round(priceChangePercent)}% is notable.`); }
    else if (Math.abs(priceChangePercent) >= 2) { score += 10; reasons.push(`Price move ${round(priceChangePercent)}% is mild.`); }
  }
  if (breaksHigh) { score += 20; reasons.push("Price broke above the recent 20-day high."); }
  if (breaksLow) { score += 18; reasons.push("Price broke below the recent 20-day low."); }
  if (latestVolume !== null && latestVolume < 500_000) { score -= 12; reasons.push("Volume is thin, so Raven discounts the move."); }
  if (!reasons.length) reasons.push("No unusual price/volume behavior detected.");

  const direction = priceChangePercent === null ? "neutral" : priceChangePercent >= 2 ? "bullish" : priceChangePercent <= -2 ? "bearish" : "neutral";
  const liquidityStatus = latestVolume === null ? "unknown" : latestVolume < 500_000 ? "thin" : latestVolume > 2_000_000 ? "liquid" : "normal";

  return {
    ticker,
    latestClose: round(latestClose),
    previousClose: round(previousClose),
    latestOpen: round(latestOpen),
    latestHigh: round(latestHigh),
    latestLow: round(latestLow),
    latestVolume,
    avg20Volume: avg20Volume === null ? null : Math.round(avg20Volume),
    relativeVolume: round(relativeVolume),
    priceChangePercent: round(priceChangePercent),
    intradayMovePercent: round(intradayMovePercent),
    breaksHigh,
    breaksLow,
    anomalyScore: Math.max(0, Math.min(100, Math.round(score))),
    anomalyStatus: anomalyStatus(score),
    direction,
    liquidityStatus,
    latestBarTime: latest?.t || null,
    reasons,
    raw: { barCount: bars.length, latest, previous }
  };
}

async function ensureMarketAnomalyTable() {
  if (!hasDatabase()) return;
  await ensureRavenTables();
  const sql = db();
  await sql`
    create table if not exists market_anomalies (
      id bigserial primary key,
      ticker text not null unique,
      latest_close numeric,
      previous_close numeric,
      latest_volume bigint,
      avg_20d_volume bigint,
      relative_volume numeric,
      price_change_percent numeric,
      intraday_move_percent numeric,
      breaks_high boolean not null default false,
      breaks_low boolean not null default false,
      anomaly_score integer not null default 0,
      anomaly_status text not null default 'quiet',
      direction text not null default 'neutral',
      liquidity_status text not null default 'unknown',
      latest_bar_time timestamptz,
      reasons jsonb not null default '[]'::jsonb,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`create index if not exists market_anomalies_score_idx on market_anomalies (anomaly_score desc, updated_at desc)`;
}

async function getMarketScanTickers(limit: number) {
  const tickers = new Set(watchlist.map((item) => item.symbol.toUpperCase()).filter(safeTicker));
  if (hasDatabase()) {
    await ensureRavenTables();
    const sql = db();
    const rows = await sql<Array<{ ticker: string }>>`
      select ticker from radar_tickers
      where status in ('core_radar', 'active_radar')
      order by score desc, last_seen desc
      limit ${limit}
    `;
    for (const row of rows) {
      const ticker = row.ticker.toUpperCase().replace(/[^A-Z]/g, "");
      if (safeTicker(ticker)) tickers.add(ticker);
    }
  }
  return Array.from(tickers).slice(0, limit);
}

export async function scanMarketAnomalies(limit = 35) {
  const startedAt = new Date().toISOString();
  if (!hasAlpacaProvider()) {
    return { ok: false, phase: "MARKET_ANOMALY_SCANNER", alpaca: "not_configured" as const, scanned: 0, saved: 0, anomalies: [], errors: [{ error: "Alpaca API keys are not configured." }] };
  }
  if (!hasDatabase()) {
    return { ok: false, phase: "MARKET_ANOMALY_SCANNER", database: "not_configured" as const, scanned: 0, saved: 0, anomalies: [], errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }] };
  }

  await ensureMarketAnomalyTable();
  const sql = db();
  const tickers = await getMarketScanTickers(limit);
  let saved = 0;
  const anomalies: Array<Record<string, unknown>> = [];
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const ticker of tickers) {
    try {
      const bars = await fetchDailyBars(ticker);
      if (bars.length < 2) {
        errors.push({ ticker, error: "Not enough Alpaca bar data." });
        continue;
      }
      const item = analyzeBars(ticker, bars);
      await sql`
        insert into market_anomalies (
          ticker, latest_close, previous_close, latest_volume, avg_20d_volume, relative_volume, price_change_percent, intraday_move_percent,
          breaks_high, breaks_low, anomaly_score, anomaly_status, direction, liquidity_status, latest_bar_time, reasons, raw_payload, updated_at
        ) values (
          ${ticker}, ${item.latestClose}, ${item.previousClose}, ${item.latestVolume}, ${item.avg20Volume}, ${item.relativeVolume}, ${item.priceChangePercent}, ${item.intradayMovePercent},
          ${item.breaksHigh}, ${item.breaksLow}, ${item.anomalyScore}, ${item.anomalyStatus}, ${item.direction}, ${item.liquidityStatus}, ${item.latestBarTime}, ${JSON.stringify(item.reasons)}::jsonb, ${JSON.stringify(item.raw)}::jsonb, now()
        )
        on conflict (ticker) do update set
          latest_close = excluded.latest_close,
          previous_close = excluded.previous_close,
          latest_volume = excluded.latest_volume,
          avg_20d_volume = excluded.avg_20d_volume,
          relative_volume = excluded.relative_volume,
          price_change_percent = excluded.price_change_percent,
          intraday_move_percent = excluded.intraday_move_percent,
          breaks_high = excluded.breaks_high,
          breaks_low = excluded.breaks_low,
          anomaly_score = excluded.anomaly_score,
          anomaly_status = excluded.anomaly_status,
          direction = excluded.direction,
          liquidity_status = excluded.liquidity_status,
          latest_bar_time = excluded.latest_bar_time,
          reasons = excluded.reasons,
          raw_payload = excluded.raw_payload,
          updated_at = now()
      `;
      saved += 1;
      if (item.anomalyScore >= 35) anomalies.push(item);
    } catch (error) {
      errors.push({ ticker, error: error instanceof Error ? error.message : "Unknown market anomaly scan error" });
    }
  }

  anomalies.sort((a, b) => Number(b.anomalyScore || 0) - Number(a.anomalyScore || 0));

  return {
    ok: errors.length === 0 || saved > 0,
    phase: "MARKET_ANOMALY_SCANNER",
    startedAt,
    finishedAt: new Date().toISOString(),
    database: "configured" as const,
    alpaca: "configured" as const,
    scanned: tickers.length,
    saved,
    anomalyCount: anomalies.length,
    anomalies: anomalies.slice(0, 12),
    errors: errors.slice(0, 8)
  };
}

export async function getMarketAnomalyReport() {
  const result = await scanMarketAnomalies(35);
  const lines = [
    "RAVEN MARKET ANOMALIES",
    "=======================",
    `Status: ${result.ok ? "ok" : "needs_attention"}`,
    `Scanned: ${result.scanned}`,
    `Saved: ${result.saved}`,
    `Anomalies: ${result.anomalyCount || 0}`,
    "",
    "TOP MOVES",
    "---------"
  ];
  if (!result.anomalies.length) lines.push("None");
  for (const item of result.anomalies.slice(0, 10)) {
    lines.push(`- ${item.ticker} | score ${item.anomalyScore}/100 | ${item.direction} | move ${item.priceChangePercent ?? "--"}% | rel vol ${item.relativeVolume ?? "--"}x | ${item.anomalyStatus}`);
  }
  if (result.errors.length) {
    lines.push("", "WARNINGS", "--------");
    for (const error of result.errors.slice(0, 5) as Array<{ ticker?: string; error: string }>) lines.push(`- ${error.ticker || "?"}: ${error.error}`);
  }
  lines.push("", "COPY NOTE", "---------", "Paste this report into ChatGPT when tuning market confirmation.");
  return `${lines.join("\n")}\n`;
}
