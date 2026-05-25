import { createAlpacaPaperOrder, getAlpacaAccount, getAlpacaOrders, getAlpacaPositions, getLatestAlpacaSnapshot, hasAlpacaProvider } from "@/lib/alpaca";
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
  lifecycle_status?: string | null;
  alpaca_order_id?: string | null;
  alpaca_order_status?: string | null;
  notional?: number | null;
  qty?: number | null;
  submitted_at?: string | null;
  filled_at?: string | null;
  expires_at?: string | null;
};

type OpenTradeRow = PaperTrade & {
  entry_price: number;
  stop_price: number;
  target_price: number;
};


function paperExecutionEnabled() {
  return ["1", "true", "yes", "on"].includes((process.env.RAVEN_PAPER_EXECUTION_ENABLED || process.env.PAPER_TRADE_EXECUTION_ENABLED || "").toLowerCase());
}

const PAPER_MAX_OPEN_POSITIONS = Number(process.env.RAVEN_PAPER_MAX_OPEN_POSITIONS || "3");
const PAPER_MAX_DAILY_TRADES = Number(process.env.RAVEN_PAPER_MAX_DAILY_TRADES || "3");
const PAPER_POSITION_EQUITY_PERCENT = Number(process.env.RAVEN_PAPER_POSITION_EQUITY_PERCENT || "1");
const PAPER_MAX_NOTIONAL = Number(process.env.RAVEN_PAPER_MAX_NOTIONAL || "2500");
const PAPER_MIN_NOTIONAL = Number(process.env.RAVEN_PAPER_MIN_NOTIONAL || "25");

function orderStatusToLifecycle(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  if (["filled", "partially_filled"].includes(normalized)) return "open";
  if (["new", "accepted", "pending_new", "accepted_for_bidding", "calculated"].includes(normalized)) return "pending_entry";
  if (["canceled", "expired", "rejected", "stopped", "suspended"].includes(normalized)) return normalized === "rejected" ? "rejected" : "expired";
  return "pending_entry";
}

function toMoney(value: unknown) {
  const parsed = asNumber(value);
  return parsed === null ? null : roundMoney(parsed);
}

async function dailyPaperTradeCount() {
  const sql = db();
  const rows = await sql<Array<{ count: number | string }>>`
    select count(*)::int as count
    from paper_trades
    where opened_at >= date_trunc('day', now())
      and status in ('pending_entry', 'open', 'pending_exit', 'closed')
  `;
  return Number(rows[0]?.count || 0);
}

async function activePaperTradeCount() {
  const sql = db();
  const rows = await sql<Array<{ count: number | string }>>`
    select count(*)::int as count
    from paper_trades
    where status in ('pending_entry', 'open', 'pending_exit')
  `;
  return Number(rows[0]?.count || 0);
}

