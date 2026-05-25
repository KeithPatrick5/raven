import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type RouteRow = {
  ranking_id: number;
  source: string;
  source_event_id: string;
  ticker: string;
  tier: string;
  event_quality_score: number;
  trade_bias: string;
  headline: string;
  ranking_reason: string;
  form: string | null;
  accession_number: string | null;
  cik: string | null;
  company_name: string | null;
  filing_date: string | null;
  filing_url: string | null;
  priority: string | null;
  priority_score: number | null;
  materiality: string | null;
  form_family: string | null;
  anomaly_score: number | null;
  anomaly_status: string | null;
  market_direction: string | null;
};

function mapPriority(tier: string, score: number) {
  if (tier === "tier_1" || score >= 80) return "high";
  if (tier === "tier_2" || score >= 60) return "medium";
  return "low";
}

function shouldRoute(row: RouteRow) {
  if (row.tier === "risk_only" || row.tier === "ignore") return false;
  if (!row.accession_number || !row.cik || !row.filing_url || !row.form) return false;
  const form = row.form.toUpperCase();
  if (["424B5", "S-3", "S-1", "NT 10-Q", "NT 10-K"].includes(form)) return false;
  if (row.tier === "tier_1") return true;
  if ((row.anomaly_score || 0) >= 45) return true;
  return row.event_quality_score >= 72;
}


async function getRoutableCandidates(sql: ReturnType<typeof db>) {
  return sql<RouteRow[]>`
    select
      c.id as ranking_id,
      c.source,
      c.source_event_id,
      c.ticker,
      c.tier,
      c.event_quality_score,
      c.trade_bias,
      c.headline,
      c.ranking_reason,
      d.form,
      d.accession_number,
      d.cik,
      d.company_name,
      d.filing_date::text as filing_date,
      d.filing_url,
      d.priority,
      d.priority_score,
      d.materiality,
      d.form_family,
      m.anomaly_score,
      m.anomaly_status,
      m.direction as market_direction
    from candidate_rankings c
    left join raw_sec_discovery_filings d
      on d.accession_number = c.source_event_id
    left join raw_sec_filings r
      on r.accession_number = c.source_event_id
    left join sec_filing_summaries s
      on s.accession_number = c.source_event_id
    left join market_anomalies m
      on m.ticker = c.ticker
    where c.source = 'SEC_DISCOVERY'
      and r.id is null
      and s.id is null
      and c.tier in ('tier_1', 'tier_2')
    order by
      case
        when coalesce(m.anomaly_score, 0) >= 70 and m.direction = 'bullish' then 0
        when c.tier = 'tier_1' then 1
        when c.tier = 'tier_2' then 2
        else 3
      end asc,
      coalesce(m.anomaly_score, 0) desc,
      c.event_quality_score desc,
      c.updated_at desc
    limit 20
  `;
}

async function getPendingWatchlistCount(sql: ReturnType<typeof db>) {
  const pendingWatchlist = await sql<Array<{ count: number }>>`
    select count(*)::integer as count
    from raw_sec_filings r
    left join sec_filing_summaries s on s.raw_filing_id = r.id
    where s.id is null
  `;
  return Number(pendingWatchlist[0]?.count || 0);
}

