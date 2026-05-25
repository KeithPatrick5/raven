import { getAlpacaAccount, getAlpacaOrders, getAlpacaPositions, getLatestAlpacaSnapshot, hasAlpacaProvider, placePaperMarketBuyOrder } from "@/lib/alpaca";
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
  alpaca_order_id?: string | null;
  client_order_id?: string | null;
  notional?: number | null;
  qty?: number | null;
  submitted_at?: string | null;
  filled_at?: string | null;
  max_hold_days?: number | null;
};

type OpenTradeRow = PaperTrade & {
  entry_price: number;
  stop_price: number;
  target_price: number;
};

type RiskProfile = {
  enabled: boolean;
  basePositionPercent: number;
  maxPositionPercent: number;
  maxOpenPositions: number;
  maxDailyTrades: number;
  maxDailyLossPercent: number;
  maxHoldDays: number;
  stopLossPercent: number;
  takeProfitPercent: number;
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

function boolEnv(name: string, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function riskProfile(): RiskProfile {
  return {
    enabled: boolEnv("RAVEN_PAPER_EXECUTION_ENABLED", false),
    basePositionPercent: Math.max(0.1, Math.min(5, numberEnv("RAVEN_PAPER_POSITION_PCT", 1))),
    maxPositionPercent: Math.max(0.1, Math.min(10, numberEnv("RAVEN_PAPER_MAX_POSITION_PCT", 2.5))),
    maxOpenPositions: Math.max(1, Math.min(10, Math.floor(numberEnv("RAVEN_PAPER_MAX_OPEN_POSITIONS", 3)))),
    maxDailyTrades: Math.max(1, Math.min(10, Math.floor(numberEnv("RAVEN_PAPER_MAX_DAILY_TRADES", 3)))),
    maxDailyLossPercent: Math.max(0.5, Math.min(10, numberEnv("RAVEN_PAPER_MAX_DAILY_LOSS_PCT", 3))),
    maxHoldDays: Math.max(1, Math.min(20, Math.floor(numberEnv("RAVEN_PAPER_MAX_HOLD_DAYS", 5)))),
    stopLossPercent: Math.max(1, Math.min(20, numberEnv("RAVEN_PAPER_STOP_LOSS_PCT", 4))),
    takeProfitPercent: Math.max(1, Math.min(50, numberEnv("RAVEN_PAPER_TAKE_PROFIT_PCT", 8)))
  };
}

function tradeSide(row: CandidateRow): "long" | null {
  return row.direction.toLowerCase() === "bullish" ? "long" : null;
}

function entryPrice(row: CandidateRow): number | null {
  return asNumber(row.latest_close);
}

function planFor(row: CandidateRow, profile = riskProfile(), equity: number | null = null) {
  const entry = entryPrice(row);
  const side = tradeSide(row);
  const accountEquity = equity && equity > 0 ? equity : 0;
  const baseNotional = accountEquity ? accountEquity * (profile.basePositionPercent / 100) : 0;
  const maxNotional = accountEquity ? accountEquity * (profile.maxPositionPercent / 100) : 0;
  const notional = accountEquity ? roundMoney(Math.min(baseNotional, maxNotional)) : null;

  if (!entry || !side) {
    return { side, entry, stop: null, target: null, notional, qty: null };
  }

  return {
    side,
    entry: roundMoney(entry),
    stop: roundMoney(entry * (1 - profile.stopLossPercent / 100)),
    target: roundMoney(entry * (1 + profile.takeProfitPercent / 100)),
    notional,
    qty: notional ? round(notional / entry, 6) : null
  };
}

function decision(row: CandidateRow, riskRejects: string[] = []) {
  const reasons: string[] = [];
  const rejects: string[] = [...riskRejects];
  const confirmation = row.market_confirmation.toLowerCase();
  const liquidity = (row.liquidity_status || "").toLowerCase();
  const side = tradeSide(row);
  const entry = entryPrice(row);

  reasons.push(`Score ${row.final_score}/100.`);
  reasons.push(`Action ${row.action}.`);
  reasons.push(`Market confirmation ${row.market_confirmation}.`);
  if (row.liquidity_status) reasons.push(`Liquidity ${row.liquidity_status}.`);

  if (row.final_score < 70) rejects.push("score_below_70");
  if (row.action !== "paper_trade_candidate") rejects.push("action_not_trade_eligible");
  if (confirmation !== "confirmed") rejects.push("market_not_confirming");
  if (!["liquid", "active"].includes(liquidity)) rejects.push("liquidity_not_strong_enough");
  if (!side) rejects.push("long_only_engine_rejects_bearish_or_neutral_signal");
  if (!entry) rejects.push("missing_entry_price");

  return {
    shouldOpen: rejects.length === 0,
    decision: rejects.length === 0 ? "pending_entry" : "reject",
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

async function todaysTradeCount() {
  const sql = db();
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from paper_trades
    where opened_at >= date_trunc('day', now())
      and status in ('pending_entry', 'open', 'pending_exit', 'closed')
  `;
  return Number(rows[0]?.count || 0);
}

async function currentOpenPositionCount() {
  const sql = db();
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from paper_trades
    where status in ('pending_entry', 'open', 'pending_exit')
  `;
  return Number(rows[0]?.count || 0);
}

async function existingTradeForTicker(ticker: string) {
  const sql = db();
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from paper_trades
    where ticker = ${ticker}
      and status in ('pending_entry', 'open', 'pending_exit')
  `;
  return Number(rows[0]?.count || 0) > 0;
}

async function accountRiskRejects(row: CandidateRow, profile: RiskProfile) {
  const rejects: string[] = [];

  if (!hasAlpacaProvider()) {
    rejects.push("alpaca_not_configured");
    return { rejects, accountEquity: null, buyingPower: null };
  }

  const [account, positions, openOrders, openCount, dailyCount, duplicateTicker] = await Promise.all([
    getAlpacaAccount("paper"),
    getAlpacaPositions("paper"),
    getAlpacaOrders("paper", "open", 50),
    currentOpenPositionCount(),
    todaysTradeCount(),
    existingTradeForTicker(row.ticker)
  ]);

  const equity = asNumber(account.equity);
  const buyingPower = asNumber(account.buying_power);
  const lastEquity = asNumber(account.last_equity);
  const todayPl = equity !== null && lastEquity !== null ? equity - lastEquity : null;
  const todayLossPct = todayPl !== null && lastEquity && todayPl < 0 ? Math.abs(todayPl / lastEquity) * 100 : 0;
  const totalOpenExposure = Math.max(openCount, positions.length) + openOrders.length;

  if (equity === null || equity <= 0) rejects.push("missing_account_equity");
  if (buyingPower === null || buyingPower <= 0) rejects.push("missing_buying_power");
  if (totalOpenExposure >= profile.maxOpenPositions) rejects.push("max_open_positions_reached");
  if (dailyCount >= profile.maxDailyTrades) rejects.push("max_daily_trades_reached");
  if (todayLossPct >= profile.maxDailyLossPercent) rejects.push("max_daily_loss_reached");
  if (duplicateTicker) rejects.push("ticker_already_active");

  const plan = planFor(row, profile, equity);
  if (plan.notional !== null && buyingPower !== null && plan.notional > buyingPower) rejects.push("insufficient_buying_power");

  return { rejects, accountEquity: equity, buyingPower };
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

function clientOrderId(row: CandidateRow) {
  return `raven-paper-${row.scored_signal_id}-${Date.now()}`.slice(0, 48);
}

async function createPendingTrade(row: CandidateRow, reason: string, profile: RiskProfile, equity: number | null, status = "pending_entry", alpacaOrder?: { id?: string; client_order_id?: string; notional?: string | null; qty?: string | null; submitted_at?: string; filled_at?: string | null; status?: string }) {
  const sql = db();
  const plan = planFor(row, profile, equity);

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
      raw_payload,
      alpaca_order_id,
      client_order_id,
      notional,
      qty,
      submitted_at,
      filled_at,
      max_hold_days
    ) values (
      ${row.scored_signal_id},
      ${row.confirmation_id},
      ${row.accession_number},
      ${row.ticker},
      ${plan.side},
      ${status},
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
        },
        risk: profile
      })}::jsonb,
      ${alpacaOrder?.id || null},
      ${alpacaOrder?.client_order_id || null},
      ${plan.notional},
      ${asNumber(alpacaOrder?.qty) || plan.qty},
      ${alpacaOrder?.submitted_at || null},
      ${alpacaOrder?.filled_at || null},
      ${profile.maxHoldDays}
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
      opened_at::text as opened_at,
      alpaca_order_id,
      client_order_id,
      notional,
      qty,
      submitted_at::text as submitted_at,
      filled_at::text as filled_at,
      max_hold_days
  `;

  return inserted[0] || null;
}

function formatPaperTradeAlert(trade: PaperTrade) {
  return [
    trade.status === "open" ? "RAVEN PAPER ORDER SENT" : "RAVEN PAPER ENTRY QUEUED",
    "Live trading: disabled",
    "",
    `${trade.ticker} | ${trade.side.toUpperCase()} | score ${trade.final_score}/100`,
    `Status: ${trade.status}`,
    `Notional: ${trade.notional ?? "pending"}`,
    `Entry ref: ${trade.entry_price}`,
    `Stop: ${trade.stop_price}`,
    `Target: ${trade.target_price}`,
    trade.alpaca_order_id ? `Alpaca order: ${trade.alpaca_order_id}` : null,
    "",
    `Reason: ${trade.decision_reason}`
  ].filter(Boolean).join("\n");
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
      paperExecution: "disabled" as const,
      evaluated: 0,
      opened: 0,
      pending: 0,
      rejected: 0,
      trades: [],
      pendingEntries: [],
      rejects: [],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const profile = riskProfile();
  const rows = await getOpenCandidates(limit);
  const trades: Array<Record<string, unknown>> = [];
  const pendingEntries: Array<Record<string, unknown>> = [];
  const rejects: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    let risk = { rejects: [] as string[], accountEquity: null as number | null, buyingPower: null as number | null };

    if (hasAlpacaProvider()) {
      try {
        risk = await accountRiskRejects(row, profile);
      } catch (error) {
        risk.rejects.push("account_risk_check_failed");
        errors.push({ ticker: row.ticker, accessionNumber: row.accession_number, error: error instanceof Error ? error.message : "Unknown account risk check failure" });
      }
    } else {
      risk.rejects.push("alpaca_not_configured");
    }

    const verdict = decision(row, risk.rejects);
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

    const reason = [
      ...verdict.reasons,
      `Risk limits passed. Max open ${profile.maxOpenPositions}. Max daily ${profile.maxDailyTrades}. Position ${profile.basePositionPercent}% of paper equity.`,
      profile.enabled ? "Raven submitted this as an Alpaca PAPER market buy. Live trading remains disabled." : "Paper execution is disabled, so Raven queued this as pending_entry only."
    ].join(" ");

    try {
      if (!profile.enabled) {
        const trade = await createPendingTrade(row, reason, profile, risk.accountEquity, "pending_entry");
        if (trade) {
          pendingEntries.push({ ticker: trade.ticker, accessionNumber: trade.accession_number, side: trade.side, status: trade.status, notional: trade.notional, entry: trade.entry_price, stop: trade.stop_price, target: trade.target_price, score: trade.final_score });
        }
        continue;
      }

      const plan = planFor(row, profile, risk.accountEquity);
      if (!plan.notional || plan.notional <= 0) throw new Error("Missing paper order notional after account risk check.");
      const clientId = clientOrderId(row);
      const order = await placePaperMarketBuyOrder({ symbol: row.ticker, notional: plan.notional, clientOrderId: clientId });
      const status = ["filled", "partially_filled"].includes(order.status) ? "open" : "pending_entry";
      const trade = await createPendingTrade(row, reason, profile, risk.accountEquity, status, { ...order, client_order_id: clientId });
      if (trade) {
        const telegram = await sendTradeAlertIfConfigured(trade);
        trades.push({ ticker: trade.ticker, accessionNumber: trade.accession_number, side: trade.side, status: trade.status, notional: trade.notional, orderStatus: order.status, alpacaOrderId: order.id, score: trade.final_score, telegram });
      }
    } catch (error) {
      errors.push({ ticker: row.ticker, accessionNumber: row.accession_number, error: error instanceof Error ? error.message : "Unknown paper-trade failure" });
    }
  }

  const recentDecisions = await getLatestPaperDecisions(10);
  const recentTrades = await getLatestPaperTrades(10);

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    paperExecution: profile.enabled ? "enabled" as const : "disabled" as const,
    evaluated: rows.length,
    opened: trades.filter((trade) => trade.status === "open").length,
    pending: pendingEntries.length + trades.filter((trade) => trade.status === "pending_entry").length,
    rejected: rejects.length,
    alreadyLogged: recentDecisions.length,
    trades,
    pendingEntries,
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
      alpaca_order_id,
      client_order_id,
      notional,
      qty,
      submitted_at::text as submitted_at,
      filled_at::text as filled_at,
      max_hold_days
    from paper_trades
    where status in ('open', 'pending_exit')
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
      and status in ('open', 'pending_exit')
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
      pnl_percent,
      alpaca_order_id,
      client_order_id,
      notional,
      qty,
      submitted_at::text as submitted_at,
      filled_at::text as filled_at,
      max_hold_days
  `;

  return updated[0] || null;
}

function daysOpen(openedAt: string) {
  const opened = new Date(openedAt).getTime();
  if (!Number.isFinite(opened)) return 0;
  return (Date.now() - opened) / 86_400_000;
}

function closeDecision(trade: OpenTradeRow, latestClose: number | null) {
  if (latestClose === null) {
    return { shouldClose: false, reason: "no_latest_price", outcome: "open" };
  }

  if (trade.max_hold_days && daysOpen(trade.opened_at) >= trade.max_hold_days) return { shouldClose: true, reason: "max_hold_hit", outcome: "time_exit" };

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
          closes.push({ ticker: closed.ticker, side: closed.side, exit: closed.exit_price, outcome: closed.outcome, pnlPercent: closed.pnl_percent, reason: closed.close_reason, telegram });
        }
      } else {
        open.push({ ticker: trade.ticker, side: trade.side, entry: trade.entry_price, latestClose: snapshot.latestClose, stop: trade.stop_price, target: trade.target_price, notional: trade.notional, qty: trade.qty, maxHoldDays: trade.max_hold_days, status: verdict.reason });
      }
    } catch (error) {
      errors.push({ ticker: trade.ticker, error: error instanceof Error ? error.message : "Unknown paper-trade review failure" });
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
    alpaca_order_id: string | null;
    client_order_id: string | null;
    notional: number | null;
    qty: number | null;
    submitted_at: string | null;
    filled_at: string | null;
    max_hold_days: number | null;
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
      alpaca_order_id,
      client_order_id,
      notional,
      qty,
      submitted_at::text as submitted_at,
      filled_at::text as filled_at,
      max_hold_days
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