async function accountRiskCheck(row: CandidateRow) {
  if (!hasAlpacaProvider()) {
    return { ok: false, reject: "alpaca_not_configured", notional: null as number | null, notes: ["Alpaca credentials are missing."] };
  }

  const [account, positions, openOrders, dailyCount, activeCount] = await Promise.all([
    getAlpacaAccount("paper"),
    getAlpacaPositions("paper"),
    getAlpacaOrders("paper", "open", 50),
    dailyPaperTradeCount(),
    activePaperTradeCount()
  ]);

  const equity = toMoney(account.equity);
  const buyingPower = toMoney(account.buying_power);
  const cash = toMoney(account.cash);
  const alreadyHeld = positions.some((position) => position.symbol.toUpperCase() === row.ticker.toUpperCase());
  const alreadyOrdered = openOrders.some((order) => order.symbol.toUpperCase() === row.ticker.toUpperCase());
  const maxOpen = Number.isFinite(PAPER_MAX_OPEN_POSITIONS) ? PAPER_MAX_OPEN_POSITIONS : 3;
  const maxDaily = Number.isFinite(PAPER_MAX_DAILY_TRADES) ? PAPER_MAX_DAILY_TRADES : 3;
  const percent = Number.isFinite(PAPER_POSITION_EQUITY_PERCENT) ? PAPER_POSITION_EQUITY_PERCENT : 1;
  const cap = Number.isFinite(PAPER_MAX_NOTIONAL) ? PAPER_MAX_NOTIONAL : 2500;
  const min = Number.isFinite(PAPER_MIN_NOTIONAL) ? PAPER_MIN_NOTIONAL : 25;
  const base = equity === null ? null : roundMoney(equity * (percent / 100));
  const notional = base === null ? null : Math.max(min, Math.min(base, cap));
  const notes = [
    `Equity ${equity ?? "unknown"}.`,
    `Buying power ${buyingPower ?? "unknown"}.`,
    `Paper order size ${notional ?? "unknown"}.`,
    `Active paper trades ${activeCount}/${maxOpen}.`,
    `Daily paper trades ${dailyCount}/${maxDaily}.`
  ];

  if (equity === null || buyingPower === null || notional === null) return { ok: false, reject: "account_values_unavailable", notional, notes };
  if (notional > buyingPower) return { ok: false, reject: "insufficient_buying_power", notional, notes };
  if (activeCount >= maxOpen) return { ok: false, reject: "max_open_positions_reached", notional, notes };
  if (dailyCount >= maxDaily) return { ok: false, reject: "max_daily_trades_reached", notional, notes };
  if (alreadyHeld) return { ok: false, reject: "position_already_open_in_alpaca", notional, notes };
  if (alreadyOrdered) return { ok: false, reject: "open_order_already_exists_in_alpaca", notional, notes };
  if (cash !== null && notional > cash && buyingPower <= cash) return { ok: false, reject: "cash_limit_reached", notional, notes };

  return { ok: true, reject: null, notional, notes };
}

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
  if (row.action === "dilution_watch" || row.action === "shelf_watch") rejects.push("dilution_watch_not_long_trade");
  if ((row.risk_flags || []).some((flag) => String(flag).toLowerCase().includes("dilution") || String(flag).toLowerCase().includes("offering"))) rejects.push("dilution_or_offering_risk");

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
    left join paper_trade_decisions d
      on d.scored_signal_id = s.id
    where d.id is null
    order by s.final_score desc, s.created_at desc
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
  const executionEnabled = paperExecutionEnabled();
  const risk = executionEnabled ? await accountRiskCheck(row) : { ok: false, reject: "paper_execution_disabled", notional: null as number | null, notes: ["Set RAVEN_PAPER_EXECUTION_ENABLED=true to allow Alpaca paper orders."] };
  const reason = [...verdict.reasons, ...risk.notes, "Live trading remains disabled."].join(" ");

  if (!plan.side || plan.entry === null || plan.stop === null || plan.target === null) {
    throw new Error("Trade plan was incomplete after eligibility passed.");
  }

  let status = "pending_entry";
  let alpacaOrderId: string | null = null;
  let alpacaOrderStatus: string | null = null;
  let notional = risk.notional;
  let qty: number | null = null;
  let rawOrder: Record<string, unknown> | null = null;

  if (!executionEnabled || !risk.ok || notional === null) {
    status = "rejected";
  } else {
    const order = await createAlpacaPaperOrder({
      symbol: row.ticker,
      side: "buy",
      type: "market",
      time_in_force: "day",
      notional: notional.toFixed(2),
      client_order_id: `raven-paper-${row.scored_signal_id}-${Date.now()}`
    });
    alpacaOrderId = order.id;
    alpacaOrderStatus = order.status;
    status = orderStatusToLifecycle(order.status);
    qty = asNumber(order.filled_qty) || null;
    rawOrder = order as unknown as Record<string, unknown>;
  }

  const inserted = await sql<PaperTrade[]>`
    insert into paper_trades (
      scored_signal_id,
      confirmation_id,
      accession_number,
      ticker,
      side,
      status,
      lifecycle_status,
      alpaca_order_id,
      alpaca_order_status,
      notional,
      qty,
      entry_price,
      stop_price,
      target_price,
      final_score,
      decision_reason,
      submitted_at,
      filled_at,
      expires_at,
      raw_payload
    ) values (
      ${row.scored_signal_id},
      ${row.confirmation_id},
      ${row.accession_number},
      ${row.ticker},
      ${plan.side},
      ${status},
      ${status},
      ${alpacaOrderId},
      ${alpacaOrderStatus},
      ${notional},
      ${qty},
      ${plan.entry},
      ${plan.stop},
      ${plan.target},
      ${row.final_score},
      ${risk.ok ? reason : `${reason} Rejected: ${risk.reject}.`},
      ${alpacaOrderId ? new Date().toISOString() : null},
      ${alpacaOrderStatus === "filled" ? new Date().toISOString() : null},
      ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()},
      ${JSON.stringify({
        execution: { enabled: executionEnabled, risk },
        alpacaOrder: rawOrder,
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
      lifecycle_status,
      alpaca_order_id,
      alpaca_order_status,
      notional,
      qty,
      entry_price,
      stop_price,
      target_price,
      final_score,
      decision_reason,
      opened_at::text as opened_at,
      submitted_at::text as submitted_at,
      filled_at::text as filled_at,
      expires_at::text as expires_at
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

function formatPaperTradeCloseAlert(trade: PaperTrade) {
  return [
    "RAVEN PAPER TRADE CLOSED",
    "Live trading: disabled",
    "",
    `${trade.ticker} | ${trade.side.toUpperCase()} | ${trade.outcome || "closed"}`,
    `Entry: ${trade.entry_price}`,
    `Exit: ${trade.exit_price}`,
    `P/L: ${trade.pnl_percent ?? 0}%`,
    `Reason: ${trade.close_reason || "review"}`
  ].join("\n");
}

async function sendTradeAlertIfConfigured(trade: PaperTrade, type: "opened" | "closed" = "opened") {
  if (!hasTelegramConfig()) return { sent: false, reason: "telegram_not_configured" };

  try {
    const response = await sendTelegramMessage(type === "closed" ? formatPaperTradeCloseAlert(trade) : formatPaperTradeAlert(trade));
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
        if (trade.status === "rejected") {
          rejects.push({
            ticker: trade.ticker,
            accessionNumber: trade.accession_number,
            score: trade.final_score,
            action: row.action,
            rejects: ["paper_order_risk_check_failed"],
            reasons: [trade.decision_reason]
          });
        } else {
          const telegram = await sendTradeAlertIfConfigured(trade);
          trades.push({
            ticker: trade.ticker,
            accessionNumber: trade.accession_number,
            side: trade.side,
            status: trade.status,
            entry: trade.entry_price,
            stop: trade.stop_price,
            target: trade.target_price,
            notional: trade.notional,
            alpacaOrderId: trade.alpaca_order_id,
            alpacaOrderStatus: trade.alpaca_order_status,
            score: trade.final_score,
            telegram
          });
        }
      }
    } catch (error) {
      errors.push({
        ticker: row.ticker,
        accessionNumber: row.accession_number,
        error: error instanceof Error ? error.message : "Unknown paper-trade failure"
      });
    }
  }

  const recentDecisions = await getLatestPaperDecisions(10);
  const recentTrades = await getLatestPaperTrades(10);

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    evaluated: rows.length,
    opened: trades.length,
    rejected: rejects.length,
    alreadyLogged: recentDecisions.length,
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
      pnl_percent,
      lifecycle_status,
      alpaca_order_id,
      alpaca_order_status,
      notional,
      qty,
      submitted_at::text as submitted_at,
      filled_at::text as filled_at,
      expires_at::text as expires_at
    from paper_trades
    where status in ('pending_entry', 'open')
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
      lifecycle_status = 'closed',
      exit_price = ${roundMoney(exitPrice)},
      closed_at = now(),
      close_reason = ${closeReason},
      outcome = ${outcome},
      pnl_percent = ${round(pnl, 2)}
    where id = ${trade.id}
      and status in ('pending_entry', 'open', 'pending_exit')
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
          const telegram = await sendTradeAlertIfConfigured(closed, "closed");
          closes.push({
            ticker: closed.ticker,
            side: closed.side,
            exit: closed.exit_price,
            outcome: closed.outcome,
            pnlPercent: closed.pnl_percent,
            reason: closed.close_reason,
            telegram
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

  const recentDecisions = await getLatestPaperDecisions(10);
  const recentTrades = await getLatestPaperTrades(10);

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    alpaca: "configured" as const,
    reviewed: openTrades.length,
    closed: closes.length,
    stillOpen: open.length,
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
    lifecycle_status: string | null;
    alpaca_order_id: string | null;
    alpaca_order_status: string | null;
    notional: number | null;
    qty: number | null;
    submitted_at: string | null;
    filled_at: string | null;
    expires_at: string | null;
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
      pnl_percent,
      lifecycle_status,
      alpaca_order_id,
      alpaca_order_status,
      notional,
      qty,
      submitted_at::text as submitted_at,
      filled_at::text as filled_at,
      expires_at::text as expires_at
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
