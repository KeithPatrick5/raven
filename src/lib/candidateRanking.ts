import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

export type CandidateTier = "tier_1" | "tier_2" | "tier_3" | "risk_only" | "ignore";

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function asText(value: unknown) {
  return String(value || "").toLowerCase();
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function cleanSummary(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function classifyEventQuality(input: {
  source: string;
  eventType: string;
  action: string;
  direction: string;
  headline: string;
  summary: string;
  confidence: number;
}): { tier: CandidateTier; eventQualityScore: number; tradeBias: "bullish" | "bearish" | "neutral" | "mixed"; reason: string } {
  const source = input.source.toUpperCase();
  const eventType = input.eventType.toUpperCase();
  const action = asText(input.action);
  const direction = asText(input.direction);
  const text = `${input.headline} ${input.summary} ${input.action} ${input.eventType}`.toLowerCase();
  const confidence = Math.max(0, Math.min(100, input.confidence || 0));

  if (
    action.includes("dilution") ||
    action.includes("shelf") ||
    action.includes("late_filing") ||
    action.includes("danger") ||
    eventType.includes("424B5") ||
    eventType === "S-3" ||
    eventType === "NT 10-Q" ||
    eventType === "NT 10-K" ||
    includesAny(text, ["offering", "shelf registration", "dilution", "late filing"])
  ) {
    return { tier: "risk_only", eventQualityScore: Math.max(65, confidence), tradeBias: "bearish", reason: "Risk-only SEC or dilution/offering event. Useful warning, not a long entry by itself." };
  }

  if (eventType.includes("13D") || action.includes("activist")) {
    return { tier: "tier_1", eventQualityScore: Math.max(86, confidence), tradeBias: "bullish", reason: "Schedule 13D or activist ownership event." };
  }

  if (source === "SEC" && eventType === "4" && includesAny(text, ["open-market", "open market", "purchased", "purchase"]) && !includesAny(text, ["tax", "10b5-1", "withholding", "rsu", "restricted stock unit"])) {
    return { tier: "tier_1", eventQualityScore: Math.max(82, confidence), tradeBias: "bullish", reason: "Possible real open-market insider buy." };
  }

  if (eventType === "8-K" && includesAny(text, ["material", "agreement", "contract", "award", "merger", "guidance", "fda", "approval", "litigation", "auditor", "going concern"])) {
    const bearish = includesAny(text, ["going concern", "default", "termination", "resignation", "investigation"]);
    return { tier: "tier_1", eventQualityScore: Math.max(78, confidence), tradeBias: bearish ? "bearish" : "bullish", reason: "Material 8-K style catalyst." };
  }

  if (source === "FDA" && includesAny(text, ["approval", "warning", "class i", "serious", "recall", "enforcement"])) {
    return { tier: "tier_1", eventQualityScore: Math.max(76, confidence), tradeBias: direction === "bearish" ? "bearish" : "mixed", reason: "Direct FDA or healthcare regulatory catalyst." };
  }

  if (eventType.includes("13G") || action.includes("ownership")) {
    return { tier: "tier_2", eventQualityScore: Math.max(62, confidence), tradeBias: "neutral", reason: "Passive ownership context. Needs market confirmation." };
  }

  if (source === "FINRA" && confidence >= 58) {
    return { tier: "tier_2", eventQualityScore: confidence, tradeBias: "mixed", reason: "Short-volume pressure signal. Needs price confirmation." };
  }

  if (source === "NEWS" && confidence >= 62 && !includesAny(text, ["what's going on", "this week", "roundup", "etf", "portfolio"])) {
    return { tier: "tier_2", eventQualityScore: confidence, tradeBias: direction === "bearish" ? "bearish" : direction === "bullish" ? "bullish" : "neutral", reason: "Direct news catalyst with enough confidence to confirm another signal." };
  }

  if (source === "FED_REG" && confidence >= 60) {
    return { tier: "tier_2", eventQualityScore: Math.min(72, confidence), tradeBias: "neutral", reason: "Regulatory context with direct ticker/sector relevance." };
  }

  if (eventType === "10-Q" || eventType === "10-K" || eventType === "4" || includesAny(text, ["tax withholding", "10b5-1", "rsu", "restricted stock unit", "generic", "roundup"])) {
    return { tier: "tier_3", eventQualityScore: Math.min(45, confidence), tradeBias: "neutral", reason: "Routine filing or broad context. Usually not worth AI/trading unless market confirms." };
  }

  const fallbackTier: CandidateTier = confidence >= 65 ? "tier_2" : confidence >= 45 ? "tier_3" : "ignore";
  return { tier: fallbackTier, eventQualityScore: confidence, tradeBias: direction === "bullish" || direction === "bearish" ? direction : "neutral", reason: "Generic ranked candidate." };
}

async function ensureCandidateRankingTable() {
  if (!hasDatabase()) return;
  await ensureRavenTables();
  const sql = db();
  await sql`
    create table if not exists candidate_rankings (
      id bigserial primary key,
      source text not null,
      source_event_id text not null,
      signal_event_id bigint,
      ticker text not null,
      event_type text not null,
      headline text not null,
      summary text not null,
      source_url text,
      event_time timestamptz,
      source_confidence integer not null default 0,
      source_action text not null default 'watch',
      source_direction text not null default 'neutral',
      tier text not null default 'tier_3',
      event_quality_score integer not null default 0,
      trade_bias text not null default 'neutral',
      ranking_reason text not null default '',
      status text not null default 'active',
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(source, source_event_id)
    )
  `;
  await sql`create index if not exists candidate_rankings_tier_score_idx on candidate_rankings (tier, event_quality_score desc, updated_at desc)`;
  await sql`create index if not exists candidate_rankings_ticker_updated_idx on candidate_rankings (ticker, updated_at desc)`;
}

export async function rankSignalCandidates(limit = 80) {
  const startedAt = new Date().toISOString();
  if (!hasDatabase()) {
    return { ok: false, phase: "CANDIDATE_RANKING", database: "not_configured" as const, reviewed: 0, upserted: 0, tiers: {}, topCandidates: [], errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }] };
  }
  await ensureCandidateRankingTable();
  const sql = db();
  const events = await sql<Array<{
    id: number;
    source: string;
    source_event_id: string;
    ticker: string | null;
    event_type: string;
    headline: string;
    summary: string;
    source_url: string | null;
    event_time: string | null;
    confidence: number;
    action: string;
    direction: string;
    metadata: Record<string, unknown>;
  }>>`
    select id, source, source_event_id, ticker, event_type, headline, summary, source_url, event_time::text as event_time,
      confidence, action, direction, metadata
    from signal_events
    where ticker is not null
      and coalesce(updated_at, created_at) >= now() - interval '14 days'
    order by coalesce(updated_at, created_at) desc, confidence desc
    limit ${limit}
  `;

  let upserted = 0;
  const tierCounts: Record<string, number> = {};
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const event of events) {
    try {
      const ranked = classifyEventQuality({
        source: event.source,
        eventType: event.event_type,
        action: event.action,
        direction: event.direction,
        headline: event.headline,
        summary: event.summary,
        confidence: num(event.confidence)
      });
      tierCounts[ranked.tier] = (tierCounts[ranked.tier] || 0) + 1;
      await sql`
        insert into candidate_rankings (
          source, source_event_id, signal_event_id, ticker, event_type, headline, summary, source_url, event_time,
          source_confidence, source_action, source_direction, tier, event_quality_score, trade_bias, ranking_reason, raw_payload, updated_at
        ) values (
          ${event.source}, ${event.source_event_id}, ${event.id}, ${event.ticker}, ${event.event_type}, ${event.headline}, ${event.summary}, ${event.source_url}, ${event.event_time},
          ${event.confidence}, ${event.action}, ${event.direction}, ${ranked.tier}, ${ranked.eventQualityScore}, ${ranked.tradeBias}, ${ranked.reason}, ${JSON.stringify({ metadata: event.metadata })}::jsonb, now()
        )
        on conflict (source, source_event_id) do update set
          signal_event_id = excluded.signal_event_id,
          ticker = excluded.ticker,
          event_type = excluded.event_type,
          headline = excluded.headline,
          summary = excluded.summary,
          source_url = excluded.source_url,
          event_time = excluded.event_time,
          source_confidence = excluded.source_confidence,
          source_action = excluded.source_action,
          source_direction = excluded.source_direction,
          tier = excluded.tier,
          event_quality_score = excluded.event_quality_score,
          trade_bias = excluded.trade_bias,
          ranking_reason = excluded.ranking_reason,
          raw_payload = excluded.raw_payload,
          updated_at = now()
      `;
      upserted += 1;
    } catch (error) {
      errors.push({ ticker: event.ticker || undefined, error: error instanceof Error ? error.message : "Unknown candidate ranking error" });
    }
  }

  const topRows = await sql<Array<{
    ticker: string;
    source: string;
    tier: string;
    event_quality_score: number;
    trade_bias: string;
    source_action: string;
    headline: string;
    ranking_reason: string;
  }>>`
    select ticker, source, tier, event_quality_score, trade_bias, source_action, headline, ranking_reason
    from candidate_rankings
    where status = 'active'
      and tier <> 'ignore'
      and updated_at >= now() - interval '14 days'
    order by
      case tier when 'tier_1' then 1 when 'tier_2' then 2 when 'risk_only' then 3 when 'tier_3' then 4 else 5 end asc,
      case source when 'SEC_DISCOVERY' then 1 when 'SEC' then 2 when 'FDA' then 3 when 'FINRA' then 4 when 'FED_REG' then 5 when 'NEWS' then 6 else 7 end asc,
      event_quality_score desc,
      updated_at desc
    limit 12
  `;
  const topCandidates = topRows.map((row) => ({
    ticker: row.ticker,
    source: row.source,
    tier: row.tier,
    eventQualityScore: row.event_quality_score,
    tradeBias: row.trade_bias,
    action: row.source_action,
    headline: cleanSummary(row.headline),
    reason: row.ranking_reason
  }));

  return {
    ok: errors.length === 0,
    phase: "CANDIDATE_RANKING",
    startedAt,
    finishedAt: new Date().toISOString(),
    database: "configured" as const,
    reviewed: events.length,
    upserted,
    tiers: tierCounts,
    topCandidates,
    errors
  };
}

