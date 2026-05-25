export type AlpacaPaperAccount = {
  id?: string;
  status?: string;
  currency?: string;
  cash?: string;
  buying_power?: string;
  regt_buying_power?: string;
  daytrading_buying_power?: string;
  portfolio_value?: string;
  equity?: string;
  last_equity?: string;
  long_market_value?: string;
  short_market_value?: string;
  initial_margin?: string;
  maintenance_margin?: string;
  daytrade_count?: number;
  pattern_day_trader?: boolean;
  trading_blocked?: boolean;
  transfers_blocked?: boolean;
  account_blocked?: boolean;
  trade_suspended_by_user?: boolean;
};

export type AlpacaPaperPosition = {
  asset_id?: string;
  symbol: string;
  exchange?: string;
  asset_class?: string;
  asset_marginable?: boolean;
  qty: string;
  avg_entry_price: string;
  side?: string;
  market_value?: string;
  cost_basis?: string;
  unrealized_pl?: string;
  unrealized_plpc?: string;
  unrealized_intraday_pl?: string;
  unrealized_intraday_plpc?: string;
  current_price?: string;
  lastday_price?: string;
  change_today?: string;
};

export type AlpacaPaperOrder = {
  id: string;
  client_order_id?: string;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  filled_at?: string | null;
  expired_at?: string | null;
  canceled_at?: string | null;
  failed_at?: string | null;
  symbol: string;
  asset_class?: string;
  qty?: string;
  filled_qty?: string;
  type?: string;
  side?: string;
  time_in_force?: string;
  limit_price?: string | null;
  stop_price?: string | null;
  filled_avg_price?: string | null;
  status: string;
  extended_hours?: boolean;
  order_class?: string;
  notional?: string;
};

export type PaperAccountSnapshot = {
  ok: boolean;
  configured: boolean;
  mode: "paper_read_only";
  liveTrading: "disabled";
  baseUrl: string;
  account: AlpacaPaperAccount | null;
  positions: AlpacaPaperPosition[];
  orders: AlpacaPaperOrder[];
  summary: {
    status: string;
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
    portfolioValue: number | null;
    longMarketValue: number | null;
    openPositionCount: number;
    openOrderCount: number;
    recentOrderCount: number;
    unrealizedPl: number | null;
    daytradeCount: number | null;
    tradingBlocked: boolean;
  };
  errors: Array<{ error: string }>;
};

function apiKeyId() {
  return (process.env.ALPACA_API_KEY_ID || process.env.APCA_API_KEY_ID || "").trim();
}

function apiSecretKey() {
  return (process.env.ALPACA_API_SECRET_KEY || process.env.APCA_API_SECRET_KEY || "").trim();
}

export function hasAlpacaTradingProvider() {
  return Boolean(apiKeyId() && apiSecretKey());
}

export function alpacaTradingBaseUrl() {
  return (process.env.ALPACA_PAPER_BASE_URL || process.env.ALPACA_TRADING_BASE_URL || "https://paper-api.alpaca.markets").replace(/\/$/, "");
}

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

async function alpacaTradingRequest<T>(
  path: string,
  searchParams?: Record<string, string>,
  init?: { method?: "GET" | "POST"; body?: unknown }
) {
  const url = new URL(`${alpacaTradingBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(searchParams || {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: init?.method || "GET",
    headers: {
      "APCA-API-KEY-ID": apiKeyId(),
      "APCA-API-SECRET-KEY": apiSecretKey(),
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {})
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpaca trading request failed ${response.status}: ${body.slice(0, 220)}`);
  }

  return response.json() as Promise<T>;
}

export async function getAlpacaPaperAccount() {
  return alpacaTradingRequest<AlpacaPaperAccount>("/v2/account");
}

export async function getAlpacaPaperPositions() {
  return alpacaTradingRequest<AlpacaPaperPosition[]>("/v2/positions");
}

export async function getAlpacaPaperOrders(limit = 20, status: "open" | "closed" | "all" = "all") {
  return alpacaTradingRequest<AlpacaPaperOrder[]>("/v2/orders", {
    status,
    limit: String(Math.max(1, Math.min(100, Math.floor(limit)))),
    direction: "desc",
    nested: "false"
  });
}

export type AlpacaPaperMarketOrderRequest = {
  symbol: string;
  side: "buy";
  notional: number;
  clientOrderId: string;
};

export async function submitAlpacaPaperMarketOrder(request: AlpacaPaperMarketOrderRequest) {
  const notional = Math.max(1, Math.round(request.notional * 100) / 100);
  return alpacaTradingRequest<AlpacaPaperOrder>("/v2/orders", undefined, {
    method: "POST",
    body: {
      symbol: request.symbol.toUpperCase(),
      side: request.side,
      type: "market",
      time_in_force: "day",
      notional: notional.toFixed(2),
      client_order_id: request.clientOrderId
    }
  });
}

