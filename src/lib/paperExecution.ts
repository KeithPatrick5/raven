import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { submitAlpacaPaperMarketOrder } from "@/lib/alpacaTrading";
import { getPaperTradePlan, type PaperTradePlan } from "@/lib/paperPlanner";

type ExecutionMode = "preview_only" | "execution_disabled" | "paper_execution_enabled";

type PaperExecutionResult = {
  ok: boolean;
  phase: "PAPER_ORDER_EXECUTION_SWITCH";
  mode: ExecutionMode;
  startedAt: string;
  finishedAt: string;
  liveTrading: "disabled";
  paperTradingEnabled: boolean;
  orderSubmission: "disabled" | "preview_only" | "submitted" | "blocked" | "failed";
  account: {
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
    openPositionCount: number;
    openOrderCount: number;
  };
  candidatesReviewed: number;
  eligible: number;
  selectedPlan: PaperTradePlan | null;
  submittedOrder: unknown | null;
  duplicate: boolean;
  messages: string[];
  errors: Array<{ error: string }>;
};

function paperTradingEnabled() {
  return (process.env.RAVEN_PAPER_TRADING_ENABLED || "false").toLowerCase() === "true";
}

function liveTradingEnabled() {
  return (process.env.RAVEN_LIVE_TRADING_ENABLED || "false").toLowerCase() === "true";
}

function clientOrderId(plan: PaperTradePlan) {
  return `raven-paper-${plan.scoredSignalId}-${Date.now()}`.slice(0, 48);
}

async function existingSubmission(scoredSignalId: number) {
  const sql = db();
  const rows = await sql<{ id: number; status: string; alpaca_order_id: string | null; client_order_id: string | null }[]>`
    select id, status, alpaca_order_id, client_order_id
    from paper_order_submissions
    where scored_signal_id = ${scoredSignalId}
    limit 1
  `;
  return rows[0] || null;
}

async function recordSubmission(
  plan: PaperTradePlan,
  status: string,
  clientId: string,
  order: unknown | null,
  errorMessage: string | null
) {
  const sql = db();
  const maybeOrder = order && typeof order === "object" ? order as { id?: string } : {};
  await sql`
    insert into paper_order_submissions (
      scored_signal_id,
      accession_number,
      ticker,
      side,
      status,
      requested_notional,
      estimated_shares,
      stop_price,
      target_price,
      max_hold_days,
      client_order_id,
      alpaca_order_id,
      raw_plan,
      raw_order,
      error_message,
      updated_at
    ) values (
      ${plan.scoredSignalId},
      ${plan.accessionNumber},
      ${plan.ticker},
      ${plan.side},
      ${status},
      ${plan.suggestedNotional},
      ${plan.estimatedShares},
      ${plan.stopPrice},
      ${plan.targetPrice},
      ${plan.maxHoldDays},
      ${clientId},
      ${maybeOrder.id || null},
      ${JSON.stringify(plan)}::jsonb,
      ${JSON.stringify(order || {})}::jsonb,
      ${errorMessage},
      now()
    )
    on conflict (scored_signal_id) do update set
      status = excluded.status,
      raw_plan = excluded.raw_plan,
      raw_order = excluded.raw_order,
      error_message = excluded.error_message,
      updated_at = now()
  `;
}

