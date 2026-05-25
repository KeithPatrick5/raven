import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type PendingScoringRow = {
  summary_id: number;
  confirmation_id: number | null;
  accession_number: string;
  ticker: string;
  form: string;
  filing_date: string | null;
  direction: string;
  category: string;
  risk_level: string;
  tradeability: number;
  summary: string;
  bull_case: string;
  bear_case: string;
  verdict: string;
  latest_close: number | null;
  price_change_percent: number | null;
  latest_volume: number | null;
  relative_volume: number | null;
  liquidity_status: string | null;
  price_status: string | null;
  confirmation_status: string | null;
  raven_priority: string | null;
  raven_priority_score: number | null;
  raven_materiality: string | null;
  raven_form_family: string | null;
  raven_is_routine_form4: boolean | null;
};

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}


function filingPriorityImpact(row: PendingScoringRow) {
  const priority = (row.raven_priority || "").toLowerCase();
  const score = asNumber(row.raven_priority_score);
  const routineForm4 = Boolean(row.raven_is_routine_form4);

  if (routineForm4) return -18;
  if (priority === "critical") return 22;
  if (priority === "high") return 14;
  if (priority === "medium") return 4;
  if (priority === "low") return -8;
  if (priority === "noise") return -22;
  if (score !== null) {
    if (score >= 90) return 18;
    if (score >= 75) return 12;
    if (score <= 15) return -18;
  }
  return 0;
}

function formImpact(row: PendingScoringRow) {
  const form = row.form.toUpperCase();
  const category = row.category.toLowerCase();

  if (["424B5", "S-1", "S-3"].includes(form) || category.includes("dilution") || category.includes("offering") || category.includes("shelf")) {
    return row.direction.toLowerCase() === "bearish" ? 10 : -10;
  }

  if (form.includes("13D") || category.includes("activist")) return 12;
  if (form === "8-K") return 8;
  if (form === "4" && category.includes("routine")) return -18;
  if (form === "4" && category.includes("insider_sell")) return -10;
  if (form === "4" && category.includes("insider_buy")) return 10;

  return 0;
}

function categoryImpact(category: string) {
  const normalized = category.toLowerCase();
  if (normalized.includes("dilution") || normalized.includes("offering") || normalized.includes("shelf")) return -20;
  if (normalized.includes("default") || normalized.includes("bankruptcy") || normalized.includes("going_concern")) return -25;
  if (normalized.includes("insider_buy") || normalized.includes("cluster_buy")) return 18;
  if (normalized.includes("insider_sell")) return -10;
  if (normalized.includes("contract") || normalized.includes("partnership")) return 12;
  if (normalized.includes("activist") || normalized.includes("13d")) return 18;
  if (normalized.includes("guidance") || normalized.includes("earnings")) return 8;
  return 0;
}

function riskPenalty(riskLevel: string) {
  const normalized = riskLevel.toLowerCase();
  if (normalized.includes("critical")) return -25;
  if (normalized.includes("high")) return -16;
  if (normalized.includes("medium")) return -7;
  if (normalized.includes("low")) return 5;
  return 0;
}

function confirmationImpact(status: string | null) {
  switch ((status || "").toLowerCase()) {
    case "confirmed":
      return 22;
    case "watch":
      return 10;
    case "rejecting":
      return -18;
    case "unconfirmed":
      return -6;
    default:
      return -3;
  }
}

function liquidityImpact(status: string | null) {
  switch ((status || "").toLowerCase()) {
    case "active":
      return 8;
    case "liquid":
      return 5;
    case "normal":
      return 0;
    case "thin":
      return -18;
    default:
      return -5;
  }
}

function volumeImpact(relativeVolume: number | null) {
  if (relativeVolume === null) return 0;
  if (relativeVolume >= 3) return 12;
  if (relativeVolume >= 2) return 8;
  if (relativeVolume >= 1.5) return 5;
  if (relativeVolume < 0.7) return -4;
  return 0;
}

function priceImpact(direction: string, priceChangePercent: number | null) {
  if (priceChangePercent === null) return 0;
  const normalized = direction.toLowerCase();
  if (normalized === "bullish") {
    if (priceChangePercent >= 3) return 12;
    if (priceChangePercent >= 1) return 6;
    if (priceChangePercent <= -3) return -14;
  }
  if (normalized === "bearish") {
    if (priceChangePercent <= -3) return 12;
    if (priceChangePercent <= -1) return 6;
    if (priceChangePercent >= 3) return -12;
  }
  if (Math.abs(priceChangePercent) < 1) return -3;
  return 0;
}