export async function routeBestCandidatesToAi(limit = 1) {
  const startedAt = new Date().toISOString();
  if (!hasDatabase()) {
    return { ok: false, phase: "AI_BUDGET_ROUTER", database: "not_configured" as const, pendingWatchlistFilings: 0, reviewed: 0, routed: 0, skipped: 0, reason: "database_not_configured", routedCandidates: [], errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }] };
  }

  await ensureRavenTables();
  const sql = db();

  const pendingWatchlistFilings = await getPendingWatchlistCount(sql);
  if (pendingWatchlistFilings > 0) {
    return { ok: true, phase: "AI_BUDGET_ROUTER", database: "configured" as const, pendingWatchlistFilings, reviewed: 0, routed: 0, skipped: 0, reason: "watchlist_sec_pending_first", routedCandidates: [], errors: [] };
  }

  const candidates = await getRoutableCandidates(sql);

  let routed = 0;
  let skipped = 0;
  const routedCandidates: Array<Record<string, unknown>> = [];
  const errors: Array<{ ticker?: string; accessionNumber?: string; error: string }> = [];

  for (const candidate of candidates) {
    if (routed >= limit) break;
    if (!shouldRoute(candidate)) {
      skipped += 1;
      continue;
    }
    try {
      const priority = mapPriority(candidate.tier, candidate.event_quality_score);
      const selectedAt = new Date().toISOString();
      const priorityScore = Math.max(candidate.priority_score || 0, candidate.event_quality_score + Math.min(10, Math.round((candidate.anomaly_score || 0) / 10)));
      await sql`
        insert into raw_sec_filings (
          ticker, cik, accession_number, form, filing_date, report_date, primary_document, primary_document_url, source_url, raw_payload
        ) values (
          ${candidate.ticker},
          ${candidate.cik},
          ${candidate.accession_number},
          ${candidate.form},
          ${candidate.filing_date},
          ${candidate.filing_date},
          ${candidate.filing_url?.split('/').pop() || 'sec-discovery'},
          ${candidate.filing_url},
          ${candidate.filing_url},
          ${JSON.stringify({
            companyName: candidate.company_name,
            primaryDocDescription: `${candidate.form} routed by AI budget router`,
            ravenPriority: priority,
            ravenPriorityScore: Math.min(100, priorityScore),
            ravenMateriality: candidate.materiality || 'possibly_material',
            ravenFormFamily: candidate.form_family || 'sec_discovery',
            ravenSource: 'ai_budget_router',
            ravenRouterSelectedAt: selectedAt,
            ravenRoutedTicker: candidate.ticker,
            ravenRoutedAccessionNumber: candidate.accession_number,
            ravenCandidateTier: candidate.tier,
            ravenEventQualityScore: candidate.event_quality_score,
            ravenTradeBias: candidate.trade_bias,
            ravenRankingReason: candidate.ranking_reason,
            ravenMarketAnomalyScore: candidate.anomaly_score,
            ravenMarketAnomalyStatus: candidate.anomaly_status,
            ravenMarketDirection: candidate.market_direction
          })}::jsonb
        )
        on conflict (accession_number) do update set
          raw_payload = raw_sec_filings.raw_payload || excluded.raw_payload,
          primary_document_url = excluded.primary_document_url,
          source_url = excluded.source_url
      `;
      routed += 1;
      routedCandidates.push({ ticker: candidate.ticker, form: candidate.form, accessionNumber: candidate.accession_number, tier: candidate.tier, eventQualityScore: candidate.event_quality_score, marketAnomalyScore: candidate.anomaly_score, reason: candidate.ranking_reason });
    } catch (error) {
      errors.push({ ticker: candidate.ticker, accessionNumber: candidate.accession_number || undefined, error: error instanceof Error ? error.message : 'Unknown AI routing error' });
    }
  }

  return {
    ok: errors.length === 0,
    phase: "AI_BUDGET_ROUTER",
    startedAt,
    finishedAt: new Date().toISOString(),
    database: "configured" as const,
    pendingWatchlistFilings,
    reviewed: candidates.length,
    routed,
    skipped,
    reason: routed > 0 ? "routed_ranked_discovery_candidate" : "no_ranked_trade_candidate_survived_routing",
    routedCandidates,
    errors
  };
}

export async function getAiRouterReport() {
  if (!hasDatabase()) {
    return [
      "RAVEN AI BUDGET ROUTER",
      "======================",
      "Status: needs_attention",
      "Mode: preview_only_no_queue_mutation",
      "Database is not configured.",
      "",
      "COPY NOTE",
      "---------",
      "Paste this report into ChatGPT when tuning Groq routing."
    ].join("\n") + "\n";
  }

  await ensureRavenTables();
  const sql = db();
  const pendingWatchlistFilings = await getPendingWatchlistCount(sql);
  const candidates = pendingWatchlistFilings > 0 ? [] : await getRoutableCandidates(sql);
  const eligibleCandidates = candidates.filter(shouldRoute);
  const routedCandidates = eligibleCandidates.slice(0, 5).map((candidate) => ({
    ticker: candidate.ticker,
    form: candidate.form,
    accessionNumber: candidate.accession_number,
    tier: candidate.tier,
    eventQualityScore: candidate.event_quality_score,
    marketAnomalyScore: candidate.anomaly_score,
    reason: candidate.ranking_reason
  }));
  const reason = pendingWatchlistFilings > 0
    ? "watchlist_sec_pending_first"
    : routedCandidates.length > 0
      ? "would_route_ranked_discovery_candidate"
      : "no_ranked_trade_candidate_survived_routing";

  const lines = [
    "RAVEN AI BUDGET ROUTER",
    "======================",
    "Status: ok",
    "Mode: preview only, report does not add anything to the AI queue",
    `Pending watchlist filings: ${pendingWatchlistFilings}`,
    `Candidates reviewed: ${candidates.length}`,
    `Would route to AI queue: ${Math.min(1, routedCandidates.length)}`,
    `Skipped: ${Math.max(0, candidates.length - eligibleCandidates.length)}`,
    `Reason: ${reason}`,
    "",
    "ROUTABLE CANDIDATES",
    "-------------------"
  ];
  if (!routedCandidates.length) lines.push("None");
  for (const item of routedCandidates) {
    lines.push(`- ${item.ticker} | ${item.form} | ${item.tier} | event ${item.eventQualityScore}/100 | market ${item.marketAnomalyScore ?? "--"}/100 | ${item.reason}`);
  }
  lines.push("", "COPY NOTE", "---------", "Paste this report into ChatGPT when tuning Groq routing.");
  return `${lines.join("\n")}\n`;
}