export async function runPaperOrderExecution(options: { submit: boolean }): Promise<PaperExecutionResult> {
  const startedAt = new Date().toISOString();
  const enabled = paperTradingEnabled();
  const messages: string[] = [];

  if (liveTradingEnabled()) {
    return {
      ok: false,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "execution_disabled",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: enabled,
      orderSubmission: "blocked",
      account: { equity: null, cash: null, buyingPower: null, openPositionCount: 0, openOrderCount: 0 },
      candidatesReviewed: 0,
      eligible: 0,
      selectedPlan: null,
      submittedOrder: null,
      duplicate: false,
      messages: ["Blocked because RAVEN_LIVE_TRADING_ENABLED is true. 13C is paper-only."],
      errors: [{ error: "Live trading flag must stay disabled for 13C." }]
    };
  }

  if (!hasDatabase()) {
    return {
      ok: false,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: enabled ? "paper_execution_enabled" : "execution_disabled",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: enabled,
      orderSubmission: "blocked",
      account: { equity: null, cash: null, buyingPower: null, openPositionCount: 0, openOrderCount: 0 },
      candidatesReviewed: 0,
      eligible: 0,
      selectedPlan: null,
      submittedOrder: null,
      duplicate: false,
      messages: [],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const planResult = await getPaperTradePlan(10);
  const eligiblePlans = planResult.plans.filter((plan) => plan.wouldTrade);
  const selectedPlan = eligiblePlans[0] || null;

  if (!enabled) {
    messages.push("Paper execution switch is off. Set RAVEN_PAPER_TRADING_ENABLED=true to allow paper orders later.");
  }

  if (!selectedPlan) {
    messages.push("No eligible paper trade candidate passed all gates.");
  }

  if (!options.submit) {
    return {
      ok: planResult.ok,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "preview_only",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: enabled,
      orderSubmission: "preview_only",
      account: planResult.account,
      candidatesReviewed: planResult.candidatesReviewed,
      eligible: planResult.eligible,
      selectedPlan,
      submittedOrder: null,
      duplicate: false,
      messages,
      errors: planResult.errors
    };
  }

  if (!enabled) {
    return {
      ok: planResult.ok,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "execution_disabled",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: false,
      orderSubmission: "disabled",
      account: planResult.account,
      candidatesReviewed: planResult.candidatesReviewed,
      eligible: planResult.eligible,
      selectedPlan,
      submittedOrder: null,
      duplicate: false,
      messages,
      errors: planResult.errors
    };
  }

  if (!selectedPlan) {
    return {
      ok: planResult.ok,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "paper_execution_enabled",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: true,
      orderSubmission: "blocked",
      account: planResult.account,
      candidatesReviewed: planResult.candidatesReviewed,
      eligible: planResult.eligible,
      selectedPlan: null,
      submittedOrder: null,
      duplicate: false,
      messages,
      errors: planResult.errors
    };
  }

  const duplicate = await existingSubmission(selectedPlan.scoredSignalId);
  if (duplicate) {
    messages.push(`Already has a paper order submission record for ${selectedPlan.ticker}.`);
    return {
      ok: true,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "paper_execution_enabled",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: true,
      orderSubmission: "blocked",
      account: planResult.account,
      candidatesReviewed: planResult.candidatesReviewed,
      eligible: planResult.eligible,
      selectedPlan,
      submittedOrder: duplicate,
      duplicate: true,
      messages,
      errors: []
    };
  }

  const clientId = clientOrderId(selectedPlan);

  try {
    const order = await submitAlpacaPaperMarketOrder({
      symbol: selectedPlan.ticker,
      side: "buy",
      notional: selectedPlan.suggestedNotional || 0,
      clientOrderId: clientId
    });
    await recordSubmission(selectedPlan, "submitted", clientId, order, null);
    messages.push(`Submitted Alpaca paper market order for ${selectedPlan.ticker}.`);

    return {
      ok: true,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "paper_execution_enabled",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: true,
      orderSubmission: "submitted",
      account: planResult.account,
      candidatesReviewed: planResult.candidatesReviewed,
      eligible: planResult.eligible,
      selectedPlan,
      submittedOrder: order,
      duplicate: false,
      messages,
      errors: []
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Alpaca paper order submission failure";
    await recordSubmission(selectedPlan, "failed", clientId, null, message);
    return {
      ok: false,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "paper_execution_enabled",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      paperTradingEnabled: true,
      orderSubmission: "failed",
      account: planResult.account,
      candidatesReviewed: planResult.candidatesReviewed,
      eligible: planResult.eligible,
      selectedPlan,
      submittedOrder: null,
      duplicate: false,
      messages,
      errors: [{ error: message }]
    };
  }
}

function money(value: number | null) {
  if (value === null) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function clean(value: string) {
  return value.split("_").join(" ");
}

export async function getPaperExecutionTextReport() {
  const result = await runPaperOrderExecution({ submit: false });
  const lines: string[] = [];
  const plan = result.selectedPlan;

  lines.push("RAVEN PAPER EXECUTION SWITCH");
  lines.push("============================");
  lines.push(`Status: ${result.ok ? "ok" : "needs_attention"}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push("Live trading: disabled");
  lines.push(`Paper execution enabled: ${result.paperTradingEnabled ? "yes" : "no"}`);
  lines.push(`Order submission: ${result.orderSubmission}`);
  lines.push("");
  lines.push("ACCOUNT");
  lines.push("-------");
  lines.push(`Equity: ${money(result.account.equity)}`);
  lines.push(`Cash: ${money(result.account.cash)}`);
  lines.push(`Buying power: ${money(result.account.buyingPower)}`);
  lines.push(`Open positions: ${result.account.openPositionCount}`);
  lines.push(`Open orders: ${result.account.openOrderCount}`);
  lines.push("");
  lines.push("EXECUTION READ");
  lines.push("--------------");
  if (!result.paperTradingEnabled) {
    lines.push("Paper execution is disabled. Raven can plan trades but cannot submit Alpaca orders yet.");
  } else if (!plan) {
    lines.push("Paper execution is enabled, but no candidate currently passes every gate.");
  } else {
    lines.push(`${plan.ticker} is eligible for paper execution if submitted with POST /api/paper/execute.`);
  }
  lines.push("");
  lines.push("SELECTED PLAN");
  lines.push("-------------");
  if (!plan) {
    lines.push("None");
  } else {
    lines.push(`${plan.ticker} | ${plan.score}/100 | ${plan.action} | ${plan.summary}`);
    lines.push(`Plan: buy ${money(plan.suggestedNotional)} notional / about ${plan.estimatedShares ?? "--"} shares`);
    lines.push(`Stop: ${money(plan.stopPrice)} | Target: ${money(plan.targetPrice)} | Max hold: ${plan.maxHoldDays} days`);
    if (plan.rejectCodes.length) lines.push(`Reject gates: ${plan.rejectCodes.map(clean).join(", ")}`);
  }
  lines.push("");
  lines.push("MESSAGES");
  lines.push("--------");
  if (!result.messages.length) lines.push("None");
  for (const message of result.messages) lines.push(`- ${message}`);
  if (result.errors.length) {
    lines.push("");
    lines.push("ERRORS");
    lines.push("------");
    for (const error of result.errors) lines.push(`- ${error.error}`);
  }
  lines.push("");
  lines.push("COPY NOTE");
  lines.push("---------");
  lines.push("Paste this report into ChatGPT when you want Raven paper-execution help.");

  return lines.join("\n");
}