function verdictFromScore(score: number, row: PendingScoringRow) {
  const category = row.category.toLowerCase();
  const confirmation = (row.confirmation_status || "").toLowerCase();

  if (category.includes("dilution") || category.includes("offering") || category.includes("shelf")) {
    return score >= 55 ? "danger_watch" : "avoid";
  }

  if (score >= 75 && confirmation === "confirmed") return "paper_trade_candidate";
  if (score >= 60) return "high_watch";
  if (score >= 40) return "watch_only";
  return "ignore";
}

function reasonsFor(row: PendingScoringRow, score: number) {
  const reasons: string[] = [];
  const relativeVolume = asNumber(row.relative_volume);
  const priceMove = asNumber(row.price_change_percent);

  reasons.push(`AI tradeability starts at ${row.tradeability}/100.`);
  reasons.push(`${row.category} / ${row.direction} / ${row.risk_level} risk.`);

  if (row.raven_priority) reasons.push(`Filing priority is ${row.raven_priority}${row.raven_priority_score !== null ? ` (${row.raven_priority_score}/100)` : ""}.`);
  if (row.raven_is_routine_form4) reasons.push("Routine Form 4 detected, so Raven penalized it hard.");
  if (row.raven_form_family) reasons.push(`Filing family: ${row.raven_form_family}.`);
  if (row.confirmation_status) reasons.push(`Market confirmation is ${row.confirmation_status}.`);
  if (relativeVolume !== null) reasons.push(`Relative volume is ${relativeVolume.toFixed(2)}x.`);
  if (priceMove !== null) reasons.push(`Latest price move is ${priceMove.toFixed(2)}%.`);
  if (row.liquidity_status) reasons.push(`Liquidity is ${row.liquidity_status}.`);

  if (score >= 75) reasons.push("Score is high enough for paper-trade consideration only, not live execution.");
  if (score < 40) reasons.push("Score is too weak for action. Keep it as noise unless a new catalyst appears.");

  return reasons;
}

function risksFor(row: PendingScoringRow) {
  const risks: string[] = [];
  const category = row.category.toLowerCase();
  const risk = row.risk_level.toLowerCase();

  if (row.raven_is_routine_form4) risks.push("Routine Form 4 noise. Usually not worth a trade unless price/volume suddenly confirms.");
  if (category.includes("insider_sell")) risks.push("Insider sale may be routine, tax-related, or 10b5-1 noise.");
  if (category.includes("dilution") || category.includes("offering") || category.includes("shelf")) risks.push("Dilution or offering language can wreck bullish momentum.");
  if (risk.includes("high")) risks.push("AI marked this as high risk. Do not chase without strong confirmation.");
  if ((row.confirmation_status || "") === "unconfirmed") risks.push("Price and volume are not confirming yet.");
  if ((row.liquidity_status || "") === "thin") risks.push("Thin liquidity can cause bad fills and fake moves.");
  if (!risks.length) risks.push("No major scoring penalty, but this still needs price/volume follow-through.");

  return risks;
}

function scoreRow(row: PendingScoringRow) {
  const relativeVolume = asNumber(row.relative_volume);
  const priceChange = asNumber(row.price_change_percent);
  let score = row.tradeability;

  score += filingPriorityImpact(row);
  score += formImpact(row);
  score += categoryImpact(row.category);
  score += riskPenalty(row.risk_level);
  score += confirmationImpact(row.confirmation_status);
  score += liquidityImpact(row.liquidity_status);
  score += volumeImpact(relativeVolume);
  score += priceImpact(row.direction, priceChange);

  const finalScore = clampScore(score);
  const action = verdictFromScore(finalScore, row);

  return {
    score: finalScore,
    action,
    reasons: reasonsFor(row, finalScore),
    risks: risksFor(row)
  };
}

