import { fetchDailyBars } from "@/lib/alpaca";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

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

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function latestClose(ticker: string): Promise<number | null> {
  try {
    const bars = await fetchDailyBars(ticker);
    return asNumber(bars.at(-1)?.c);
  } catch {
    return null;
  }
}

type TradeRow = {
  ticker: string;
  side: string;
  status: string;
  entry_price: string | null;
  exit_price: string | null;
  pnl_percent: string | null;
  notional: string | null;
};

type OpenLedgerTrade = {
  ticker: string;
  side: string;
  entryPrice: number;
  currentPrice: number | null;
  notional: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number | null;
};

export async function getPaperLedgerSnapshot() {
  const startingBalance = envNumber("RAVEN_PAPER_STARTING_BALANCE", 100000);
  const fallbackNotional = envNumber("RAVEN_MAX_NOTIONAL_PER_TRADE", 1000);

  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      startingBalance,
      currentEquity: startingBalance,
      cash: startingBalance,
      realizedPnl: 0,
      unrealizedPnl: 0,
      openExposure: 0,
      closedTrades: 0,
      openTrades: 0,
      wins: 0,
      losses: 0,
      winRate: null as number | null,
      trades: [] as OpenLedgerTrade[],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureRavenTables();
  const sql = db();

  const rows = await sql<TradeRow[]>`
    select
      ticker,
      side,
      status,
      entry_price::text,
      exit_price::text,
      pnl_percent::text,
      notional::text
    from paper_trades
    order by opened_at asc
  `;

  const openRows = rows.filter((row) => row.status === "open");
  const closedRows = rows.filter((row) => row.status === "closed");

  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;

  for (const row of closedRows) {
    const notional = asNumber(row.notional) || fallbackNotional;
    const pnlPercent = asNumber(row.pnl_percent);
    const entry = asNumber(row.entry_price);
    const exit = asNumber(row.exit_price);
    let pnl = 0;

    if (pnlPercent !== null) {
      pnl = (pnlPercent / 100) * notional;
    } else if (entry && exit) {
      const rawPnlPercent = row.side === "long" ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
      pnl = (rawPnlPercent / 100) * notional;
    }

    realizedPnl += pnl;
    if (pnl > 0) wins += 1;
    if (pnl < 0) losses += 1;
  }

  let unrealizedPnl = 0;
  let openExposure = 0;
  const openTrades: OpenLedgerTrade[] = [];
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const row of openRows) {
    const entry = asNumber(row.entry_price);
    const notional = asNumber(row.notional) || fallbackNotional;
    if (!entry || entry <= 0) continue;

    openExposure += notional;
    const currentPrice = await latestClose(row.ticker);
    let tradePnl = 0;
    let pnlPercent: number | null = null;

    if (currentPrice !== null && currentPrice > 0) {
      pnlPercent = row.side === "long" ? ((currentPrice - entry) / entry) * 100 : ((entry - currentPrice) / entry) * 100;
      tradePnl = (pnlPercent / 100) * notional;
      unrealizedPnl += tradePnl;
    } else {
      errors.push({ ticker: row.ticker, error: "Could not fetch latest close for open trade." });
    }

    openTrades.push({
      ticker: row.ticker,
      side: row.side,
      entryPrice: round(entry, 4),
      currentPrice: currentPrice === null ? null : round(currentPrice, 4),
      notional: round(notional, 2),
      unrealizedPnl: round(tradePnl, 2),
      unrealizedPnlPercent: pnlPercent === null ? null : round(pnlPercent, 2)
    });
  }

  const currentEquity = startingBalance + realizedPnl + unrealizedPnl;
  const totalClosed = wins + losses;

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    startingBalance: round(startingBalance, 2),
    currentEquity: round(currentEquity, 2),
    cash: round(startingBalance + realizedPnl - openExposure, 2),
    realizedPnl: round(realizedPnl, 2),
    unrealizedPnl: round(unrealizedPnl, 2),
    openExposure: round(openExposure, 2),
    closedTrades: closedRows.length,
    openTrades: openRows.length,
    wins,
    losses,
    winRate: totalClosed ? round((wins / totalClosed) * 100, 2) : null,
    trades: openTrades.slice(0, 12),
    errors
  };
}
