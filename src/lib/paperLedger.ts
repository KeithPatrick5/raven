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
  id: number;
  ticker: string;
  accession_number: string | null;
  side: string;
  status: string;
  entry_price: string | null;
  stop_price: string | null;
  target_price: string | null;
  exit_price: string | null;
  pnl_percent: string | null;
  outcome: string | null;
  close_reason: string | null;
  notional: string | null;
  opened_at: string | null;
  closed_at: string | null;
};

type LedgerTradeBase = {
  id: number;
  ticker: string;
  accessionNumber: string | null;
  side: string;
  entryPrice: number;
  currentPrice: number | null;
  notional: number;
  pnl: number;
  pnlPercent: number | null;
  openedAt: string | null;
  duplicateCount: number;
  legacyDuplicate: boolean;
};

export type OpenLedgerTrade = LedgerTradeBase & {
  stopPrice: number | null;
  targetPrice: number | null;
};

export type PendingExitLedgerTrade = OpenLedgerTrade & {
  exitReason: string;
  wouldOutcome: "win" | "loss" | "unknown";
};

export type ClosedLedgerTrade = LedgerTradeBase & {
  exitPrice: number | null;
  outcome: string | null;
  closeReason: string | null;
  closedAt: string | null;
};

function tradePnl(args: { side: string; entry: number; price: number; notional: number }) {
  const pnlPercent = args.side === "long" ? ((args.price - args.entry) / args.entry) * 100 : ((args.entry - args.price) / args.entry) * 100;
  return { pnlPercent, pnl: (pnlPercent / 100) * args.notional };
}

function exitTriggered(row: TradeRow, currentPrice: number | null) {
  const stop = asNumber(row.stop_price);
  const target = asNumber(row.target_price);
  if (currentPrice === null) return null;
  if (row.side === "long") {
    if (stop !== null && currentPrice <= stop) return { reason: "stop_hit", outcome: "loss" as const };
    if (target !== null && currentPrice >= target) return { reason: "target_hit", outcome: "win" as const };
  } else {
    if (stop !== null && currentPrice >= stop) return { reason: "stop_hit", outcome: "loss" as const };
    if (target !== null && currentPrice <= target) return { reason: "target_hit", outcome: "win" as const };
  }
  return null;
}

function fallbackSnapshot(startingBalance: number, error: string) {
  return {
    ok: false,
    database: "not_configured" as const,
    startingBalance,
    currentEquity: startingBalance,
    cash: startingBalance,
    realizedPnl: 0,
    unrealizedPnl: 0,
    pendingExitPnl: 0,
    openExposure: 0,
    closedTrades: 0,
    openTrades: 0,
    pendingExitTrades: 0,
    wins: 0,
    losses: 0,
    winRate: null as number | null,
    trades: [] as OpenLedgerTrade[],
    openPositions: [] as OpenLedgerTrade[],
    pendingExitPositions: [] as PendingExitLedgerTrade[],
    closedPositions: [] as ClosedLedgerTrade[],
    duplicateTickers: [] as Array<{ ticker: string; openCount: number }> ,
    brokerSync: {
      note: "Alpaca broker paper balance is reported separately. Raven sim equity is calculated from internal paper_trades rows."
    },
    warnings: [] as Array<{ ticker?: string; error: string }>,
    errors: [{ error }]
  };
}

