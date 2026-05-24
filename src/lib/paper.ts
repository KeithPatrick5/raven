import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { hasTelegramConfig, sendTelegramMessage } from "@/lib/telegram";

type CandidateRow = {
  scored_signal_id: number;
  confirmation_id: number | null;
  ticker: string;
  accession_number: string;
  form: string;
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
  latest_close: number | string | null;
  price_change_percent: number | string | null;
  relative_volume: number | string | null;
  liquidity_status: string | null;
  price_status: string | null;
};

type PaperTrade = {
  id: number;
  scored_signal_id: number;
  ticker: string;
  accession_number: string;
  side: string;
  status: string;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  final_score: number;
  decision_reason: string;
  opened_at: string;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function tradeSide(row: CandidateRow): "long" | null {
  // Raven v1 is long-only. Bearish signals can protect us from traps later, but they do not open shorts yet.
  return row.direction.toLowerCase() === "bullish" ? "long" : null;
}

function entryPrice(row: CandidateRow): number | null {
  return asNumber(row.latest_close);
}

function planFor(row: CandidateRow) {
  const entry = entryPrice(row);
  const side = tradeSide(row);

  if (!entry || !side) {
    return { side, entry, stop: null, target: null };
  }

  return {
    side,
    entry: roundMoney(entry),
    stop: roundMoney(entry * 0.96),
    target: roundMoney(entry * 1.08)
  };
}

function decision(row: CandidateRow) {
  const reasons: string[] = [];
  const rejects: string[] = [];
  const confirmation = row.market_confirmation.toLowerCase();
  const liquidity = (row.liquidity_status || "").toLowerCase();
  const side = tradeSide(row);
  const entry = entryPrice(row);

  reasons.push(`Score ${row.final_score}/100.`);
  reasons.push(`Action ${row.action}.`);
  reasons.push(`Market confirmation ${row.market_confirmation}.`);
  if (row.liquidity_status) reasons.push(`Liquidity ${row.liquidity_status}.`);

  if (row.final_score < 70) rejects.push("score_below_70");
  if (!["paper_trade_candidate", "high_watch"].includes(row.action)) rejects.push("action_not_trade_eligible");
  if (!["confirmed", "watch"].includes(confirmation)) rejects.push("market_not_confirming");
  if (!["liquid", "active"].includes(liquidity)) rejects.push("liquidity_not_strong_enough");
  if (!side) rejects.push("long_only_engine_rejects_bearish_or_neutral_signal");
  if (!entry) rejects.push("missing_entry_price");

  return {
    shouldOpen: rejects.length === 0,
    reasons,
    rejects
  };
}

async function getOpenCandidates(limit: number): Promise<CandidateRow[]> {
  const sql = db();

  return sql<CandidateRow[]>`
    select
      s.id as scored_signal_id,
      s.confirmation_id,
      s.ticker,
      s.accession_number,
      s.form,
      s.direction,
      s.category,
      s.risk_level,
      s.ai_tradeability,
      s.market_confirmation,
      s.final_score,
      s.action,
      s.readable_summary,
      s.reason_codes,
      s.risk_flags,
      c.latest_close,
      c.price_change_percent,
      c.relative_volume,
      c.liquidity_status,
      c.price_status
    from scored_signals s
    left join alpaca_market_confirmations c
      on c.id = s.confirmation_id
    left join paper_trades p
      on p.scored_signal_id = s.id
    where p.id is null
    order by s.final_score desc, s.created_at desc
    limit ${limit}
  `;
}

async function openTrade(row: CandidateRow) {
  const sql = db();
  const plan = planFor(row);
  const verdict = decision(row);
  const reason = [...verdict.reasons, "Raven opened this as a paper trade only. Live trading remains disabled."].join(" ");

  if (!plan.side || plan.entry === null || plan.stop === null || plan.target === null) {
    throw new Error("Trade plan was incomplete after eligibility passed.");
  }

  const inserted = await sql<PaperTrade[]>`
    insert into paper_trades (
      scored_signal_id,
      confirmation_id,
      accession_number,
      ticker,
      side,
      status,
      entry_price,
      stop_price,
      target_price,
      final_score,
      decision_reason,
      raw_payload
    ) values (
      ${row.scored_signal_id},
      ${row.confirmation_id},
      ${row.accession_number},
      ${row.ticker},
      ${plan.side},
      'open',
      ${plan.entry},
      ${plan.stop},
      ${plan.target},
      ${row.final_score},
      ${reason},
      ${JSON.stringify({
        signal: {
          form: row.form,
          direction: row.direction,
          category: row.category,
          riskLevel: row.risk_level,
          aiTradeability: row.ai_tradeability,
          marketConfirmation: row.market_confirmation,
          summary: row.readable_summary,
          reasonCodes: row.reason_codes,
          riskFlags: row.risk_flags
        },
        market: {
          latestClose: row.latest_close,
          priceChangePercent: row.price_change_percent,
          relativeVolume: row.relative_volume,
          liquidityStatus: row.liquidity_status,
          priceStatus: row.price_status
        }
      })}::jsonb
    )
    on conflict (scored_signal_id) do nothing
    returning
      id,
      scored_signal_id,
      ticker,
      accession_number,
      side,
      status,
      entry_price,
      stop_price,
      target_price,
      final_score,
      decision_reason,
      opened_at::text as opened_at
  `;

  return inserted[0] || null;
}

function formatPaperTradeAlert(trade: PaperTrade) {
  return [
    "RAVEN PAPER TRADE OPENED",
    "Live trading: disabled",
    "",
    `${trade.ticker} | ${trade.side.toUpperCase()} | score ${trade.final_score}/100`,
    `Entry: ${trade.entry_price}`,
    `Stop: ${trade.stop_price}`,
    `Target: ${trade.target_price}`,
    "",
    `Reason: ${trade.decision_reason}`
  ].join("\n");
}

async function sendTradeAlertIfConfigured(trade: PaperTrade) {
  if (!hasTelegramConfig()) return { sent: false, reason: "telegram_not_configured" };

  try {
    const response = await sendTelegramMessage(formatPaperTradeAlert(trade));
    return { sent: true, messageId: response.result?.message_id || null };
  } catch (error) {
    return {
      sent: false,
      reason: "telegram_send_failed",
      error: error instanceof Error ? error.message : "Unknown Telegram send failure"
    };
  }
}

export async function runPaperTradeEngine(limit = 10) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      evaluated: 0,
      opened: 0,
      rejected: 0,
      trades: [],
      rejects: [],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const rows = await getOpenCandidates(limit);
  const trades: Array<Record<string, unknown>> = [];
  const rejects: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const verdict = decision(row);
    if (!verdict.shouldOpen) {
      rejects.push({
        ticker: row.ticker,
        accessionNumber: row.accession_number,
        score: row.final_score,
        action: row.action,
        rejects: verdict.rejects,
        reasons: verdict.reasons
      });
      continue;
    }

    try {
      const trade = await openTrade(row);
      if (trade) {
        const telegram = await sendTradeAlertIfConfigured(trade);
        trades.push({
          ticker: trade.ticker,
          accessionNumber: trade.accession_number,
          side: trade.side,
          status: trade.status,
          entry: trade.entry_price,
          stop: trade.stop_price,
          target: trade.target_price,
          score: trade.final_score,
          telegram
        });
      }
    } catch (error) {
      errors.push({
        ticker: row.ticker,
        accessionNumber: row.accession_number,
        error: error instanceof Error ? error.message : "Unknown paper-trade failure"
      });
    }
  }

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    evaluated: rows.length,
    opened: trades.length,
    rejected: rejects.length,
    trades,
    rejects,
    errors
  };
}

export async function getLatestPaperTrades(limit = 10) {
  if (!hasDatabase()) return [];

  await ensureRavenTables();
  const sql = db();

  return sql<Array<{
    ticker: string;
    accession_number: string;
    side: string;
    status: string;
    entry_price: number | null;
    stop_price: number | null;
    target_price: number | null;
    final_score: number;
    decision_reason: string;
    opened_at: string;
  }>>`
    select
      ticker,
      accession_number,
      side,
      status,
      entry_price,
      stop_price,
      target_price,
      final_score,
      decision_reason,
      opened_at::text as opened_at
    from paper_trades
    order by opened_at desc
    limit ${limit}
  `;
}