export async function getCandidateRankingReport(limit = 12) {
  const result = await rankSignalCandidates(100);
  const lines = [
    "RAVEN CANDIDATE RANKING",
    "=========================",
    `Status: ${result.ok ? "ok" : "needs_attention"}`,
    `Reviewed: ${result.reviewed}`,
    `Updated: ${result.upserted}`,
    "",
    "TIERS",
    "-----",
    `Tier 1: ${Number((result.tiers as Record<string, number>).tier_1 || 0)}`,
    `Tier 2: ${Number((result.tiers as Record<string, number>).tier_2 || 0)}`,
    `Tier 3: ${Number((result.tiers as Record<string, number>).tier_3 || 0)}`,
    `Risk-only: ${Number((result.tiers as Record<string, number>).risk_only || 0)}`,
    `Ignore: ${Number((result.tiers as Record<string, number>).ignore || 0)}`,
    "",
    "TOP RANKED TRADE / RISK CANDIDATES",
    "----------------------------------"
  ];
  if (!result.topCandidates.length) lines.push("None");
  for (const item of result.topCandidates.slice(0, limit)) {
    lines.push(`- ${item.ticker} | ${item.source} | ${item.tier} | ${item.eventQualityScore}/100 | ${item.tradeBias} | ${item.headline}`);
    lines.push(`  ${item.reason}`);
  }
  lines.push("", "COPY NOTE", "---------", "Paste this report into ChatGPT when tuning candidate quality.");
  return `${lines.join("\n")}\n`;
}
