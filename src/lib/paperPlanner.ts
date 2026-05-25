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

function isActionTradeEligible(action: string) {
  return ["paper_trade_candidate", "high_watch"].includes(action);
}

function isLongEligibleDirection(direction: string) {
  return direction.toLowerCase() === "bullish";
}

function isMarketConfirming(status: string) {
  return status.toLowerCase() === "confirmed";
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
      s.created_at::text as created_at
    from scored_signals s
    left join alpaca_market_confirmations c
      on c.id = s.confirmation_id
    order by s.created_at desc, s.final_score desc
    limit ${limit}
  `;
}

function planCandidate(
  row: PaperPlanCandidate,
  account: { equity: number | null; cash: number | null; buyingPower: number | null },
  active: Set<string>,
  openPositionCount: number,
  openOrderCount: number
): PaperTradePlan {
  const minScore = envNumber("RAVEN_MIN_SCORE_TO_TRADE", DEFAULT_MIN_SCORE);
  const maxNotional = envNumber("RAVEN_MAX_NOTIONAL_PER_TRADE", DEFAULT_MAX_NOTIONAL);
  const positionPct = envNumber("RAVEN_MAX_POSITION_PCT", DEFAULT_POSITION_PCT);
  const maxOpenPositions = envNumber("RAVEN_MAX_OPEN_POSITIONS", DEFAULT_MAX_OPEN_POSITIONS);
  const maxDailyTrades = envNumber("RAVEN_MAX_DAILY_TRADES", DEFAULT_MAX_DAILY_TRADES);
  const stopPct = envNumber("RAVEN_STOP_LOSS_PCT", DEFAULT_STOP_LOSS_PCT);
  const targetPct = envNumber("RAVEN_TAKE_PROFIT_PCT", DEFAULT_TAKE_PROFIT_PCT);
  const maxHoldDays = envNumber("RAVEN_MAX_HOLD_DAYS", DEFAULT_MAX_HOLD_DAYS);
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

  if (row.final_score < minScore) rejectCodes.push("score_below_minimum");
  if (!isActionTradeEligible(row.action)) rejectCodes.push("action_not_trade_eligible");
  if (isDangerAction(row.action)) rejectCodes.push("risk_action_not_long_trade");
  if (!isLongEligibleDirection(row.direction)) rejectCodes.push("long_only_rejects_non_bullish_signal");
  if (!isMarketConfirming(row.market_confirmation)) rejectCodes.push("market_not_confirmed");
  if (!isLiquidityAcceptable(row.liquidity_status)) rejectCodes.push("liquidity_not_strong_enough");
  if (latestPrice === null || latestPrice <= 0) rejectCodes.push("missing_latest_price");
  if (equity === null || equity <= 0) rejectCodes.push("missing_account_equity");
  if (cash === null || cash <= 0) rejectCodes.push("missing_cash");
  if (active.has(row.ticker.toUpperCase())) rejectCodes.push("already_has_position_or_open_order");
  if (openPositionCount + openOrderCount >= maxOpenPositions) rejectCodes.push("max_open_positions_reached");
  if (maxDailyTrades <= 0) rejectCodes.push("daily_trade_limit_zero");

  const notionalFromEquity = equity === null ? null : equity * (positionPct / 100);
  const affordable = cash === null ? null : cash;
  const suggestedNotional = notionalFromEquity === null || affordable === null
    ? null
    : round(Math.min(notionalFromEquity, maxNotional, affordable), 2);

  if (suggestedNotional === null || suggestedNotional <= 0) rejectCodes.push("missing_trade_size");

  const estimatedShares = latestPrice !== null && suggestedNotional !== null ? round(suggestedNotional / latestPrice, 4) : null;
  const stopPrice = latestPrice !== null ? round(latestPrice * (1 - stopPct / 100), 2) : null;
  const targetPrice = latestPrice !== null ? round(latestPrice * (1 + targetPct / 100), 2) : null;
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
    maxHoldDays,
    rejectCodes,
    reasons,
    risks,
    account
  };
}

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
      riskLimits: {
        minScore: DEFAULT_MIN_SCORE,
        maxPositionPct: DEFAULT_POSITION_PCT,
        maxNotionalPerTrade: DEFAULT_MAX_NOTIONAL,
        maxOpenPositions: DEFAULT_MAX_OPEN_POSITIONS,
        maxDailyTrades: DEFAULT_MAX_DAILY_TRADES,
        stopLossPct: DEFAULT_STOP_LOSS_PCT,
        takeProfitPct: DEFAULT_TAKE_PROFIT_PCT,
        maxHoldDays: DEFAULT_MAX_HOLD_DAYS
      },
      plans: [] as PaperTradePlan[],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const [snapshot, candidates] = await Promise.all([
    getAlpacaPaperSnapshot(25),
    getPlanCandidates(limit)
  ]);

  const account = {
    equity: snapshot.summary.equity,
    cash: snapshot.summary.cash,
    buyingPower: snapshot.summary.buyingPower
  };
  const active = activeSymbols(snapshot.positions, snapshot.orders);
  const plans = candidates.map((candidate) => planCandidate(candidate, account, active, snapshot.summary.openPositionCount, snapshot.summary.openOrderCount));

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
    riskLimits: {
      minScore: envNumber("RAVEN_MIN_SCORE_TO_TRADE", DEFAULT_MIN_SCORE),
      maxPositionPct: envNumber("RAVEN_MAX_POSITION_PCT", DEFAULT_POSITION_PCT),
      maxNotionalPerTrade: envNumber("RAVEN_MAX_NOTIONAL_PER_TRADE", DEFAULT_MAX_NOTIONAL),
      maxOpenPositions: envNumber("RAVEN_MAX_OPEN_POSITIONS", DEFAULT_MAX_OPEN_POSITIONS),
      maxDailyTrades: envNumber("RAVEN_MAX_DAILY_TRADES", DEFAULT_MAX_DAILY_TRADES),
      stopLossPct: envNumber("RAVEN_STOP_LOSS_PCT", DEFAULT_STOP_LOSS_PCT),
      takeProfitPct: envNumber("RAVEN_TAKE_PROFIT_PCT", DEFAULT_TAKE_PROFIT_PCT),
      maxHoldDays: envNumber("RAVEN_MAX_HOLD_DAYS", DEFAULT_MAX_HOLD_DAYS)
    },
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
  lines.push(`Buying power: ${money(result.account.buyingPower)}`);
  lines.push(`Open positions: ${result.account.openPositionCount}`);
  lines.push(`Open orders: ${result.account.openOrderCount}`);
  lines.push("");
  lines.push("PLANNER READ");
  lines.push("------------");
  if (top) {
    lines.push(top.wouldTrade
      ? `Top candidate ${top.ticker} is eligible for a future paper order, but 13B does not submit orders.`
      : `Top candidate ${top.ticker} is rejected for now because ${top.rejectCodes.slice(0, 4).map(clean).join(", ")}.`);
  } else {
    lines.push("No scored candidates available for planning.");
  }
  lines.push("");
  lines.push("RISK LIMITS");
  lines.push("-----------");
  lines.push(`Min score: ${result.riskLimits.minScore}`);
  lines.push(`Max position: ${result.riskLimits.maxPositionPct}% of equity`);
  lines.push(`Max notional: ${money(result.riskLimits.maxNotionalPerTrade)}`);
  lines.push(`Max open positions: ${result.riskLimits.maxOpenPositions}`);
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
        lines.push(`  Reject: ${plan.rejectCodes.slice(0, 5).map(clean).join(", ") || "none"}`);
      }
    }
  }
  lines.push("");
  lines.push("COPY NOTE");
  lines.push("---------");
  lines.push("Paste this report into ChatGPT when you want Raven paper-planner help.");

  return lines.join("\n");
}
