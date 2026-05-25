import { getAlpacaPaperSnapshot, type AlpacaPaperOrder, type AlpacaPaperPosition } from "@/lib/alpacaTrading";
import { db, hasDatabase, ensureRavenTables } from "@/lib/db";

export type PaperPlanCandidate = {
  scored_signal_id: number;
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
  reason_codes: string[] | string | null;
  risk_flags: string[] | string | null;
  latest_close: number | string | null;
  price_change_percent: number | string | null;
  relative_volume: number | string | null;
  liquidity_status: string | null;
  price_status: string | null;
  created_at: string;
  candidate_tier: string | null;
  event_quality_score: number | string | null;
  market_anomaly_score: number | string | null;
  market_anomaly_status: string | null;
  market_anomaly_direction: string | null;
};

export type PaperRiskLimits = {
  minScore: number;
  maxPositionPct: number;
  maxNotionalPerTrade: number;
  maxOpenPositions: number;
  maxDailyTrades: number;
  maxDailyLossPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldDays: number;
  killSwitch: boolean;
  sizingBasis: "cash_equity_only";
};

export type PaperRiskState = {
  dailyTradesUsed: number;
  dailyTradesRemaining: number;
  dayPl: number | null;
  dayPlPct: number | null;
  dailyLossLimitHit: boolean;
  openExposure: number;
  openExposurePct: number | null;
  cashAvailableForNewTrades: number | null;
  riskStatus: "ok" | "blocked";
  blocks: string[];
};

export type PaperTradePlan = {
  scoredSignalId: number;
  ticker: string;
  accessionNumber: string;
  form: string;
  wouldTrade: boolean;
  decision: "eligible_pending_execution" | "reject";
  side: "buy" | "none";
  score: number;
  action: string;
  summary: string;
  latestPrice: number | null;
  suggestedNotional: number | null;
  estimatedShares: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  maxHoldDays: number;
  rejectCodes: string[];
  reasons: string[];
  risks: string[];
  account: {
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
  };
};

