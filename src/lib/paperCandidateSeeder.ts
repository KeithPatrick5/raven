import { fetchDailyBars } from "@/lib/alpaca";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type CandidateRankingSeedRow = {
  source: string;
  source_event_id: string;
  ticker: string;
  event_type: string;
  headline: string;
  summary: string;
  source_url: string | null;
  event_time: string | null;
  source_confidence: number;
  source_action: string;
  source_direction: string;
  tier: string;
  event_quality_score: number;
  trade_bias: string;
  ranking_reason: string;
  raw_payload: unknown;
  latest_close: string | null;
  previous_close: string | null;
  price_change_percent: string | null;
  latest_volume: string | null;
  relative_volume: string | null;
  liquidity_status: string | null;
  anomaly_status: string | null;
};

type MarketAnomalySeedRow = {
  ticker: string;
  latest_close: string | null;
  previous_close: string | null;
  latest_volume: string | null;
  relative_volume: string | null;
  price_change_percent: string | null;
  anomaly_score: number;
  anomaly_status: string;
  direction: string;
  liquidity_status: string | null;
  latest_bar_time: string | null;
  reasons: unknown;
  raw_payload: unknown;
};

type SeedInput = {
  source: string;
  sourceId: string;
  ticker: string;
  form: string;
  direction: string;
  category: string;
  action: string;
  headline: string;
  summary: string;
  score: number;
  eventTime: string | null;
  sourceUrl: string | null;
  latestClose: number | string | null;
  previousClose: number | string | null;
  priceChangePercent: number | string | null;
  latestVolume: number | string | null;
  relativeVolume: number | string | null;
  liquidityStatus: string | null;
  priceStatus: string | null;
  confirmationStatus: string;
  reasons: string[];
  rawPayload: unknown;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function clampScore(value: unknown) {
  const parsed = asNumber(value) ?? 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function cleanTicker(value: string) {
  return value.toUpperCase().replace(/[^A-Z]/g, "");
}

function safeTicker(value: string) {
  return /^[A-Z]{1,5}$/.test(cleanTicker(value));
}

function isDangerAction(action: string) {
  return ["dilution_watch", "shelf_watch", "late_filing_risk", "danger_watch", "avoid"].includes(action.toLowerCase());
}

function normalizeDirection(value: string | null | undefined) {
  const text = (value || "").toLowerCase();
  if (text === "bearish") return "bearish";
  if (text === "bullish") return "bullish";
  if (text === "mixed") return "mixed";
  return "neutral";
}

function paperAction(score: number, action: string) {
  if (isDangerAction(action)) return action;
  return score >= 35 ? "paper_trade_candidate" : "watch_only";
}

function accession(source: string, sourceId: string, ticker: string) {
  const cleanSource = source.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 24);
  const cleanSourceId = sourceId.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  return `paper:${cleanSource}:${ticker}:${cleanSourceId}`.slice(0, 180);
}

async function latestDailyBar(ticker: string) {
  try {
    const bars = await fetchDailyBars(ticker);
    const latest = bars.at(-1);
    const previous = bars.at(-2);
    return {
      latestClose: asNumber(latest?.c),
      previousClose: asNumber(previous?.c),
      latestVolume: asNumber(latest?.v),
      latestBarTime: latest?.t || null
    };
  } catch {
    return { latestClose: null, previousClose: null, latestVolume: null, latestBarTime: null };
  }
}

async function seedOne(input: SeedInput) {
  const sql = db();
  const ticker = cleanTicker(input.ticker);
  const score = clampScore(input.score);
  const syntheticAccession = accession(input.source, input.sourceId, ticker);
  const latestFromInput = asNumber(input.latestClose);
  const previousFromInput = asNumber(input.previousClose);
  const bar = latestFromInput === null ? await latestDailyBar(ticker) : { latestClose: latestFromInput, previousClose: previousFromInput, latestVolume: asNumber(input.latestVolume), latestBarTime: null };
  const latestClose = latestFromInput ?? bar.latestClose;
  const previousClose = previousFromInput ?? bar.previousClose;
  const latestVolume = asNumber(input.latestVolume) ?? bar.latestVolume;
  const priceChangePercent = asNumber(input.priceChangePercent) ?? (latestClose !== null && previousClose !== null && previousClose > 0 ? ((latestClose - previousClose) / previousClose) * 100 : null);
  const relativeVolume = asNumber(input.relativeVolume);
  const sourceUrl = input.sourceUrl || "https://raven.local/paper-candidate";
  const sourceDate = input.eventTime ? input.eventTime.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const action = paperAction(score, input.action);
  const direction = normalizeDirection(input.direction) === "bearish" ? "bearish" : normalizeDirection(input.direction);
  const summary = input.summary || input.headline || `${ticker} paper-mode candidate.`;
  const rawPayload = {
    seededFrom: input.source,
    sourceId: input.sourceId,
    sourceAction: input.action,
    headline: input.headline,
    reasons: input.reasons,
    originalPayload: input.rawPayload,
    note: "Synthetic scored signal created so paper mode can test ranked candidates and market anomalies instead of starving the trade engine."
  };

  const raw = await sql<{ id: number }[]>`
    insert into raw_sec_filings (
      ticker,
      cik,
      accession_number,
      form,
      filing_date,
      report_date,
      primary_document,
      primary_document_url,
      source_url,
      raw_payload
    ) values (
      ${ticker},
      '0000000000',
      ${syntheticAccession},
      ${input.form},
      ${sourceDate},
      ${sourceDate},
      ${sourceUrl},
      ${sourceUrl},
      ${sourceUrl},
      ${JSON.stringify(rawPayload)}::jsonb
    )
    on conflict (accession_number) do update set
      ticker = excluded.ticker,
      form = excluded.form,
      filing_date = excluded.filing_date,
      report_date = excluded.report_date,
      primary_document_url = excluded.primary_document_url,
      source_url = excluded.source_url,
      raw_payload = excluded.raw_payload
    returning id
  `;
  const rawId = raw[0]?.id;
  if (!rawId) throw new Error(`Could not seed raw filing for ${ticker}`);

  const summaryRows = await sql<{ id: number }[]>`
    insert into sec_filing_summaries (
      raw_filing_id,
      accession_number,
      ticker,
      form,
      filing_date,
      classifier_model,
      direction,
      category,
      risk_level,
      tradeability,
      summary,
      bull_case,
      bear_case,
      verdict,
      confirmation_needed,
      avoid_if,
      raw_ai
    ) values (
      ${rawId},
      ${syntheticAccession},
      ${ticker},
      ${input.form},
      ${sourceDate},
      'raven-paper-open-mode',
      ${direction},
      ${input.category},
      'medium',
      ${score},
      ${summary},
      ${input.headline || summary},
      'Paper-mode test candidate. Live trading remains disabled.',
      ${action === "paper_trade_candidate" ? "paper_trade_candidate" : "watch"},
      ${JSON.stringify(["paper mode outcome data"])}::jsonb,
      ${JSON.stringify(isDangerAction(input.action) ? ["danger action"] : [])}::jsonb,
      ${JSON.stringify(rawPayload)}::jsonb
    )
    on conflict (accession_number) do update set
      raw_filing_id = excluded.raw_filing_id,
      ticker = excluded.ticker,
      form = excluded.form,
      direction = excluded.direction,
      category = excluded.category,
      risk_level = excluded.risk_level,
      tradeability = excluded.tradeability,
      summary = excluded.summary,
      bull_case = excluded.bull_case,
      bear_case = excluded.bear_case,
      verdict = excluded.verdict,
      raw_ai = excluded.raw_ai
    returning id
  `;
  const summaryId = summaryRows[0]?.id;
  if (!summaryId) throw new Error(`Could not seed summary for ${ticker}`);

  const confirmationRows = await sql<{ id: number }[]>`
    insert into alpaca_market_confirmations (
      summary_id,
      accession_number,
      ticker,
      latest_close,
      previous_close,
      price_change_percent,
      latest_volume,
      avg_20d_volume,
      relative_volume,
      latest_bar_time,
      liquidity_status,
      price_status,
      confirmation_status,
      raw_payload
    ) values (
      ${summaryId},
      ${syntheticAccession},
      ${ticker},
      ${latestClose},
      ${previousClose},
      ${priceChangePercent},
      ${latestVolume},
      null,
      ${relativeVolume},
      ${bar.latestBarTime},
      ${input.liquidityStatus || "unknown"},
      ${input.priceStatus || "watch"},
      ${input.confirmationStatus || "watch"},
      ${JSON.stringify(rawPayload)}::jsonb
    )
    on conflict (summary_id) do update set
      latest_close = excluded.latest_close,
      previous_close = excluded.previous_close,
      price_change_percent = excluded.price_change_percent,
      latest_volume = excluded.latest_volume,
      relative_volume = excluded.relative_volume,
      latest_bar_time = excluded.latest_bar_time,
      liquidity_status = excluded.liquidity_status,
      price_status = excluded.price_status,
      confirmation_status = excluded.confirmation_status,
      raw_payload = excluded.raw_payload
    returning id
  `;
  const confirmationId = confirmationRows[0]?.id ?? null;

  const scored = await sql<{ id: number }[]>`
    insert into scored_signals (
      summary_id,
      confirmation_id,
      accession_number,
      ticker,
      form,
      filing_date,
      direction,
      category,
      risk_level,
      ai_tradeability,
      market_confirmation,
      final_score,
      action,
      readable_summary,
      reason_codes,
      risk_flags,
      raw_payload
    ) values (
      ${summaryId},
      ${confirmationId},
      ${syntheticAccession},
      ${ticker},
      ${input.form},
      ${sourceDate},
      ${direction},
      ${input.category},
      'medium',
      ${score},
      ${input.confirmationStatus || "watch"},
      ${score},
      ${action},
      ${summary},
      ${JSON.stringify(input.reasons)}::jsonb,
      ${JSON.stringify(isDangerAction(input.action) ? ["danger_action"] : [])}::jsonb,
      ${JSON.stringify(rawPayload)}::jsonb
    )
    on conflict (summary_id) do update set
      confirmation_id = excluded.confirmation_id,
      direction = excluded.direction,
      category = excluded.category,
      risk_level = excluded.risk_level,
      ai_tradeability = excluded.ai_tradeability,
      market_confirmation = excluded.market_confirmation,
      final_score = excluded.final_score,
      action = excluded.action,
      readable_summary = excluded.readable_summary,
      reason_codes = excluded.reason_codes,
      risk_flags = excluded.risk_flags,
      raw_payload = excluded.raw_payload
    returning id
  `;

  return {
    ticker,
    accessionNumber: syntheticAccession,
    score,
    action,
    latestClose,
    scoredSignalId: scored[0]?.id || null
  };
}

async function getCandidateRankingSeeds(limit: number): Promise<SeedInput[]> {
  const sql = db();
  const rows = await sql<CandidateRankingSeedRow[]>`
    select
      cr.source,
      cr.source_event_id,
      cr.ticker,
      cr.event_type,
      cr.headline,
      cr.summary,
      cr.source_url,
      cr.event_time::text as event_time,
      cr.source_confidence,
      cr.source_action,
      cr.source_direction,
      cr.tier,
      cr.event_quality_score,
      cr.trade_bias,
      cr.ranking_reason,
      cr.raw_payload,
      ma.latest_close::text,
      ma.previous_close::text,
      ma.price_change_percent::text,
      ma.latest_volume::text,
      ma.relative_volume::text,
      ma.liquidity_status,
      ma.anomaly_status
    from candidate_rankings cr
    left join market_anomalies ma on ma.ticker = cr.ticker
    where cr.status = 'active'
      and cr.updated_at >= now() - interval '14 days'
      and cr.tier in ('tier_1', 'tier_2')
      and coalesce(cr.trade_bias, cr.source_direction, 'neutral') <> 'bearish'
      and cr.source_action not in ('dilution_watch', 'shelf_watch', 'late_filing_risk', 'danger_watch', 'avoid')
    order by
      case cr.tier when 'tier_1' then 1 when 'tier_2' then 2 else 3 end,
      cr.event_quality_score desc,
      ma.anomaly_score desc nulls last,
      cr.updated_at desc
    limit ${limit}
  `;

  return rows
    .filter((row: CandidateRankingSeedRow) => safeTicker(row.ticker))
    .map((row: CandidateRankingSeedRow) => ({
      source: `candidate_${row.source}`,
      sourceId: row.source_event_id,
      ticker: row.ticker,
      form: row.event_type || "CANDIDATE",
      direction: row.trade_bias || row.source_direction || "neutral",
      category: row.event_type || "ranked_candidate",
      action: row.source_action || "watch_only",
      headline: row.headline,
      summary: `${row.headline} ${row.ranking_reason ? `Reason: ${row.ranking_reason}` : ""}`.trim(),
      score: Math.max(clampScore(row.event_quality_score), clampScore(row.source_confidence)),
      eventTime: row.event_time,
      sourceUrl: row.source_url,
      latestClose: row.latest_close,
      previousClose: row.previous_close,
      priceChangePercent: row.price_change_percent,
      latestVolume: row.latest_volume,
      relativeVolume: row.relative_volume,
      liquidityStatus: row.liquidity_status,
      priceStatus: row.anomaly_status || "watch",
      confirmationStatus: row.latest_close ? "watch" : "unconfirmed",
      reasons: [row.ranking_reason, `Candidate tier ${row.tier}`, `Event quality ${row.event_quality_score}/100`].filter(Boolean),
      rawPayload: row.raw_payload
    }));
}

async function getMarketAnomalySeeds(limit: number): Promise<SeedInput[]> {
  const sql = db();
  const rows = await sql<MarketAnomalySeedRow[]>`
    select
      ticker,
      latest_close::text,
      previous_close::text,
      latest_volume::text,
      relative_volume::text,
      price_change_percent::text,
      anomaly_score,
      anomaly_status,
      direction,
      liquidity_status,
      latest_bar_time::text as latest_bar_time,
      reasons,
      raw_payload
    from market_anomalies
    where updated_at >= now() - interval '7 days'
      and anomaly_score >= 35
      and direction <> 'bearish'
    order by anomaly_score desc, updated_at desc
    limit ${limit}
  `;

  return rows
    .filter((row: MarketAnomalySeedRow) => safeTicker(row.ticker))
    .map((row: MarketAnomalySeedRow) => ({
      source: "market_anomaly",
      sourceId: `${row.ticker}:${row.latest_bar_time || "latest"}`,
      ticker: row.ticker,
      form: "MARKET_ANOMALY",
      direction: row.direction || "neutral",
      category: "market_anomaly",
      action: "market_anomaly_watch",
      headline: `${row.ticker} market anomaly ${row.anomaly_score}/100`,
      summary: `${row.ticker} shows ${row.anomaly_status} with ${row.price_change_percent || "?"}% price move and ${row.relative_volume || "?"}x relative volume.`,
      score: row.anomaly_score,
      eventTime: row.latest_bar_time,
      sourceUrl: null,
      latestClose: row.latest_close,
      previousClose: row.previous_close,
      priceChangePercent: row.price_change_percent,
      latestVolume: row.latest_volume,
      relativeVolume: row.relative_volume,
      liquidityStatus: row.liquidity_status,
      priceStatus: row.anomaly_status,
      confirmationStatus: row.anomaly_score >= 55 ? "confirmed" : "watch",
      reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
      rawPayload: row.raw_payload
    }));
}

export async function seedPaperTradeCandidates(limit = 16) {
  const startedAt = new Date().toISOString();
  if (!hasDatabase()) {
    return { ok: false, phase: "PAPER_CANDIDATE_SEEDER", database: "not_configured" as const, reviewed: 0, seeded: 0, candidates: [], errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }] };
  }

  await ensureRavenTables();
  const candidateSeeds = await getCandidateRankingSeeds(limit);
  const anomalySeeds = await getMarketAnomalySeeds(limit);
  const dedupedByTicker = new Map<string, SeedInput>();

  for (const seed of [...candidateSeeds, ...anomalySeeds]) {
    const ticker = cleanTicker(seed.ticker);
    const current = dedupedByTicker.get(ticker);
    if (!current) {
      dedupedByTicker.set(ticker, seed);
      continue;
    }

    const currentScore = clampScore(current.score);
    const seedScore = clampScore(seed.score);
    const seedIsMarketAnomaly = seed.source === "market_anomaly";
    const currentIsMarketAnomaly = current.source === "market_anomaly";

    if (seedScore > currentScore || (seedScore === currentScore && seedIsMarketAnomaly && !currentIsMarketAnomaly)) {
      dedupedByTicker.set(ticker, seed);
    }
  }

  const seeds = Array.from(dedupedByTicker.values()).slice(0, limit);
  const candidates: Array<Record<string, unknown>> = [];
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const seed of seeds) {
    try {
      const result = await seedOne(seed);
      candidates.push(result);
    } catch (error) {
      errors.push({ ticker: seed.ticker, error: error instanceof Error ? error.message : "Unknown paper candidate seed failure" });
    }
  }

  return {
    ok: errors.length === 0,
    phase: "PAPER_CANDIDATE_SEEDER",
    startedAt,
    finishedAt: new Date().toISOString(),
    database: "configured" as const,
    reviewed: seeds.length,
    seeded: candidates.length,
    candidates,
    errors
  };
}
