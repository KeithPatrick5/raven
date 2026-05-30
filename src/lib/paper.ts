import { getLatestAlpacaSnapshot, hasAlpacaProvider } from "@/lib/alpaca";
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
  exit_price?: number | null;
  final_score: number;
  decision_reason: string;
  opened_at: string;
  closed_at?: string | null;
  close_reason?: string | null;
  outcome?: string | null;
  pnl_percent?: number | null;
};

type OpenTradeRow = PaperTrade & {
  entry_price: number;
  stop_price: number;
  target_price: number;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundMoney(value: number) {
  return round(value, 2);
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function paperTradeNotional() {
  return Math.max(1, envNumber("RAVEN_MAX_NOTIONAL_PER_TRADE", 1000));
}

function tradeRiskDollars(trade: PaperTradeAlertPayload, notional: number) {
  if (!trade.entry_price || !trade.stop_price || trade.entry_price <= 0) return null;
  return Math.abs((trade.entry_price - trade.stop_price) / trade.entry_price) * notional;
}

function tradeTargetDollars(trade: PaperTradeAlertPayload, notional: number) {
  if (!trade.entry_price || !trade.target_price || trade.entry_price <= 0) return null;
  return Math.abs((trade.target_price - trade.entry_price) / trade.entry_price) * notional;
}

function tradeSide(row: CandidateRow): "long" | null {
  // Raven v1 is still long-only, but paper mode now allows neutral signals so we can collect outcome data.
  return row.direction.toLowerCase() === "bearish" ? null : "long";
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

  if (row.final_score < 35) rejects.push("score_below_35");
  if (["dilution_watch", "shelf_watch", "late_filing_risk", "danger_watch", "avoid"].includes(row.action)) rejects.push("danger_action_not_allowed_even_in_paper");
  if (!["confirmed", "watch", "unconfirmed", "unknown", ""].includes(confirmation)) reasons.push(`Market status ${row.market_confirmation} is not ideal, but paper mode allows testing.`);
  if (["halted", "untradeable", "blocked"].includes(liquidity)) rejects.push("liquidity_blocked_or_untradeable");
  if (!side) rejects.push("long_only_engine_rejects_bearish_signal");
  if (!entry) rejects.push("missing_entry_price");

  return {
    shouldOpen: rejects.length === 0,
    decision: rejects.length === 0 ? "open_paper_trade" : "reject",
    reasons,
    rejects
  };
}

async function getOpenCandidates(limit: number): Promise<CandidateRow[]> {
  const sql = db();

  return sql<CandidateRow[]>`
    with ranked as (
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
        c.price_status,
        row_number() over (partition by upper(s.ticker) order by s.final_score desc, s.created_at desc) as ticker_rank
      from scored_signals s
      left join alpaca_market_confirmations c
        on c.id = s.confirmation_id
      left join paper_trade_decisions d
        on d.scored_signal_id = s.id
      where d.id is null
        and not exists (
          select 1
          from paper_trades pt
          where upper(pt.ticker) = upper(s.ticker)
            and pt.status = 'open'
        )
    )
    select
      scored_signal_id,
      confirmation_id,
      ticker,
      accession_number,
      form,
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
      latest_close,
      price_change_percent,
      relative_volume,
      liquidity_status,
      price_status
    from ranked
    where ticker_rank = 1
    order by final_score desc, scored_signal_id desc
    limit ${limit}
  `;
}

async function logDecision(row: CandidateRow, verdict: ReturnType<typeof decision>) {
  const sql = db();

  await sql`
    insert into paper_trade_decisions (
      scored_signal_id,
      accession_number,
      ticker,
      decision,
      final_score,
      action,
      reject_codes,
      reason_codes,
      raw_payload
    ) values (
      ${row.scored_signal_id},
      ${row.accession_number},
      ${row.ticker},
      ${verdict.decision},
      ${row.final_score},
      ${row.action},
      ${JSON.stringify(verdict.rejects)}::jsonb,
      ${JSON.stringify(verdict.reasons)}::jsonb,
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
    on conflict (scored_signal_id) do update set
      decision = excluded.decision,
      final_score = excluded.final_score,
      action = excluded.action,
      reject_codes = excluded.reject_codes,
      reason_codes = excluded.reason_codes,
      raw_payload = excluded.raw_payload
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

type PaperTradeAlertPayload = {
  ticker: string;
  side: string;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  final_score: number;
  decision_reason: string;
  outcome?: string | null;
  pnl_percent?: number | null;
  exit_price?: number | null;
  close_reason?: string | null;
};

function formatPaperTradeBatchAlert(trades: PaperTradeAlertPayload[], rejects: Array<Record<string, unknown>>) {
  const notional = paperTradeNotional();
  const plannedExposure = trades.length * notional;
  const estimatedRisk = trades.reduce((sum, trade) => sum + (tradeRiskDollars(trade, notional) || 0), 0);
  const estimatedTarget = trades.reduce((sum, trade) => sum + (tradeTargetDollars(trade, notional) || 0), 0);
  const lines = [
    "RAVEN PAPER TRADE SUMMARY",
    "Live trading: disabled",
    "Mode: internal paper trade log",
    "",
    `Opened internal paper trades: ${trades.length}`,
    `Rejected candidates: ${rejects.length}`,
    `Planned paper exposure: ${money(plannedExposure)}`,
    `Estimated risk to stops: ${money(estimatedRisk)}`,
    `Estimated target upside: ${money(estimatedTarget)}`
  ];

  if (trades.length) {
    lines.push("", "OPENED");
    for (const trade of trades.slice(0, 12)) {
      const risk = tradeRiskDollars(trade, notional);
      const target = tradeTargetDollars(trade, notional);
      lines.push(`- ${trade.ticker} | ${trade.side.toUpperCase()} | score ${trade.final_score}/100 | ${money(notional)} notional | risk ${money(risk)} | target ${money(target)}`);
    }
  }

  if (rejects.length) {
    lines.push("", "TOP REJECTS");
    for (const reject of rejects.slice(0, 5)) {
      const codes = Array.isArray(reject.rejects) ? reject.rejects.join(", ") : "unknown";
      lines.push(`- ${reject.ticker || "UNKNOWN"} | score ${reject.score ?? "?"} | ${codes}`);
    }
  }

  lines.push("", "Actual Alpaca paper orders are tracked separately in Reports -> Paper Lifecycle.");
  return lines.join("\n");
}

function formatPaperTradeCloseBatchAlert(trades: PaperTradeAlertPayload[]) {
  const notional = paperTradeNotional();
  const wins = trades.filter((trade) => trade.outcome === "win").length;
  const losses = trades.filter((trade) => trade.outcome === "loss").length;
  const estimatedPnl = trades.reduce((sum, trade) => sum + ((trade.pnl_percent || 0) / 100) * notional, 0);
  const lines = [
    "RAVEN PAPER TRADE CLOSE SUMMARY",
    "Live trading: disabled",
    "",
    `Closed internal paper trades: ${trades.length}`,
    `Wins: ${wins} | Losses: ${losses}`,
    `Estimated paper P/L: ${money(estimatedPnl)}`
  ];

  for (const trade of trades.slice(0, 12)) {
    const pnlDollars = ((trade.pnl_percent || 0) / 100) * notional;
    lines.push(`- ${trade.ticker} | ${trade.outcome || "closed"} | ${trade.pnl_percent ?? 0}% | ${money(pnlDollars)} | ${trade.close_reason || "review"}`);
  }

  lines.push("", "Use Reports -> Paper Lifecycle / Performance for full details.");
  return lines.join("\n");
}

async function sendTradeBatchAlertIfConfigured(trades: PaperTradeAlertPayload[], rejects: Array<Record<string, unknown>>) {
  if (!hasTelegramConfig()) return { sent: false, reason: "telegram_not_configured" };
  if (!trades.length) return { sent: false, reason: "no_opened_trades" };

  try {
    const response = await sendTelegramMessage(formatPaperTradeBatchAlert(trades, rejects));
    return { sent: true, messageId: response.result?.message_id || null };
  } catch (error) {
    return {
      sent: false,
      reason: "telegram_send_failed",
      error: error instanceof Error ? error.message : "Unknown Telegram send failure"
    };
  }
}

async function sendCloseBatchAlertIfConfigured(trades: PaperTradeAlertPayload[]) {
  if (!hasTelegramConfig()) return { sent: false, reason: "telegram_not_configured" };
  if (!trades.length) return { sent: false, reason: "no_closed_trades" };

  try {
    const response = await sendTelegramMessage(formatPaperTradeCloseBatchAlert(trades));
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
    await logDecision(row, verdict);

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
        trades.push({
          ticker: trade.ticker,
          accessionNumber: trade.accession_number,
          side: trade.side,
          status: trade.status,
          entry: trade.entry_price,
          stop: trade.stop_price,
          target: trade.target_price,
          score: trade.final_score
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

  const telegram = await sendTradeBatchAlertIfConfigured(trades.map((trade) => ({
    ticker: String(trade.ticker),
    side: String(trade.side),
    entry_price: asNumber(trade.entry),
    stop_price: asNumber(trade.stop),
    target_price: asNumber(trade.target),
    final_score: asNumber(trade.score) ?? 0,
    decision_reason: "Internal paper trade opened."
  })), rejects);
  const recentDecisions = await getLatestPaperDecisions(10);
  const recentTrades = await getLatestPaperTrades(10);

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    evaluated: rows.length,
    opened: trades.length,
    rejected: rejects.length,
    alreadyLogged: recentDecisions.length,
    telegram,
    trades,
    rejects,
    recentDecisions,
    recentTrades,
    errors
  };
}

async function getOpenTrades(limit: number): Promise<OpenTradeRow[]> {
  const sql = db();
  return sql<OpenTradeRow[]>`
    select
      id,
      scored_signal_id,
      ticker,
      accession_number,
      side,
      status,
      entry_price,
      stop_price,
      target_price,
      exit_price,
      final_score,
      decision_reason,
      opened_at::text as opened_at,
      closed_at::text as closed_at,
      close_reason,
      outcome,
      pnl_percent
    from paper_trades
    where status = 'open'
    order by opened_at asc
    limit ${limit}
  `;
}

async function closeTrade(trade: OpenTradeRow, exitPrice: number, closeReason: string, outcome: string) {
  const sql = db();
  const pnl = trade.side === "long" ? ((exitPrice - trade.entry_price) / trade.entry_price) * 100 : ((trade.entry_price - exitPrice) / trade.entry_price) * 100;

  const updated = await sql<PaperTrade[]>`
    update paper_trades
    set
      status = 'closed',
      exit_price = ${roundMoney(exitPrice)},
      closed_at = now(),
      close_reason = ${closeReason},
      outcome = ${outcome},
      pnl_percent = ${round(pnl, 2)}
    where id = ${trade.id}
      and status = 'open'
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
      exit_price,
      final_score,
      decision_reason,
      opened_at::text as opened_at,
      closed_at::text as closed_at,
      close_reason,
      outcome,
      pnl_percent
  `;

  return updated[0] || null;
}

function closeDecision(trade: OpenTradeRow, latestClose: number | null) {
  if (latestClose === null) {
    return { shouldClose: false, reason: "no_latest_price", outcome: "open" };
  }

  if (trade.side === "long") {
    if (latestClose <= trade.stop_price) return { shouldClose: true, reason: "stop_hit", outcome: "loss" };
    if (latestClose >= trade.target_price) return { shouldClose: true, reason: "target_hit", outcome: "win" };
  }

  return { shouldClose: false, reason: "still_open", outcome: "open" };
}

export async function reviewOpenPaperTrades(limit = 10) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      alpaca: hasAlpacaProvider() ? "configured" : "not_configured",
      reviewed: 0,
      closed: 0,
      stillOpen: 0,
      closes: [],
      open: [],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();

  if (!hasAlpacaProvider()) {
    return {
      ok: false,
      database: "configured" as const,
      alpaca: "not_configured" as const,
      reviewed: 0,
      closed: 0,
      stillOpen: 0,
      closes: [],
      open: [],
      errors: [{ error: "ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are not configured." }]
    };
  }

  const openTrades = await getOpenTrades(limit);
  const closes: Array<Record<string, unknown>> = [];
  const open: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  for (const trade of openTrades) {
    try {
      const snapshot = await getLatestAlpacaSnapshot(trade.ticker);
      const verdict = closeDecision(trade, snapshot.latestClose);

      if (verdict.shouldClose && snapshot.latestClose !== null) {
        const closed = await closeTrade(trade, snapshot.latestClose, verdict.reason, verdict.outcome);
        if (closed) {
          closes.push({
            ticker: closed.ticker,
            side: closed.side,
            entry: closed.entry_price,
            exit: closed.exit_price,
            outcome: closed.outcome,
            pnlPercent: closed.pnl_percent,
            reason: closed.close_reason
          });
        }
      } else {
        open.push({
          ticker: trade.ticker,
          side: trade.side,
          entry: trade.entry_price,
          latestClose: snapshot.latestClose,
          stop: trade.stop_price,
          target: trade.target_price,
          status: verdict.reason
        });
      }
    } catch (error) {
      errors.push({
        ticker: trade.ticker,
        error: error instanceof Error ? error.message : "Unknown paper-trade review failure"
      });
    }
  }

  const telegram = await sendCloseBatchAlertIfConfigured(closes.map((trade) => ({
    ticker: String(trade.ticker),
    side: String(trade.side),
    entry_price: asNumber(trade.entry),
    stop_price: null,
    target_price: null,
    final_score: 0,
    decision_reason: "Internal paper trade closed.",
    outcome: typeof trade.outcome === "string" ? trade.outcome : null,
    pnl_percent: asNumber(trade.pnlPercent),
    exit_price: asNumber(trade.exit),
    close_reason: typeof trade.reason === "string" ? trade.reason : null
  })));
  const recentDecisions = await getLatestPaperDecisions(10);
  const recentTrades = await getLatestPaperTrades(10);

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    alpaca: "configured" as const,
    reviewed: openTrades.length,
    closed: closes.length,
    stillOpen: open.length,
    telegram,
    closes,
    open,
    recentDecisions,
    recentTrades,
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
    exit_price: number | null;
    final_score: number;
    decision_reason: string;
    opened_at: string;
    closed_at: string | null;
    close_reason: string | null;
    outcome: string | null;
    pnl_percent: number | null;
  }>>`
    select
      ticker,
      accession_number,
      side,
      status,
      entry_price,
      stop_price,
      target_price,
      exit_price,
      final_score,
      decision_reason,
      opened_at::text as opened_at,
      closed_at::text as closed_at,
      close_reason,
      outcome,
      pnl_percent
    from paper_trades
    order by opened_at desc
    limit ${limit}
  `;
}

export async function getLatestPaperDecisions(limit = 10) {
  if (!hasDatabase()) return [];

  await ensureRavenTables();
  const sql = db();

  return sql<Array<{
    ticker: string;
    accession_number: string;
    decision: string;
    final_score: number;
    action: string;
    reject_codes: string[];
    reason_codes: string[];
    created_at: string;
  }>>`
    select
      ticker,
      accession_number,
      decision,
      final_score,
      action,
      reject_codes,
      reason_codes,
      created_at::text as created_at
    from paper_trade_decisions
    order by created_at desc
    limit ${limit}
  `;
}