const DEFAULT_MAX_NOTIONAL = 1000;
const DEFAULT_POSITION_PCT = 1;
const DEFAULT_MAX_OPEN_POSITIONS = 3;
const DEFAULT_MAX_DAILY_TRADES = 3;
const DEFAULT_MAX_DAILY_LOSS_PCT = 2;
const DEFAULT_MIN_SCORE = 70;
const DEFAULT_STOP_LOSS_PCT = 4;
const DEFAULT_TAKE_PROFIT_PCT = 8;
const DEFAULT_MAX_HOLD_DAYS = 5;

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback = false) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function round(value: number | null, decimals = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parseList(value: string[] | string | null): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function isOpenOrder(order: AlpacaPaperOrder) {
  return ["new", "accepted", "pending_new", "partially_filled", "held"].includes((order.status || "").toLowerCase());
}

function activeSymbols(positions: AlpacaPaperPosition[], orders: AlpacaPaperOrder[]) {
  const symbols = new Set<string>();
  for (const position of positions) symbols.add(position.symbol.toUpperCase());
  for (const order of orders.filter(isOpenOrder)) symbols.add(order.symbol.toUpperCase());
  return symbols;
}

function riskLimits(): PaperRiskLimits {
  return {
    minScore: envNumber("RAVEN_MIN_SCORE_TO_TRADE", DEFAULT_MIN_SCORE),
    maxPositionPct: envNumber("RAVEN_MAX_POSITION_PCT", DEFAULT_POSITION_PCT),
    maxNotionalPerTrade: envNumber("RAVEN_MAX_NOTIONAL_PER_TRADE", DEFAULT_MAX_NOTIONAL),
    maxOpenPositions: envNumber("RAVEN_MAX_OPEN_POSITIONS", DEFAULT_MAX_OPEN_POSITIONS),
    maxDailyTrades: envNumber("RAVEN_MAX_DAILY_TRADES", DEFAULT_MAX_DAILY_TRADES),
    maxDailyLossPct: envNumber("RAVEN_MAX_DAILY_LOSS_PCT", DEFAULT_MAX_DAILY_LOSS_PCT),
    stopLossPct: envNumber("RAVEN_STOP_LOSS_PCT", DEFAULT_STOP_LOSS_PCT),
    takeProfitPct: envNumber("RAVEN_TAKE_PROFIT_PCT", DEFAULT_TAKE_PROFIT_PCT),
    maxHoldDays: envNumber("RAVEN_MAX_HOLD_DAYS", DEFAULT_MAX_HOLD_DAYS),
    killSwitch: envBool("RAVEN_KILL_SWITCH", false),
    sizingBasis: "cash_equity_only"
  };
}

function isActionTradeEligible(action: string) {
  return ["paper_trade_candidate", "high_watch"].includes(action);
}

function isLongEligibleDirection(direction: string) {
  return direction.toLowerCase() === "bullish";
}

function isMarketConfirming(status: string) {
  return status.toLowerCase() === "confirmed";
}

function hasBucketMarketConfirmation(row: PaperPlanCandidate) {
  const anomalyScore = asNumber(row.market_anomaly_score) || 0;
  const anomalyDirection = (row.market_anomaly_direction || "").toLowerCase();
  const eventQuality = asNumber(row.event_quality_score) || 0;
  return eventQuality >= 80 && anomalyScore >= 55 && anomalyDirection === "bullish";
}

function isLiquidityAcceptable(status: string | null) {
  return ["liquid", "active"].includes((status || "").toLowerCase());
}

function isDangerAction(action: string) {
  return ["dilution_watch", "shelf_watch", "late_filing_risk", "danger_watch", "avoid"].includes(action);
}

function cleanSummary(text: string) {
  return text.length > 220 ? `${text.slice(0, 220).trim()}...` : text;
}

async function getPlanCandidates(limit: number): Promise<PaperPlanCandidate[]> {
  const sql = db();
  return sql<PaperPlanCandidate[]>`
    select
      s.id as scored_signal_id,
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
      s.created_at::text as created_at,
      cr.tier as candidate_tier,
      cr.event_quality_score,
      ma.anomaly_score as market_anomaly_score,
      ma.anomaly_status as market_anomaly_status,
      ma.direction as market_anomaly_direction
    from scored_signals s
    left join alpaca_market_confirmations c
      on c.id = s.confirmation_id
    left join candidate_rankings cr
      on cr.source_event_id = s.accession_number
    left join market_anomalies ma
      on ma.ticker = s.ticker
    order by s.created_at desc, s.final_score desc
    limit ${limit}
  `;
}

async function getDailyPaperTradeCount() {
  if (!hasDatabase()) return 0;
  const sql = db();
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from paper_order_submissions
    where created_at >= date_trunc('day', now())
      and status in ('submitted', 'filled', 'accepted', 'open')
  `;
  return Number(rows[0]?.count || 0);
}

function buildRiskState(args: {
  limits: PaperRiskLimits;
  equity: number | null;
  cash: number | null;
  lastEquity: number | null;
  openPositionCount: number;
  openOrderCount: number;
  dailyTradesUsed: number;
  positions: AlpacaPaperPosition[];
}): PaperRiskState {
  const blocks: string[] = [];
  const openExposure = round(args.positions.reduce((sum, position) => sum + (asNumber(position.market_value) || 0), 0), 2) || 0;
  const dayPl = args.equity !== null && args.lastEquity !== null ? round(args.equity - args.lastEquity, 2) : null;
  const dayPlPct = dayPl !== null && args.lastEquity !== null && args.lastEquity > 0 ? round((dayPl / args.lastEquity) * 100, 2) : null;
  const dailyLossLimitHit = dayPlPct !== null && dayPlPct <= -Math.abs(args.limits.maxDailyLossPct);
  const dailyTradesRemaining = Math.max(0, args.limits.maxDailyTrades - args.dailyTradesUsed);

  if (args.limits.killSwitch) blocks.push("kill_switch_on");
  if (args.dailyTradesUsed >= args.limits.maxDailyTrades) blocks.push("max_daily_trades_reached");
  if (dailyLossLimitHit) blocks.push("max_daily_loss_reached");
  if (args.openPositionCount + args.openOrderCount >= args.limits.maxOpenPositions) blocks.push("max_open_positions_reached");
  if (args.cash === null || args.cash <= 0) blocks.push("no_cash_available");

  return {
    dailyTradesUsed: args.dailyTradesUsed,
    dailyTradesRemaining,
    dayPl,
    dayPlPct,
    dailyLossLimitHit,
    openExposure,
    openExposurePct: args.equity && args.equity > 0 ? round((openExposure / args.equity) * 100, 2) : null,
    cashAvailableForNewTrades: args.cash,
    riskStatus: blocks.length ? "blocked" : "ok",
    blocks
  };
}

function planCandidate(
  row: PaperPlanCandidate,
  account: { equity: number | null; cash: number | null; buyingPower: number | null },
  active: Set<string>,
  openPositionCount: number,
  openOrderCount: number,
  limits: PaperRiskLimits,
  riskState: PaperRiskState
): PaperTradePlan {
  const latestPrice = asNumber(row.latest_close);
  const equity = account.equity;
  const cash = account.cash;
  const rejectCodes: string[] = [];
  const reasons: string[] = [];

  reasons.push(`Score ${row.final_score}/100.`);
  reasons.push(`Action ${row.action}.`);
  reasons.push(`Direction ${row.direction}.`);
  reasons.push(`Market confirmation ${row.market_confirmation}.`);
  if (row.liquidity_status) reasons.push(`Liquidity ${row.liquidity_status}.`);
  if (row.candidate_tier) reasons.push(`Event quality ${row.candidate_tier} (${row.event_quality_score ?? "?"}/100).`);
  if (row.market_anomaly_score !== null) reasons.push(`Market anomaly ${row.market_anomaly_score}/100 (${row.market_anomaly_status || "unknown"}).`);

  if (limits.killSwitch) rejectCodes.push("kill_switch_on");
  if (riskState.dailyTradesUsed >= limits.maxDailyTrades) rejectCodes.push("max_daily_trades_reached");
  if (riskState.dailyLossLimitHit) rejectCodes.push("max_daily_loss_reached");
  if (row.final_score < limits.minScore) rejectCodes.push("score_below_minimum");
  if (!isActionTradeEligible(row.action)) rejectCodes.push("action_not_trade_eligible");
  if (isDangerAction(row.action) || (row.candidate_tier || "") === "risk_only") rejectCodes.push("risk_action_not_long_trade");
  if (!isLongEligibleDirection(row.direction)) rejectCodes.push("long_only_rejects_non_bullish_signal");
  if (!isMarketConfirming(row.market_confirmation) && !hasBucketMarketConfirmation(row)) rejectCodes.push("market_not_confirmed");
  if (!isLiquidityAcceptable(row.liquidity_status)) rejectCodes.push("liquidity_not_strong_enough");
  if (latestPrice === null || latestPrice <= 0) rejectCodes.push("missing_latest_price");
  if (equity === null || equity <= 0) rejectCodes.push("missing_account_equity");
  if (cash === null || cash <= 0) rejectCodes.push("missing_cash");
  if (active.has(row.ticker.toUpperCase())) rejectCodes.push("already_has_position_or_open_order");
  if (openPositionCount + openOrderCount >= limits.maxOpenPositions) rejectCodes.push("max_open_positions_reached");
  if (limits.maxDailyTrades <= 0) rejectCodes.push("daily_trade_limit_zero");

  const notionalFromEquity = equity === null ? null : equity * (limits.maxPositionPct / 100);
  const affordable = cash === null ? null : cash;
  const suggestedNotional = notionalFromEquity === null || affordable === null
    ? null
    : round(Math.min(notionalFromEquity, limits.maxNotionalPerTrade, affordable), 2);

  if (suggestedNotional === null || suggestedNotional <= 0) rejectCodes.push("missing_trade_size");

  const estimatedShares = latestPrice !== null && suggestedNotional !== null ? round(suggestedNotional / latestPrice, 4) : null;
  const stopPrice = latestPrice !== null ? round(latestPrice * (1 - limits.stopLossPct / 100), 2) : null;
  const targetPrice = latestPrice !== null ? round(latestPrice * (1 + limits.takeProfitPct / 100), 2) : null;
  const risks = parseList(row.risk_flags);

  return {
    scoredSignalId: row.scored_signal_id,
    ticker: row.ticker,
    accessionNumber: row.accession_number,
    form: row.form,
    wouldTrade: rejectCodes.length === 0,
    decision: rejectCodes.length === 0 ? "eligible_pending_execution" : "reject",
    side: rejectCodes.length === 0 ? "buy" : "none",
    score: row.final_score,
    action: row.action,
    summary: cleanSummary(row.readable_summary),
    latestPrice: round(latestPrice),
    suggestedNotional,
    estimatedShares,
    stopPrice,
    targetPrice,
    maxHoldDays: limits.maxHoldDays,
    rejectCodes,
    reasons,
    risks,
    account
  };
}

const fallbackRiskLimits = riskLimits();
const fallbackRiskState: PaperRiskState = {
  dailyTradesUsed: 0,
  dailyTradesRemaining: fallbackRiskLimits.maxDailyTrades,
  dayPl: null,
  dayPlPct: null,
  dailyLossLimitHit: false,
  openExposure: 0,
  openExposurePct: null,
  cashAvailableForNewTrades: null,
  riskStatus: fallbackRiskLimits.killSwitch ? "blocked" : "ok",
  blocks: fallbackRiskLimits.killSwitch ? ["kill_switch_on"] : []
};

export async function getPaperTradePlan(limit = 10) {
  const startedAt = new Date().toISOString();
  if (!hasDatabase()) {
    return {
      ok: false,
      phase: "PAPER_TRADE_PLANNER",
      mode: "plan_only_no_orders",
      startedAt,
      finishedAt: new Date().toISOString(),
      database: "not_configured" as const,
      alpaca: "unknown" as const,
      liveTrading: "disabled" as const,
      paperTrading: "not_enabled_for_execution" as const,
      candidatesReviewed: 0,
      eligible: 0,
      rejected: 0,
      account: { equity: null, cash: null, buyingPower: null, openPositionCount: 0, openOrderCount: 0 },
      riskLimits: fallbackRiskLimits,
      riskState: fallbackRiskState,
      plans: [] as PaperTradePlan[],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const [snapshot, candidates, dailyTradesUsed] = await Promise.all([
    getAlpacaPaperSnapshot(25),
    getPlanCandidates(limit),
    getDailyPaperTradeCount()
  ]);

  const limits = riskLimits();
  const account = {
    equity: snapshot.summary.equity,
    cash: snapshot.summary.cash,
    buyingPower: snapshot.summary.buyingPower
  };
  const active = activeSymbols(snapshot.positions, snapshot.orders);
  const riskState = buildRiskState({
    limits,
    equity: snapshot.summary.equity,
    cash: snapshot.summary.cash,
    lastEquity: snapshot.summary.lastEquity,
    openPositionCount: snapshot.summary.openPositionCount,
    openOrderCount: snapshot.summary.openOrderCount,
    dailyTradesUsed,
    positions: snapshot.positions
  });
  const plans = candidates.map((candidate) => planCandidate(
    candidate,
    account,
    active,
    snapshot.summary.openPositionCount,
    snapshot.summary.openOrderCount,
    limits,
    riskState
  ));

  return {
    ok: snapshot.ok,
    phase: "PAPER_TRADE_PLANNER",
    mode: "plan_only_no_orders" as const,
    startedAt,
    finishedAt: new Date().toISOString(),
    database: "configured" as const,
    alpaca: snapshot.configured ? "configured" as const : "not_configured" as const,
    liveTrading: "disabled" as const,
    paperTrading: "not_enabled_for_execution" as const,
    account: {
      equity: snapshot.summary.equity,
      cash: snapshot.summary.cash,
      buyingPower: snapshot.summary.buyingPower,
      openPositionCount: snapshot.summary.openPositionCount,
      openOrderCount: snapshot.summary.openOrderCount
    },
    riskLimits: limits,
    riskState,
    candidatesReviewed: plans.length,
    eligible: plans.filter((plan) => plan.wouldTrade).length,
    rejected: plans.filter((plan) => !plan.wouldTrade).length,
    plans,
    errors: snapshot.errors
  };
}

function money(value: number | null) {
  if (value === null) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function clean(value: string) {
  return value.split("_").join(" ");
}

export async function getPaperTradePlanTextReport(limit = 8) {
  const result = await getPaperTradePlan(limit);
  const lines: string[] = [];
  const top = result.plans[0];

  lines.push("RAVEN PAPER TRADE PLAN");
  lines.push("======================");
  lines.push(`Status: ${result.ok ? "ok" : "needs_attention"}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push("Live trading: disabled");
  lines.push("Order submission: disabled");
  lines.push("");
  lines.push("ACCOUNT");
  lines.push("-------");
  lines.push(`Equity: ${money(result.account.equity)}`);
  lines.push(`Cash: ${money(result.account.cash)}`);
  lines.push(`Buying power: ${money(result.account.buyingPower)} (not used for sizing)`);
  lines.push(`Open positions: ${result.account.openPositionCount}`);
  lines.push(`Open orders: ${result.account.openOrderCount}`);
  lines.push("");
  lines.push("PLANNER READ");
  lines.push("------------");
  if (result.riskState.riskStatus === "blocked") {
    lines.push(`New paper entries are globally blocked because ${result.riskState.blocks.map(clean).join(", ")}.`);
  } else if (top) {
    lines.push(top.wouldTrade
      ? `Top candidate ${top.ticker} is eligible for a future paper order, but this report does not submit orders.`
      : `Top candidate ${top.ticker} is rejected for now because ${top.rejectCodes.slice(0, 4).map(clean).join(", ")}.`);
  } else {
    lines.push("No scored candidates available for planning.");
  }
  lines.push("");
  lines.push("RISK LIMITS");
  lines.push("-----------");
  lines.push(`Risk status: ${result.riskState.riskStatus}`);
  lines.push(`Kill switch: ${result.riskLimits.killSwitch ? "on" : "off"}`);
  lines.push(`Sizing basis: cash/equity only. Buying power is ignored.`);
  lines.push(`Min score: ${result.riskLimits.minScore}`);
  lines.push(`Max position: ${result.riskLimits.maxPositionPct}% of equity`);
  lines.push(`Max notional: ${money(result.riskLimits.maxNotionalPerTrade)}`);
  lines.push(`Max open positions: ${result.riskLimits.maxOpenPositions}`);
  lines.push(`Daily trades: ${result.riskState.dailyTradesUsed}/${result.riskLimits.maxDailyTrades} used`);
  lines.push(`Daily loss limit: ${result.riskLimits.maxDailyLossPct}% | today ${result.riskState.dayPlPct ?? "--"}%`);
  lines.push(`Open exposure: ${money(result.riskState.openExposure)} (${result.riskState.openExposurePct ?? "--"}%)`);
  lines.push(`Stop / target: -${result.riskLimits.stopLossPct}% / +${result.riskLimits.takeProfitPct}%`);
  lines.push(`Max hold: ${result.riskLimits.maxHoldDays} days`);
  lines.push("");
  lines.push("CANDIDATES");
  lines.push("----------");
  if (!result.plans.length) {
    lines.push("None");
  } else {
    for (const plan of result.plans.slice(0, limit)) {
      lines.push(`- ${plan.ticker} | ${plan.wouldTrade ? "ELIGIBLE" : "reject"} | score ${plan.score} | ${plan.action} | ${plan.summary}`);
      if (plan.wouldTrade) {
        lines.push(`  Plan: buy about ${plan.estimatedShares ?? "--"} shares / ${money(plan.suggestedNotional)} | stop ${money(plan.stopPrice)} | target ${money(plan.targetPrice)} | max hold ${plan.maxHoldDays} days`);
      } else {
        lines.push(`  Reject: ${plan.rejectCodes.slice(0, 6).map(clean).join(", ") || "none"}`);
      }
    }
  }
  lines.push("");
  lines.push("COPY NOTE");
  lines.push("---------");
  lines.push("Paste this report into ChatGPT when you want Raven paper-planner help.");

  return lines.join("\n");
}

export async function getPaperRiskTextReport() {
  const result = await getPaperTradePlan(1);
  const lines: string[] = [];
  lines.push("RAVEN PAPER RISK LIMITS");
  lines.push("=======================");
  lines.push(`Status: ${result.ok ? "ok" : "needs_attention"}`);
  lines.push(`Risk status: ${result.riskState.riskStatus}`);
  lines.push("");
  lines.push("ACCOUNT BASIS");
  lines.push("-------------");
  lines.push(`Equity: ${money(result.account.equity)}`);
  lines.push(`Cash: ${money(result.account.cash)}`);
  lines.push(`Buying power: ${money(result.account.buyingPower)} (ignored for sizing)`);
  lines.push("");
  lines.push("LIMITS");
  lines.push("------");
  lines.push(`Kill switch: ${result.riskLimits.killSwitch ? "on" : "off"}`);
  lines.push(`Min score: ${result.riskLimits.minScore}`);
  lines.push(`Max notional: ${money(result.riskLimits.maxNotionalPerTrade)}`);
  lines.push(`Max position: ${result.riskLimits.maxPositionPct}% of equity`);
  lines.push(`Max open positions: ${result.riskLimits.maxOpenPositions}`);
  lines.push(`Max daily trades: ${result.riskLimits.maxDailyTrades}`);
  lines.push(`Max daily loss: ${result.riskLimits.maxDailyLossPct}%`);
  lines.push(`Stop / target: -${result.riskLimits.stopLossPct}% / +${result.riskLimits.takeProfitPct}%`);
  lines.push(`Max hold: ${result.riskLimits.maxHoldDays} days`);
  lines.push("");
  lines.push("CURRENT USAGE");
  lines.push("-------------");
  lines.push(`Open exposure: ${money(result.riskState.openExposure)} (${result.riskState.openExposurePct ?? "--"}%)`);
  lines.push(`Daily trades used: ${result.riskState.dailyTradesUsed}`);
  lines.push(`Daily trades remaining: ${result.riskState.dailyTradesRemaining}`);
  lines.push(`Today P/L: ${money(result.riskState.dayPl)} (${result.riskState.dayPlPct ?? "--"}%)`);
  lines.push(`Blocks: ${result.riskState.blocks.length ? result.riskState.blocks.map(clean).join(", ") : "none"}`);
  return lines.join("\n");
}