export async function getPaperLedgerSnapshot() {
  const startingBalance = envNumber("RAVEN_PAPER_STARTING_BALANCE", 100000);
  const fallbackNotional = envNumber("RAVEN_MAX_NOTIONAL_PER_TRADE", 1000);

  if (!hasDatabase()) {
    return fallbackSnapshot(startingBalance, "DATABASE_URL or STORAGE_URL is not configured.");
  }

  await ensureRavenTables();
  const sql = db();

  const rows = await sql<TradeRow[]>`
    select
      id,
      ticker,
      accession_number,
      side,
      status,
      entry_price::text,
      stop_price::text,
      target_price::text,
      exit_price::text,
      pnl_percent::text,
      outcome,
      close_reason,
      notional::text,
      opened_at::text,
      closed_at::text
    from paper_trades
    order by opened_at asc
  `;

  const openRows = rows.filter((row) => row.status === "open");
  const closedRows = rows.filter((row) => row.status === "closed");
  const openTickerCounts = openRows.reduce((map, row) => {
    const ticker = row.ticker.toUpperCase();
    map.set(ticker, (map.get(ticker) || 0) + 1);
    return map;
  }, new Map<string, number>());
  const duplicateTickers = [...openTickerCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([ticker, openCount]) => ({ ticker, openCount }));

  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let pendingExitPnl = 0;
  let openExposure = 0;
  let wins = 0;
  let losses = 0;
  const activeOpenTrades: OpenLedgerTrade[] = [];
  const pendingExitTrades: PendingExitLedgerTrade[] = [];
  const closedTrades: ClosedLedgerTrade[] = [];
  const warnings: Array<{ ticker?: string; error: string }> = [];
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const row of closedRows) {
    const notional = asNumber(row.notional) || fallbackNotional;
    const pnlPercent = asNumber(row.pnl_percent);
    const entry = asNumber(row.entry_price);
    const exit = asNumber(row.exit_price);
    let pnl = 0;
    let computedPnlPercent: number | null = pnlPercent;

    if (pnlPercent !== null) {
      pnl = (pnlPercent / 100) * notional;
    } else if (entry && exit) {
      const computed = tradePnl({ side: row.side, entry, price: exit, notional });
      computedPnlPercent = computed.pnlPercent;
      pnl = computed.pnl;
    }

    realizedPnl += pnl;
    if (pnl > 0) wins += 1;
    if (pnl < 0) losses += 1;

    if (entry) {
      closedTrades.push({
        id: row.id,
        ticker: row.ticker,
        accessionNumber: row.accession_number,
        side: row.side,
        entryPrice: round(entry, 4),
        exitPrice: exit === null ? null : round(exit, 4),
        currentPrice: exit === null ? null : round(exit, 4),
        notional: round(notional, 2),
        pnl: round(pnl, 2),
        pnlPercent: computedPnlPercent === null ? null : round(computedPnlPercent, 2),
        outcome: row.outcome,
        closeReason: row.close_reason,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        duplicateCount: openTickerCounts.get(row.ticker.toUpperCase()) || 0,
        legacyDuplicate: (openTickerCounts.get(row.ticker.toUpperCase()) || 0) > 1
      });
    }
  }

  for (const row of openRows) {
    const entry = asNumber(row.entry_price);
    const stopPrice = asNumber(row.stop_price);
    const targetPrice = asNumber(row.target_price);
    const notional = asNumber(row.notional) || fallbackNotional;
    if (!entry || entry <= 0) continue;

    const duplicateCount = openTickerCounts.get(row.ticker.toUpperCase()) || 0;
    const currentPrice = await latestClose(row.ticker);
    let tradePnlValue = 0;
    let pnlPercent: number | null = null;

    if (currentPrice !== null && currentPrice > 0) {
      const computed = tradePnl({ side: row.side, entry, price: currentPrice, notional });
      pnlPercent = computed.pnlPercent;
      tradePnlValue = computed.pnl;
    } else {
      errors.push({ ticker: row.ticker, error: "Could not fetch latest close for open trade." });
    }

    const baseTrade = {
      id: row.id,
      ticker: row.ticker,
      accessionNumber: row.accession_number,
      side: row.side,
      entryPrice: round(entry, 4),
      currentPrice: currentPrice === null ? null : round(currentPrice, 4),
      notional: round(notional, 2),
      pnl: round(tradePnlValue, 2),
      pnlPercent: pnlPercent === null ? null : round(pnlPercent, 2),
      openedAt: row.opened_at,
      duplicateCount,
      legacyDuplicate: duplicateCount > 1,
      stopPrice: stopPrice === null ? null : round(stopPrice, 4),
      targetPrice: targetPrice === null ? null : round(targetPrice, 4)
    };

    const triggered = exitTriggered(row, currentPrice);
    if (triggered) {
      pendingExitPnl += tradePnlValue;
      pendingExitTrades.push({
        ...baseTrade,
        exitReason: triggered.reason,
        wouldOutcome: triggered.outcome
      });
      warnings.push({ ticker: row.ticker, error: `Open sim trade has already crossed ${triggered.reason}. It is shown as pending close/sync instead of an active open position.` });
      continue;
    }

    openExposure += notional;
    unrealizedPnl += tradePnlValue;
    activeOpenTrades.push(baseTrade);
  }

  if (duplicateTickers.length) {
    for (const duplicate of duplicateTickers) {
      warnings.push({ ticker: duplicate.ticker, error: `${duplicate.openCount} open internal sim trades exist for this ticker from earlier open-mode testing. Future runs are deduped; these are legacy test rows.` });
    }
  }

  const currentEquity = startingBalance + realizedPnl + pendingExitPnl + unrealizedPnl;
  const totalClosed = wins + losses;

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    startingBalance: round(startingBalance, 2),
    currentEquity: round(currentEquity, 2),
    cash: round(startingBalance + realizedPnl + pendingExitPnl - openExposure, 2),
    realizedPnl: round(realizedPnl, 2),
    pendingExitPnl: round(pendingExitPnl, 2),
    unrealizedPnl: round(unrealizedPnl, 2),
    openExposure: round(openExposure, 2),
    closedTrades: closedRows.length,
    openTrades: activeOpenTrades.length,
    pendingExitTrades: pendingExitTrades.length,
    wins,
    losses,
    winRate: totalClosed ? round((wins / totalClosed) * 100, 2) : null,
    trades: activeOpenTrades.slice(0, 12),
    openPositions: activeOpenTrades.slice(0, 25),
    pendingExitPositions: pendingExitTrades.slice(0, 25),
    closedPositions: closedTrades.slice(-25).reverse(),
    duplicateTickers,
    brokerSync: {
      note: "Alpaca broker paper balance is reported separately. Raven sim equity is calculated from internal paper_trades rows."
    },
    warnings,
    errors
  };
}
