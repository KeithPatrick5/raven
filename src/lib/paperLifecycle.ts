import { getAlpacaPaperSnapshot, type AlpacaPaperOrder, type AlpacaPaperPosition } from "@/lib/alpacaTrading";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

export type PaperLifecycleRow = {
  id: number;
  scored_signal_id: number | null;
  accession_number: string | null;
  ticker: string;
  side: string;
  status: string;
  alpaca_order_id: string | null;
  client_order_id: string | null;
  qty: string | number | null;
  entry_price: string | number | null;
  current_price: string | number | null;
  market_value: string | number | null;
  unrealized_pl: string | number | null;
  unrealized_plpc: string | number | null;
  stop_price: string | number | null;
  target_price: string | number | null;
  max_hold_at: string | null;
  exit_signal: string | null;
  exit_reason: string | null;
  raw_payload: unknown;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

type SubmissionRow = {
  id: number;
  scored_signal_id: number | null;
  accession_number: string | null;
  ticker: string;
  side: string;
  status: string;
  requested_notional: string | number | null;
  estimated_shares: string | number | null;
  stop_price: string | number | null;
  target_price: string | number | null;
  max_hold_days: number | null;
  client_order_id: string | null;
  alpaca_order_id: string | null;
  raw_plan: unknown;
  raw_order: unknown;
  created_at: string;
  updated_at: string;
};

type LifecycleResult = {
  ok: boolean;
  phase: "PAPER_POSITION_LIFECYCLE";
  mode: "paper_lifecycle_read_only";
  startedAt: string;
  finishedAt: string;
  liveTrading: "disabled";
  orderSubmission: "disabled_by_default";
  account: {
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
    openPositionCount: number;
    openOrderCount: number;
  };
  syncedSubmissions: number;
  openPositions: number;
  openOrders: number;
  pendingEntries: number;
  pendingExits: number;
  closed: number;
  lifecycle: PaperLifecycleRow[];
  positions: AlpacaPaperPosition[];
  orders: AlpacaPaperOrder[];
  messages: string[];
  errors: Array<{ error: string }>;
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function round(value: number | null, decimals = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function money(value: number | null) {
  if (value === null) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number | string | null | undefined) {
  const n = toNumber(value);
  if (n === null) return "--";
  const normalized = Math.abs(n) < 1 ? n * 100 : n;
  return `${normalized.toFixed(2)}%`;
}

function isOpenOrderStatus(status: string | undefined) {
  return ["new", "accepted", "pending_new", "partially_filled", "held"].includes((status || "").toLowerCase());
}

function isClosedOrderStatus(status: string | undefined) {
  return ["filled", "canceled", "cancelled", "expired", "rejected", "done_for_day"].includes((status || "").toLowerCase());
}

function orderStatusToLifecycle(order: AlpacaPaperOrder | undefined, fallbackStatus: string) {
  const status = (order?.status || fallbackStatus || "submitted").toLowerCase();
  if (["filled"].includes(status)) return "filled";
  if (["canceled", "cancelled"].includes(status)) return "cancelled";
  if (["expired"].includes(status)) return "expired";
  if (["rejected", "stopped", "suspended"].includes(status)) return "rejected";
  if (isOpenOrderStatus(status)) return "submitted";
  return status || "submitted";
}

function byOrderId(orders: AlpacaPaperOrder[]) {
  const map = new Map<string, AlpacaPaperOrder>();
  for (const order of orders) {
    map.set(order.id, order);
    if (order.client_order_id) map.set(order.client_order_id, order);
  }
  return map;
}

function bySymbol(positions: AlpacaPaperPosition[]) {
  const map = new Map<string, AlpacaPaperPosition>();
  for (const position of positions) map.set(position.symbol.toUpperCase(), position);
  return map;
}

function maxHoldAt(createdAt: string, days: number | null) {
  const d = new Date(createdAt);
  const maxDays = days && days > 0 ? days : 5;
  d.setUTCDate(d.getUTCDate() + maxDays);
  return d.toISOString();
}

function exitCheck(args: {
  status: string;
  currentPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  maxHoldAtIso: string | null;
}) {
  if (!["filled", "open", "pending_exit"].includes(args.status)) return { status: args.status, exitSignal: null, exitReason: null };

  const now = Date.now();
  const maxHoldHit = args.maxHoldAtIso ? new Date(args.maxHoldAtIso).getTime() <= now : false;

  if (args.currentPrice !== null && args.stopPrice !== null && args.currentPrice <= args.stopPrice) {
    return { status: "pending_exit", exitSignal: "stop_loss_hit", exitReason: `Current price ${args.currentPrice} is at or below stop ${args.stopPrice}.` };
  }

  if (args.currentPrice !== null && args.targetPrice !== null && args.currentPrice >= args.targetPrice) {
    return { status: "pending_exit", exitSignal: "take_profit_hit", exitReason: `Current price ${args.currentPrice} is at or above target ${args.targetPrice}.` };
  }

  if (maxHoldHit) {
    return { status: "pending_exit", exitSignal: "max_hold_expired", exitReason: "Max hold window has expired." };
  }

  return { status: args.status === "filled" ? "open" : args.status, exitSignal: null, exitReason: null };
}

async function getSubmissions() {
  const sql = db();
  return sql<SubmissionRow[]>`
    select
      id,
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
      created_at::text,
      updated_at::text
    from paper_order_submissions
    order by created_at desc
    limit 100
  `;
}

async function upsertSubmissionLifecycle(submission: SubmissionRow, order: AlpacaPaperOrder | undefined, position: AlpacaPaperPosition | undefined) {
  const sql = db();
  const rawStatus = orderStatusToLifecycle(order, submission.status);
  const currentPrice = round(toNumber(position?.current_price ?? order?.filled_avg_price));
  const entryPrice = round(toNumber(position?.avg_entry_price ?? order?.filled_avg_price));
  const stopPrice = round(toNumber(submission.stop_price));
  const targetPrice = round(toNumber(submission.target_price));
  const maxHoldIso = maxHoldAt(submission.created_at, submission.max_hold_days);
  const checked = exitCheck({ status: position ? "open" : rawStatus, currentPrice, stopPrice, targetPrice, maxHoldAtIso: maxHoldIso });
  const qty = toNumber(position?.qty ?? order?.filled_qty ?? submission.estimated_shares);

  await sql`
    insert into paper_position_lifecycle (
      scored_signal_id,
      accession_number,
      ticker,
      side,
      status,
      alpaca_order_id,
      client_order_id,
      qty,
      entry_price,
      current_price,
      market_value,
      unrealized_pl,
      unrealized_plpc,
      stop_price,
      target_price,
      max_hold_at,
      exit_signal,
      exit_reason,
      raw_payload,
      opened_at,
      closed_at,
      updated_at
    ) values (
      ${submission.scored_signal_id},
      ${submission.accession_number},
      ${submission.ticker.toUpperCase()},
      ${submission.side || "buy"},
      ${checked.status},
      ${order?.id || submission.alpaca_order_id},
      ${order?.client_order_id || submission.client_order_id},
      ${qty},
      ${entryPrice},
      ${currentPrice},
      ${toNumber(position?.market_value)},
      ${toNumber(position?.unrealized_pl)},
      ${toNumber(position?.unrealized_plpc)},
      ${stopPrice},
      ${targetPrice},
      ${maxHoldIso},
      ${checked.exitSignal},
      ${checked.exitReason},
      ${JSON.stringify({ submission, order: order || null, position: position || null })}::jsonb,
      ${position || order?.filled_at ? (order?.filled_at || submission.created_at) : null},
      ${isClosedOrderStatus(order?.status) && !position ? (order?.updated_at || order?.filled_at || null) : null},
      now()
    )
    on conflict (client_order_id) do update set
      status = excluded.status,
      alpaca_order_id = excluded.alpaca_order_id,
      qty = excluded.qty,
      entry_price = excluded.entry_price,
      current_price = excluded.current_price,
      market_value = excluded.market_value,
      unrealized_pl = excluded.unrealized_pl,
      unrealized_plpc = excluded.unrealized_plpc,
      stop_price = excluded.stop_price,
      target_price = excluded.target_price,
      max_hold_at = excluded.max_hold_at,
      exit_signal = excluded.exit_signal,
      exit_reason = excluded.exit_reason,
      raw_payload = excluded.raw_payload,
      opened_at = coalesce(paper_position_lifecycle.opened_at, excluded.opened_at),
      closed_at = excluded.closed_at,
      updated_at = now()
  `;
}

async function upsertExternalPosition(position: AlpacaPaperPosition) {
  const sql = db();
  const clientOrderId = `alpaca-position-${position.symbol.toUpperCase()}`;
  await sql`
    insert into paper_position_lifecycle (
      ticker,
      side,
      status,
      client_order_id,
      qty,
      entry_price,
      current_price,
      market_value,
      unrealized_pl,
      unrealized_plpc,
      raw_payload,
      opened_at,
      updated_at
    ) values (
      ${position.symbol.toUpperCase()},
      ${position.side || "long"},
      'open',
      ${clientOrderId},
      ${toNumber(position.qty)},
      ${toNumber(position.avg_entry_price)},
      ${toNumber(position.current_price)},
      ${toNumber(position.market_value)},
      ${toNumber(position.unrealized_pl)},
      ${toNumber(position.unrealized_plpc)},
      ${JSON.stringify({ position, note: "Position exists at Alpaca. Raven could not match it to a submitted Raven order." })}::jsonb,
      now(),
      now()
    )
    on conflict (client_order_id) do update set
      status = 'open',
      qty = excluded.qty,
      entry_price = excluded.entry_price,
      current_price = excluded.current_price,
      market_value = excluded.market_value,
      unrealized_pl = excluded.unrealized_pl,
      unrealized_plpc = excluded.unrealized_plpc,
      raw_payload = excluded.raw_payload,
      updated_at = now()
  `;
}

async function latestLifecycleRows() {
  const sql = db();
  return sql<PaperLifecycleRow[]>`
    select
      id,
      scored_signal_id,
      accession_number,
      ticker,
      side,
      status,
      alpaca_order_id,
      client_order_id,
      qty,
      entry_price,
      current_price,
      market_value,
      unrealized_pl,
      unrealized_plpc,
      stop_price,
      target_price,
      max_hold_at::text,
      exit_signal,
      exit_reason,
      raw_payload,
      opened_at::text,
      closed_at::text,
      created_at::text,
      updated_at::text
    from paper_position_lifecycle
    order by updated_at desc
    limit 50
  `;
}

export async function getPaperPositionLifecycle(): Promise<LifecycleResult> {
  const startedAt = new Date().toISOString();
  const messages: string[] = [];
  const errors: Array<{ error: string }> = [];

  if (!hasDatabase()) {
    return {
      ok: false,
      phase: "PAPER_POSITION_LIFECYCLE",
      mode: "paper_lifecycle_read_only",
      startedAt,
      finishedAt: new Date().toISOString(),
      liveTrading: "disabled",
      orderSubmission: "disabled_by_default",
      account: { equity: null, cash: null, buyingPower: null, openPositionCount: 0, openOrderCount: 0 },
      syncedSubmissions: 0,
      openPositions: 0,
      openOrders: 0,
      pendingEntries: 0,
      pendingExits: 0,
      closed: 0,
      lifecycle: [],
      positions: [],
      orders: [],
      messages: [],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const snapshot = await getAlpacaPaperSnapshot(100);
  errors.push(...snapshot.errors);

  const submissions = await getSubmissions();
  const ordersById = byOrderId(snapshot.orders);
  const positionsBySymbol = bySymbol(snapshot.positions);

  for (const submission of submissions) {
    const order = (submission.alpaca_order_id ? ordersById.get(submission.alpaca_order_id) : undefined) ||
      (submission.client_order_id ? ordersById.get(submission.client_order_id) : undefined);
    const position = positionsBySymbol.get(submission.ticker.toUpperCase());
    await upsertSubmissionLifecycle(submission, order, position);
  }

  const submittedSymbols = new Set(submissions.map((s) => s.ticker.toUpperCase()));
  for (const position of snapshot.positions) {
    if (!submittedSymbols.has(position.symbol.toUpperCase())) {
      await upsertExternalPosition(position);
    }
  }

  const lifecycle = await latestLifecycleRows();
  const pendingEntries = lifecycle.filter((row) => ["planned", "submitted"].includes(row.status)).length;
  const pendingExits = lifecycle.filter((row) => row.status === "pending_exit").length;
  const closed = lifecycle.filter((row) => ["closed", "cancelled", "rejected", "expired"].includes(row.status)).length;

  if (pendingExits > 0) {
    messages.push("One or more paper positions need an exit review. 13E only flags exits; it does not submit exit orders yet.");
  }

  if (submissions.length === 0 && snapshot.positions.length === 0 && snapshot.orders.length === 0) {
    messages.push("No Raven paper submissions, Alpaca positions, or Alpaca orders found yet.");
  }

  return {
    ok: errors.length === 0,
    phase: "PAPER_POSITION_LIFECYCLE",
    mode: "paper_lifecycle_read_only",
    startedAt,
    finishedAt: new Date().toISOString(),
    liveTrading: "disabled",
    orderSubmission: "disabled_by_default",
    account: {
      equity: snapshot.summary.equity,
      cash: snapshot.summary.cash,
      buyingPower: snapshot.summary.buyingPower,
      openPositionCount: snapshot.summary.openPositionCount,
      openOrderCount: snapshot.summary.openOrderCount
    },
    syncedSubmissions: submissions.length,
    openPositions: snapshot.positions.length,
    openOrders: snapshot.summary.openOrderCount,
    pendingEntries,
    pendingExits,
    closed,
    lifecycle,
    positions: snapshot.positions,
    orders: snapshot.orders,
    messages,
    errors
  };
}

export async function getPaperLifecycleTextReport() {
  const result = await getPaperPositionLifecycle();
  const lines: string[] = [];

  lines.push("RAVEN PAPER POSITION LIFECYCLE");
  lines.push("==============================");
  lines.push(`Status: ${result.ok ? "ok" : "needs_attention"}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push("Live trading: disabled");
  lines.push("Order submission: disabled by default");
  lines.push("");
  lines.push("ACCOUNT");
  lines.push("-------");
  lines.push(`Equity: ${money(result.account.equity)}`);
  lines.push(`Cash: ${money(result.account.cash)}`);
  lines.push(`Buying power: ${money(result.account.buyingPower)} (not used for sizing)`);
  lines.push(`Open positions: ${result.openPositions}`);
  lines.push(`Open orders: ${result.openOrders}`);
  lines.push("");
  lines.push("LIFECYCLE SUMMARY");
  lines.push("-----------------");
  lines.push(`Synced Raven submissions: ${result.syncedSubmissions}`);
  lines.push(`Pending entries: ${result.pendingEntries}`);
  lines.push(`Pending exits: ${result.pendingExits}`);
  lines.push(`Closed/cancelled/rejected/expired: ${result.closed}`);
  lines.push("");
  lines.push("OPEN POSITIONS");
  lines.push("--------------");
  if (!result.positions.length) {
    lines.push("None");
  } else {
    for (const position of result.positions) {
      lines.push(`${position.symbol} | qty ${position.qty} | avg ${money(round(toNumber(position.avg_entry_price)))} | current ${money(round(toNumber(position.current_price)))} | value ${money(round(toNumber(position.market_value)))} | P/L ${money(round(toNumber(position.unrealized_pl)))} (${pct(position.unrealized_plpc)})`);
    }
  }

  lines.push("");
  lines.push("PENDING ENTRIES / ORDERS");
  lines.push("------------------------");
  const openOrders = result.orders.filter((order) => isOpenOrderStatus(order.status));
  if (!openOrders.length) {
    lines.push("None");
  } else {
    for (const order of openOrders) {
      lines.push(`${order.symbol} | ${order.side || "--"} | ${order.type || "--"} | ${order.status} | qty ${order.qty || order.filled_qty || "--"} | client ${order.client_order_id || "--"}`);
    }
  }

  lines.push("");
  lines.push("EXIT WATCH");
  lines.push("----------");
  const pendingExits = result.lifecycle.filter((row) => row.status === "pending_exit");
  if (!pendingExits.length) {
    lines.push("None");
  } else {
    for (const row of pendingExits) {
      lines.push(`${row.ticker} | ${row.exit_signal || "exit_review"} | ${row.exit_reason || "Needs exit review."}`);
    }
  }

  lines.push("");
  lines.push("LIFECYCLE ROWS");
  lines.push("--------------");
  if (!result.lifecycle.length) {
    lines.push("None");
  } else {
    for (const row of result.lifecycle.slice(0, 12)) {
      lines.push(`${row.ticker} | ${row.status} | qty ${row.qty ?? "--"} | entry ${money(round(toNumber(row.entry_price)))} | current ${money(round(toNumber(row.current_price)))} | stop ${money(round(toNumber(row.stop_price)))} | target ${money(round(toNumber(row.target_price)))}`);
    }
  }

  if (result.messages.length) {
    lines.push("");
    lines.push("MESSAGES");
    lines.push("--------");
    for (const message of result.messages) lines.push(`- ${message}`);
  }

  if (result.errors.length) {
    lines.push("");
    lines.push("WARNINGS");
    lines.push("--------");
    for (const error of result.errors) lines.push(error.error);
  }

  lines.push("");
  lines.push("COPY NOTE");
  lines.push("---------");
  lines.push("Paste this report into ChatGPT when you want Raven lifecycle/exits help.");

  return lines.join("\n");
}
