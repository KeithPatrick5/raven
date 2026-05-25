import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

export type AlpacaConfirmation = {
  id: number;
  summary_id: number;
  ticker: string;
  latest_close: number | null;
  previous_close: number | null;
  price_change_percent: number | null;
  latest_volume: number | null;
  avg_20d_volume: number | null;
  relative_volume: number | null;
  latest_bar_time: string | null;
  liquidity_status: string;
  price_status: string;
  confirmation_status: string;
  created_at: string;
};

type PendingSummaryRow = {
  id: number;
  ticker: string;
  accession_number: string;
  form: string;
  tradeability: number;
  created_at: string;
};

type AlpacaBar = {
  c?: number;
  h?: number;
  l?: number;
  n?: number;
  o?: number;
  t?: string;
  v?: number;
  vw?: number;
};

function apiKeyId() {
  return (process.env.ALPACA_API_KEY_ID || process.env.APCA_API_KEY_ID || "").trim();
}

function apiSecretKey() {
  return (process.env.ALPACA_API_SECRET_KEY || process.env.APCA_API_SECRET_KEY || "").trim();
}

export function hasAlpacaProvider() {
  return Boolean(apiKeyId() && apiSecretKey());
}


export type AlpacaAccountMode = "paper" | "live";

export type AlpacaAccount = {
  id: string;
  account_number: string | null;
  status: string;
  currency: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  pattern_day_trader?: boolean;
  trading_blocked?: boolean;
  transfers_blocked?: boolean;
  account_blocked?: boolean;
  created_at?: string;
};

export type AlpacaPosition = {
  asset_id?: string;
  symbol: string;
  exchange?: string;
  asset_class?: string;
  qty: string;
  side: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  avg_entry_price: string;
};

export type AlpacaOrder = {
  id: string;
  symbol: string;
  asset_class?: string;
  qty: string | null;
  notional?: string | null;
  side: string;
  type: string;
  time_in_force: string;
  status: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
  submitted_at?: string;
  filled_at?: string | null;
  canceled_at?: string | null;
};

export type PaperAccountSnapshot = {
  ok: boolean;
  mode: AlpacaAccountMode;
  liveTrading: "disabled";
  alpaca: "configured" | "not_configured";
  account: AlpacaAccount | null;
  positions: AlpacaPosition[];
  openOrders: AlpacaOrder[];
  recentOrders: AlpacaOrder[];
  summary: {
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
    portfolioValue: number | null;
    longMarketValue: number | null;
    openPositions: number;
    openOrders: number;
    todayPl: number | null;
    todayPlPercent: number | null;
  };
  errors: Array<{ error: string }>;
};

function tradingBaseUrl(mode: AlpacaAccountMode = "paper") {
  const paperUrl = process.env.ALPACA_PAPER_TRADING_BASE_URL || process.env.ALPACA_PAPER_BASE_URL || "https://paper-api.alpaca.markets";
  const liveUrl = process.env.ALPACA_LIVE_TRADING_BASE_URL || process.env.ALPACA_LIVE_BASE_URL || "https://api.alpaca.markets";
  return (mode === "live" ? liveUrl : paperUrl).replace(/\/$/, "");
}

