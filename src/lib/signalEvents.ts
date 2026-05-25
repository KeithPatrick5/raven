import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { analyzeFilingPriority } from "@/lib/filingIntelligence";

export type SignalSource = "SEC" | "FINRA" | "FED_REG" | "FDA" | "CONGRESS" | "NEWS";

export type SignalEvent = {
  id: number;
  source: SignalSource | string;
  source_event_id: string;
  ticker: string | null;
  event_type: string;
  event_time: string | null;
  headline: string;
  summary: string;
  source_url: string | null;
  priority: string;
  materiality: string;
  direction: string;
  confidence: number;
  status: string;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type UpsertSecSignalEventInput = {
  scoredSignalId: number;
  accessionNumber: string;
  ticker: string;
  form: string;
  filingDate: string | null;
  category: string;
  direction: string;
  finalScore: number;
  action: string;
  summary: string;
  sourceUrl?: string | null;
  priority?: string | null;
  priorityScore?: number | null;
  materiality?: string | null;
  formFamily?: string | null;
  marketConfirmation?: string | null;
  riskLevel?: string | null;
};

type UpsertSignalEventInput = {
  source: SignalSource | string;
  sourceEventId: string;
  ticker?: string | null;
  eventType: string;
  eventTime?: string | null;
  headline: string;
  summary: string;
  sourceUrl?: string | null;
  priority?: string | null;
  materiality?: string | null;
  direction?: string | null;
  confidence?: number | null;
  status?: string | null;
  action?: string | null;
  metadata?: Record<string, unknown> | null;
};


function cleanLabel(value: string | null | undefined) {
  return (value || "unknown").split("_").join(" ");
}

function headlineForSecSignal(input: UpsertSecSignalEventInput) {
  const category = cleanLabel(input.category);
  return `${input.ticker} ${input.form}: ${category}`;
}

function statusForAction(action: string) {
  if (action === "paper_trade_candidate") return "trade_ready";
  if (action === "high_watch" || action === "watch_only") return "watch";
  if (action === "danger_watch" || action === "avoid") return "risk";
  return "ignored";
}


export async function upsertSignalEvent(input: UpsertSignalEventInput) {
  if (!hasDatabase()) return null;
  await ensureRavenTables();
  const sql = db();

  const confidence = Math.max(0, Math.min(100, Math.round(input.confidence || 0)));

  const rows = await sql<Array<{ id: number }>>`
    insert into signal_events (
      source,
      source_event_id,
      ticker,
      event_type,
      event_time,
      headline,
      summary,
      source_url,
      priority,
      materiality,
      direction,
      confidence,
      status,
      action,
      metadata
    ) values (
      ${input.source},
      ${input.sourceEventId},
      ${input.ticker || null},
      ${input.eventType},
      ${input.eventTime || null},
      ${input.headline},
      ${input.summary},
      ${input.sourceUrl || null},
      ${input.priority || "unknown"},
      ${input.materiality || "unknown"},
      ${input.direction || "neutral"},
      ${confidence},
      ${input.status || "new"},
      ${input.action || "watch"},
      ${JSON.stringify(input.metadata || {})}::jsonb
    )
    on conflict (source, source_event_id) do update set
      ticker = excluded.ticker,
      event_type = excluded.event_type,
      event_time = excluded.event_time,
      headline = excluded.headline,
      summary = excluded.summary,
      source_url = excluded.source_url,
      priority = excluded.priority,
      materiality = excluded.materiality,
      direction = excluded.direction,
      confidence = excluded.confidence,
      status = excluded.status,
      action = excluded.action,
      metadata = excluded.metadata,
      updated_at = now()
    returning id
  `;

  return rows[0] || null;
}

function secFallbackPriority(input: { form: string; priority?: string | null; materiality?: string | null; priorityScore?: number | null; formFamily?: string | null }) {
  if (input.priority && input.priority !== "unknown" && input.materiality && input.materiality !== "unknown") {
    return input;
  }

  const analyzed = analyzeFilingPriority({ form: input.form });
  return {
    ...input,
    priority: input.priority && input.priority !== "unknown" ? input.priority : analyzed.priority,
    priorityScore: input.priorityScore ?? analyzed.priorityScore,
    materiality: input.materiality && input.materiality !== "unknown" ? input.materiality : analyzed.materiality,
    formFamily: input.formFamily || analyzed.formFamily
  };
}

export async function upsertSecSignalEvent(input: UpsertSecSignalEventInput) {
  if (!hasDatabase()) return null;
  await ensureRavenTables();
  const sql = db();

  const enhanced = secFallbackPriority(input);

  const rows = await sql<Array<{ id: number }>>`
    insert into signal_events (
      source,
      source_event_id,
      ticker,
      event_type,
      event_time,
      headline,
      summary,
      source_url,
      priority,
      materiality,
      direction,
      confidence,
      status,
      action,
      metadata
    ) values (
      ${"SEC"},
      ${input.accessionNumber},
      ${input.ticker},
      ${input.form},
      ${input.filingDate},
      ${headlineForSecSignal(input)},
      ${input.summary},
      ${input.sourceUrl || null},
      ${enhanced.priority || "unknown"},
      ${enhanced.materiality || "unknown"},
      ${input.direction || "neutral"},
      ${input.finalScore},
      ${statusForAction(input.action)},
      ${input.action},
      ${JSON.stringify({
        scoredSignalId: input.scoredSignalId,
        category: input.category,
        priorityScore: enhanced.priorityScore,
        formFamily: enhanced.formFamily,
        marketConfirmation: input.marketConfirmation,
        riskLevel: input.riskLevel
      })}::jsonb
    )
    on conflict (source, source_event_id) do update set
      ticker = excluded.ticker,
      event_type = excluded.event_type,
      event_time = excluded.event_time,
      headline = excluded.headline,
      summary = excluded.summary,
      source_url = excluded.source_url,
      priority = excluded.priority,
      materiality = excluded.materiality,
      direction = excluded.direction,
      confidence = excluded.confidence,
      status = excluded.status,
      action = excluded.action,
      metadata = excluded.metadata,
      updated_at = now()
    returning id
  `;

  return rows[0] || null;
}

export async function backfillSecSignalEvents(limit = 30) {
  if (!hasDatabase()) {
    return { ok: false, database: "not_configured" as const, createdOrUpdated: 0, errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }] };
  }

  await ensureRavenTables();
  const sql = db();
  const rows = await sql<Array<{
    scored_signal_id: number;
    accession_number: string;
    ticker: string;
    form: string;
    filing_date: string | null;
    category: string;
    direction: string;
    final_score: number;
    action: string;
    readable_summary: string;
    source_url: string | null;
    priority: string | null;
    priority_score: number | null;
    materiality: string | null;
    form_family: string | null;
    market_confirmation: string | null;
    risk_level: string | null;
  }>>`
    select
      scored_signals.id as scored_signal_id,
      scored_signals.accession_number,
      scored_signals.ticker,
      scored_signals.form,
      scored_signals.filing_date::text as filing_date,
      scored_signals.category,
      scored_signals.direction,
      scored_signals.final_score,
      scored_signals.action,
      scored_signals.readable_summary,
      raw_sec_filings.source_url,
      raw_sec_filings.raw_payload->>'ravenPriority' as priority,
      nullif(raw_sec_filings.raw_payload->>'ravenPriorityScore', '')::integer as priority_score,
      raw_sec_filings.raw_payload->>'ravenMateriality' as materiality,
      raw_sec_filings.raw_payload->>'ravenFormFamily' as form_family,
      scored_signals.market_confirmation,
      scored_signals.risk_level
    from scored_signals
    left join raw_sec_filings on raw_sec_filings.accession_number = scored_signals.accession_number
    order by scored_signals.created_at desc
    limit ${Math.max(1, Math.min(100, limit))}
  `;

  let createdOrUpdated = 0;
  const errors: Array<{ ticker?: string; accessionNumber?: string; error: string }> = [];

  for (const row of rows) {
    try {
      await upsertSecSignalEvent({
        scoredSignalId: row.scored_signal_id,
        accessionNumber: row.accession_number,
        ticker: row.ticker,
        form: row.form,
        filingDate: row.filing_date,
        category: row.category,
        direction: row.direction,
        finalScore: row.final_score,
        action: row.action,
        summary: row.readable_summary,
        sourceUrl: row.source_url,
        priority: row.priority,
        priorityScore: row.priority_score,
        materiality: row.materiality,
        formFamily: row.form_family,
        marketConfirmation: row.market_confirmation,
        riskLevel: row.risk_level
      });
      createdOrUpdated += 1;
    } catch (error) {
      errors.push({ ticker: row.ticker, accessionNumber: row.accession_number, error: error instanceof Error ? error.message : "Unknown signal event backfill failure" });
    }
  }

  return { ok: errors.length === 0, database: "configured" as const, createdOrUpdated, errors };
}