function summarize(account: AlpacaPaperAccount | null, positions: AlpacaPaperPosition[], orders: AlpacaPaperOrder[]) {
  const equity = round(toNumber(account?.equity ?? account?.portfolio_value));
  const longMarketValue = round(toNumber(account?.long_market_value));
  const unrealizedPl = round(positions.reduce((sum, position) => sum + (toNumber(position.unrealized_pl) || 0), 0));
  const openOrders = orders.filter((order) => ["new", "accepted", "pending_new", "partially_filled"].includes(order.status));

  return {
    status: account?.status || "unknown",
    equity,
    cash: round(toNumber(account?.cash)),
    buyingPower: round(toNumber(account?.buying_power)),
    portfolioValue: round(toNumber(account?.portfolio_value)),
    longMarketValue,
    openPositionCount: positions.length,
    openOrderCount: openOrders.length,
    recentOrderCount: orders.length,
    unrealizedPl,
    daytradeCount: typeof account?.daytrade_count === "number" ? account.daytrade_count : null,
    tradingBlocked: Boolean(account?.trading_blocked || account?.account_blocked || account?.trade_suspended_by_user)
  };
}

export async function getAlpacaPaperSnapshot(orderLimit = 20): Promise<PaperAccountSnapshot> {
  if (!hasAlpacaTradingProvider()) {
    return {
      ok: false,
      configured: false,
      mode: "paper_read_only",
      liveTrading: "disabled",
      baseUrl: alpacaTradingBaseUrl(),
      account: null,
      positions: [],
      orders: [],
      summary: summarize(null, [], []),
      errors: [{ error: "ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are not configured." }]
    };
  }

  const errors: Array<{ error: string }> = [];
  let account: AlpacaPaperAccount | null = null;
  let positions: AlpacaPaperPosition[] = [];
  let orders: AlpacaPaperOrder[] = [];

  try {
    account = await getAlpacaPaperAccount();
  } catch (error) {
    errors.push({ error: error instanceof Error ? error.message : "Unknown Alpaca account failure" });
  }

  try {
    positions = await getAlpacaPaperPositions();
  } catch (error) {
    errors.push({ error: error instanceof Error ? error.message : "Unknown Alpaca positions failure" });
  }

  try {
    orders = await getAlpacaPaperOrders(orderLimit, "all");
  } catch (error) {
    errors.push({ error: error instanceof Error ? error.message : "Unknown Alpaca orders failure" });
  }

  return {
    ok: errors.length === 0,
    configured: true,
    mode: "paper_read_only",
    liveTrading: "disabled",
    baseUrl: alpacaTradingBaseUrl(),
    account,
    positions,
    orders,
    summary: summarize(account, positions, orders),
    errors
  };
}

function money(value: number | null) {
  if (value === null) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: string | undefined) {
  const numberValue = toNumber(value);
  if (numberValue === null) return "--";
  return `${(numberValue * 100).toFixed(2)}%`;
}

export async function getAlpacaPaperTextReport() {
  const snapshot = await getAlpacaPaperSnapshot(15);
  const lines: string[] = [];

  lines.push("RAVEN PAPER ACCOUNT");
  lines.push("===================");
  lines.push(`Status: ${snapshot.ok ? "ok" : "needs_attention"}`);
  lines.push(`Mode: ${snapshot.mode}`);
  lines.push("Live trading: disabled");
  lines.push(`Provider: ${snapshot.configured ? "configured" : "not_configured"}`);
  lines.push("");
  lines.push("ACCOUNT");
  lines.push("-------");
  lines.push(`Equity: ${money(snapshot.summary.equity)}`);
  lines.push(`Cash: ${money(snapshot.summary.cash)}`);
  lines.push(`Buying power: ${money(snapshot.summary.buyingPower)}`);
  lines.push(`Portfolio value: ${money(snapshot.summary.portfolioValue)}`);
  lines.push(`Long market value: ${money(snapshot.summary.longMarketValue)}`);
  lines.push(`Unrealized P/L: ${money(snapshot.summary.unrealizedPl)}`);
  lines.push(`Open positions: ${snapshot.summary.openPositionCount}`);
  lines.push(`Open orders: ${snapshot.summary.openOrderCount}`);
  lines.push(`Recent orders: ${snapshot.summary.recentOrderCount}`);
  lines.push(`Trading blocked: ${snapshot.summary.tradingBlocked ? "yes" : "no"}`);
  lines.push("");
  lines.push("OPEN POSITIONS");
  lines.push("--------------");

  if (!snapshot.positions.length) {
    lines.push("None");
  } else {
    for (const position of snapshot.positions) {
      lines.push(`${position.symbol} | qty ${position.qty} | avg ${money(round(toNumber(position.avg_entry_price)))} | current ${money(round(toNumber(position.current_price)))} | value ${money(round(toNumber(position.market_value)))} | P/L ${money(round(toNumber(position.unrealized_pl)))} (${pct(position.unrealized_plpc)})`);
    }
  }

  lines.push("");
  lines.push("OPEN / RECENT ORDERS");
  lines.push("--------------------");
  if (!snapshot.orders.length) {
    lines.push("None");
  } else {
    for (const order of snapshot.orders.slice(0, 10)) {
      const notional = order.notional ? ` | notional ${money(round(toNumber(order.notional)))}` : "";
      const avg = order.filled_avg_price ? ` | fill ${money(round(toNumber(order.filled_avg_price)))}` : "";
      lines.push(`${order.symbol} | ${order.side || "--"} | ${order.type || "--"} | ${order.status} | qty ${order.qty || order.filled_qty || "--"}${notional}${avg}`);
    }
  }

  if (snapshot.errors.length) {
    lines.push("");
    lines.push("WARNINGS");
    lines.push("--------");
    for (const error of snapshot.errors) lines.push(error.error);
  }

  lines.push("");
  lines.push("COPY NOTE");
  lines.push("---------");
  lines.push("Paste this report into ChatGPT when you want Raven paper-account help.");

  return lines.join("\n");
}