async function alpacaTradingRequest<T>(path: string, mode: AlpacaAccountMode = "paper"): Promise<T> {
  if (!hasAlpacaProvider()) {
    throw new Error("ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are not configured.");
  }

  const response = await fetch(`${tradingBaseUrl(mode)}/v2${path}`, {
    headers: {
      "APCA-API-KEY-ID": apiKeyId(),
      "APCA-API-SECRET-KEY": apiSecretKey(),
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpaca trading request failed: ${response.status} ${body.slice(0, 220)}`);
  }

  return response.json() as Promise<T>;
}

function moneyNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function accountSummary(account: AlpacaAccount | null, positions: AlpacaPosition[], openOrders: AlpacaOrder[]) {
  const equity = moneyNumber(account?.equity);
  const lastEquity = moneyNumber(account?.last_equity);
  const todayPl = equity !== null && lastEquity !== null ? equity - lastEquity : null;
  const todayPlPercent = todayPl !== null && lastEquity !== null && lastEquity !== 0 ? (todayPl / lastEquity) * 100 : null;

  return {
    equity: round(equity, 2),
    cash: round(moneyNumber(account?.cash), 2),
    buyingPower: round(moneyNumber(account?.buying_power), 2),
    portfolioValue: round(moneyNumber(account?.portfolio_value), 2),
    longMarketValue: round(moneyNumber(account?.long_market_value), 2),
    openPositions: positions.length,
    openOrders: openOrders.length,
    todayPl: round(todayPl, 2),
    todayPlPercent: round(todayPlPercent, 2)
  };
}

export async function getAlpacaAccount(mode: AlpacaAccountMode = "paper") {
  return alpacaTradingRequest<AlpacaAccount>("/account", mode);
}

export async function getAlpacaPositions(mode: AlpacaAccountMode = "paper") {
  return alpacaTradingRequest<AlpacaPosition[]>("/positions", mode);
}

export async function getAlpacaOrders(mode: AlpacaAccountMode = "paper", status: "open" | "closed" | "all" = "open", limit = 25) {
  const params = new URLSearchParams({
    status,
    limit: String(Math.max(1, Math.min(100, Math.floor(limit)))),
    direction: "desc"
  });

  return alpacaTradingRequest<AlpacaOrder[]>(`/orders?${params.toString()}`, mode);
}

export async function getPaperAccountSnapshot(): Promise<PaperAccountSnapshot> {
  if (!hasAlpacaProvider()) {
    return {
      ok: false,
      mode: "paper",
      liveTrading: "disabled",
      alpaca: "not_configured",
      account: null,
      positions: [],
      openOrders: [],
      recentOrders: [],
      summary: accountSummary(null, [], []),
      errors: [{ error: "ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are not configured." }]
    };
  }

  try {
    const [account, positions, openOrders, recentOrders] = await Promise.all([
      getAlpacaAccount("paper"),
      getAlpacaPositions("paper"),
      getAlpacaOrders("paper", "open", 50),
      getAlpacaOrders("paper", "all", 25)
    ]);

    return {
      ok: true,
      mode: "paper",
      liveTrading: "disabled",
      alpaca: "configured",
      account,
      positions,
      openOrders,
      recentOrders,
      summary: accountSummary(account, positions, openOrders),
      errors: []
    };
  } catch (error) {
    return {
      ok: false,
      mode: "paper",
      liveTrading: "disabled",
      alpaca: "configured",
      account: null,
      positions: [],
      openOrders: [],
      recentOrders: [],
      summary: accountSummary(null, [], []),
      errors: [{ error: error instanceof Error ? error.message : "Unknown Alpaca paper account failure" }]
    };
  }
}

function marketDataBaseUrl() {
  return (process.env.ALPACA_MARKET_DATA_BASE_URL || "https://data.alpaca.markets").replace(/\/$/, "");
}

function startDate(daysBack: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

function endDate() {
  return new Date().toISOString().slice(0, 10);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pctChange(latest: number | null, previous: number | null) {
  if (latest === null || previous === null || previous === 0) return null;
  return ((latest - previous) / previous) * 100;
}

function round(value: number | null, decimals = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function liquidityStatus(latestVolume: number | null, avgVolume: number | null, relativeVolume: number | null) {
  if (latestVolume === null) return "unknown";
  if (latestVolume < 500_000) return "thin";
  if (relativeVolume !== null && relativeVolume >= 2) return "active";
  if (avgVolume !== null && avgVolume >= 1_000_000) return "liquid";
  return "normal";
}

function priceStatus(changePercent: number | null) {
  if (changePercent === null) return "unknown";
  if (changePercent >= 3) return "up_confirming";
  if (changePercent <= -3) return "down_confirming";
  return "flat";
}

function confirmationStatus(tradeability: number, changePercent: number | null, relativeVolume: number | null) {
  const volumeConfirming = relativeVolume !== null && relativeVolume >= 1.5;
  const priceConfirming = changePercent !== null && changePercent >= 1;
  const priceRejecting = changePercent !== null && changePercent <= -2;

  if (priceRejecting) return "rejecting";
  if (tradeability >= 60 && volumeConfirming && priceConfirming) return "confirmed";
  if (volumeConfirming || priceConfirming) return "watch";
  return "unconfirmed";
}

async function getPendingSummaries(limit: number): Promise<PendingSummaryRow[]> {
  const sql = db();

  return sql<PendingSummaryRow[]>`
    select
      sec_filing_summaries.id,
      sec_filing_summaries.ticker,
      sec_filing_summaries.accession_number,
      sec_filing_summaries.form,
      sec_filing_summaries.tradeability,
      sec_filing_summaries.created_at::text as created_at
    from sec_filing_summaries
    left join alpaca_market_confirmations
      on alpaca_market_confirmations.summary_id = sec_filing_summaries.id
    where alpaca_market_confirmations.id is null
    order by sec_filing_summaries.created_at desc
    limit ${limit}
  `;
}

export async function fetchDailyBars(symbol: string): Promise<AlpacaBar[]> {
  const url = new URL(`${marketDataBaseUrl()}/v2/stocks/bars`);
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", startDate(45));
  url.searchParams.set("end", endDate());
  url.searchParams.set("limit", "100");
  url.searchParams.set("adjustment", "raw");
  url.searchParams.set("feed", process.env.ALPACA_DATA_FEED || "iex");
  url.searchParams.set("sort", "asc");

  const response = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": apiKeyId(),
      "APCA-API-SECRET-KEY": apiSecretKey(),
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpaca bars request failed: ${response.status} ${body.slice(0, 180)}`);
  }

  const payload = await response.json() as { bars?: Record<string, AlpacaBar[]> };
  return payload.bars?.[symbol] || [];
}


export async function getLatestAlpacaSnapshot(symbol: string) {
  const bars = await fetchDailyBars(symbol);
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const latestClose = numberOrNull(latest?.c);
  const previousClose = numberOrNull(previous?.c);
  const latestVolume = numberOrNull(latest?.v);
  const changePercent = pctChange(latestClose, previousClose);

  return {
    ticker: symbol,
    latestClose,
    previousClose,
    latestVolume,
    priceChangePercent: round(changePercent),
    latestBarTime: latest?.t || null,
    barCount: bars.length
  };
}

async function saveConfirmation(summary: PendingSummaryRow, bars: AlpacaBar[]) {
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const latestClose = numberOrNull(latest?.c);
  const previousClose = numberOrNull(previous?.c);
  const latestVolume = numberOrNull(latest?.v);
  const avg20Volume = average(bars.slice(-21, -1).map((bar) => numberOrNull(bar.v)).filter((value): value is number => value !== null));
  const relativeVolume = latestVolume !== null && avg20Volume !== null && avg20Volume > 0 ? latestVolume / avg20Volume : null;
  const changePercent = pctChange(latestClose, previousClose);
  const liquidity = liquidityStatus(latestVolume, avg20Volume, relativeVolume);
  const price = priceStatus(changePercent);
  const confirmation = confirmationStatus(summary.tradeability, changePercent, relativeVolume);

  const sql = db();

  await sql`
    insert into alpaca_market_confirmations (
      summary_id,
      accession_number,
      ticker,
      latest_close,
      previous_close,
      price_change_percent,
      latest_volume,
      avg_20d_volume,
      relative_volume,
      latest_bar_time,
      liquidity_status,
      price_status,
      confirmation_status,
      raw_payload
    ) values (
      ${summary.id},
      ${summary.accession_number},
      ${summary.ticker},
      ${latestClose},
      ${previousClose},
      ${round(changePercent)},
      ${latestVolume},
      ${avg20Volume === null ? null : Math.round(avg20Volume)},
      ${round(relativeVolume)},
      ${latest?.t || null},
      ${liquidity},
      ${price},
      ${confirmation},
      ${JSON.stringify({ latest, previous, barCount: bars.length })}::jsonb
    )
    on conflict (summary_id) do nothing
  `;

  return {
    ticker: summary.ticker,
    accessionNumber: summary.accession_number,
    latestClose,
    previousClose,
    priceChangePercent: round(changePercent),
    latestVolume,
    avg20Volume: avg20Volume === null ? null : Math.round(avg20Volume),
    relativeVolume: round(relativeVolume),
    latestBarTime: latest?.t || null,
    liquidityStatus: liquidity,
    priceStatus: price,
    confirmationStatus: confirmation
  };
}

export async function confirmPendingSecSignalsWithAlpaca(limit = 3) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      alpaca: hasAlpacaProvider() ? "configured" : "not_configured",
      confirmed: 0,
      pending: 0,
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }],
      confirmations: []
    };
  }

  await ensureRavenTables();

  if (!hasAlpacaProvider()) {
    const pending = await getPendingSummaries(limit);
    return {
      ok: false,
      database: "configured" as const,
      alpaca: "not_configured" as const,
      confirmed: 0,
      pending: pending.length,
      errors: [{ error: "ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are not configured." }],
      confirmations: []
    };
  }

  const pending = await getPendingSummaries(limit);
  const confirmations: Array<Record<string, unknown>> = [];
  const errors: Array<{ ticker?: string; accessionNumber?: string; error: string }> = [];

  for (const summary of pending) {
    try {
      const bars = await fetchDailyBars(summary.ticker);
      if (bars.length < 2) {
        throw new Error(`Not enough Alpaca daily bars returned for ${summary.ticker}.`);
      }
      confirmations.push(await saveConfirmation(summary, bars));
    } catch (error) {
      errors.push({
        ticker: summary.ticker,
        accessionNumber: summary.accession_number,
        error: error instanceof Error ? error.message : "Unknown Alpaca confirmation failure"
      });
    }
  }

  return {
    ok: confirmations.length > 0,
    database: "configured" as const,
    alpaca: "configured" as const,
    confirmed: confirmations.length,
    pending: Math.max(0, pending.length - confirmations.length),
    errors,
    confirmations
  };
}

export async function getLatestConfirmedSecSignals(limit = 8) {
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
    confirmed_at: string | null;
  }>>`
    select
      s.ticker,
      s.accession_number,
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
      c.created_at::text as confirmed_at
    from sec_filing_summaries s
    left join alpaca_market_confirmations c
      on c.summary_id = s.id
    order by coalesce(c.created_at, s.created_at) desc
    limit ${limit}
  `;
}