async function getPendingRows(limit: number): Promise<PendingScoringRow[]> {
  const sql = db();

  return sql<PendingScoringRow[]>`
    select
      s.id as summary_id,
      c.id as confirmation_id,
      s.accession_number,
      s.ticker,
      s.form,
      s.filing_date::text as filing_date,
      s.direction,
      s.category,
      s.risk_level,
      s.tradeability,
      s.summary,
      s.bull_case,
      s.bear_case,
      s.verdict,
      c.latest_close,
      c.price_change_percent,
      c.latest_volume,
      c.relative_volume,
      c.liquidity_status,
      c.price_status,
      c.confirmation_status,
      r.raw_payload->>'ravenPriority' as raven_priority,
      nullif(r.raw_payload->>'ravenPriorityScore', '')::integer as raven_priority_score,
      r.raw_payload->>'ravenMateriality' as raven_materiality,
      r.raw_payload->>'ravenFormFamily' as raven_form_family,
      nullif(r.raw_payload->>'ravenIsRoutineForm4', '')::boolean as raven_is_routine_form4
    from sec_filing_summaries s
    left join raw_sec_filings r
      on r.id = s.raw_filing_id
    left join alpaca_market_confirmations c
      on c.summary_id = s.id
    left join scored_signals scored
      on scored.summary_id = s.id
    where scored.id is null
    order by s.created_at desc
    limit ${limit}
  `;
}

async function saveScore(row: PendingScoringRow) {
  const sql = db();
  const result = scoreRow(row);

  await sql`
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
      ${row.summary_id},
      ${row.confirmation_id},
      ${row.accession_number},
      ${row.ticker},
      ${row.form},
      ${row.filing_date},
      ${row.direction},
      ${row.category},
      ${row.risk_level},
      ${row.tradeability},
      ${row.confirmation_status || "unconfirmed"},
      ${result.score},
      ${result.action},
      ${row.summary},
      ${JSON.stringify(result.reasons)}::jsonb,
      ${JSON.stringify(result.risks)}::jsonb,
      ${JSON.stringify({
        ai: {
          verdict: row.verdict,
          bullCase: row.bull_case,
          bearCase: row.bear_case
        },
        filingIntelligence: {
          priority: row.raven_priority,
          priorityScore: row.raven_priority_score,
          materiality: row.raven_materiality,
          formFamily: row.raven_form_family,
          routineForm4: row.raven_is_routine_form4
        },
        market: {
          latestClose: row.latest_close,
          priceChangePercent: row.price_change_percent,
          latestVolume: row.latest_volume,
          relativeVolume: row.relative_volume,
          liquidityStatus: row.liquidity_status,
          priceStatus: row.price_status,
          confirmationStatus: row.confirmation_status
        }
      })}::jsonb
    )
    on conflict (summary_id) do nothing
  `;

  return {
    ticker: row.ticker,
    accessionNumber: row.accession_number,
    form: row.form,
    direction: row.direction,
    category: row.category,
    riskLevel: row.risk_level,
    aiTradeability: row.tradeability,
    marketConfirmation: row.confirmation_status || "unconfirmed",
    finalScore: result.score,
    action: result.action,
    summary: row.summary,
    reasons: result.reasons,
    risks: result.risks
  };
}

export async function scorePendingSignals(limit = 10) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      scored: 0,
      pending: 0,
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }],
      signals: []
    };
  }

  await ensureRavenTables();

  const pending = await getPendingRows(limit);
  const signals: Array<Record<string, unknown>> = [];
  const errors: Array<{ ticker?: string; accessionNumber?: string; error: string }> = [];

  for (const row of pending) {
    try {
      signals.push(await saveScore(row));
    } catch (error) {
      errors.push({
        ticker: row.ticker,
        accessionNumber: row.accession_number,
        error: error instanceof Error ? error.message : "Unknown scoring failure"
      });
    }
  }

  return {
    ok: signals.length > 0 || pending.length === 0,
    database: "configured" as const,
    scored: signals.length,
    pending: Math.max(0, pending.length - signals.length),
    errors,
    signals
  };
}

export async function getLatestScoredSignals(limit = 10) {
  if (!hasDatabase()) return [];

  await ensureRavenTables();
  const sql = db();

  return sql<Array<{
    ticker: string;
    accession_number: string;
    form: string;
    filing_date: string | null;
    direction: string;
    category: string;
    risk_level: string;
    ai_tradeability: number;
    market_confirmation: string;
    final_score: number;
    action: string;
    readable_summary: string;
    reason_codes: string[];
    risk_flags: string[];
    created_at: string;
  }>>`
    select
      ticker,
      accession_number,
      form,
      filing_date::text as filing_date,
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
      created_at::text as created_at
    from scored_signals
    order by created_at desc
    limit ${limit}
  `;
}