export async function getLatestSignalEvents(limit = 12) {
  if (!hasDatabase()) return [];

  await ensureRavenTables();
  await backfillSecSignalEvents(30).catch(() => null);
  const sql = db();

  return sql<SignalEvent[]>`
    select
      id,
      source,
      source_event_id,
      ticker,
      event_type,
      event_time::text as event_time,
      headline,
      summary,
      source_url,
      priority,
      materiality,
      direction,
      confidence,
      status,
      action,
      metadata,
      created_at::text as created_at,
      updated_at::text as updated_at
    from signal_events
    order by created_at desc
    limit ${Math.max(1, Math.min(50, limit))}
  `;
}

export async function getSignalSourceHealth() {
  const sources: Array<{ source: SignalSource; label: string; status: string; count: number; latest: string | null }> = [
    { source: "SEC", label: "SEC", status: "idle", count: 0, latest: null },
    { source: "FINRA", label: "FINRA", status: "queued", count: 0, latest: null },
    { source: "FED_REG", label: "Federal Register", status: "queued", count: 0, latest: null },
    { source: "FDA", label: "FDA", status: "queued", count: 0, latest: null },
    { source: "CONGRESS", label: "Congress", status: "queued", count: 0, latest: null },
    { source: "NEWS", label: "News", status: "queued", count: 0, latest: null }
  ];

  if (!hasDatabase()) return sources;

  await ensureRavenTables();
  await backfillSecSignalEvents(30).catch(() => null);
  const sql = db();
  const rows = await sql<Array<{ source: string; count: number; latest: string | null }>>`
    select source, count(*)::integer as count, max(created_at)::text as latest
    from signal_events
    group by source
  `;

  return sources.map((source) => {
    const found = rows.find((row) => row.source === source.source);
    if (!found) return source;
    return {
      ...source,
      status: found.count > 0 ? "active" : source.status,
      count: found.count,
      latest: found.latest
    };
  });
}
