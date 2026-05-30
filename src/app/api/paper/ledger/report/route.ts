import { NextResponse } from "next/server";
import { getPaperLedgerSnapshot } from "@/lib/paperLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${money(value)}`;
}

export async function GET() {
  try {
    const ledger = await getPaperLedgerSnapshot();
    const lines = [
      "RAVEN PAPER LEDGER",
      "==================",
      `Status: ${ledger.ok ? "ok" : "needs_attention"}`,
      "",
      "BALANCE",
      "-------",
      `Starting balance: ${money(ledger.startingBalance)}`,
      `Current sim equity: ${money(ledger.currentEquity)}`,
      `Cash after open exposure: ${money(ledger.cash)}`,
      `Open exposure: ${money(ledger.openExposure)}`,
      `Realized P/L: ${signedMoney(ledger.realizedPnl)}`,
      `Unrealized P/L: ${signedMoney(ledger.unrealizedPnl)}`,
      "",
      "TRADES",
      "------",
      `Open trades: ${ledger.openTrades}`,
      `Closed trades: ${ledger.closedTrades}`,
      `Wins: ${ledger.wins}`,
      `Losses: ${ledger.losses}`,
      `Win rate: ${ledger.winRate === null ? "--" : `${ledger.winRate}%`}`
    ];

    if (ledger.trades.length) {
      lines.push("", "OPEN SIM POSITIONS", "------------------");
      for (const trade of ledger.trades) {
        lines.push(`${trade.ticker} | ${trade.side.toUpperCase()} | ${money(trade.notional)} notional | entry ${trade.entryPrice} | latest ${trade.currentPrice ?? "--"} | P/L ${signedMoney(trade.unrealizedPnl)}`);
      }
    }

    if (ledger.errors.length) {
      lines.push("", "WARNINGS", "--------");
      for (const error of ledger.errors) {
        const ticker = "ticker" in error && error.ticker ? error.ticker : "UNKNOWN";
        lines.push(`${ticker}: ${error.error}`);
      }
    }

    return new NextResponse(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } catch (error) {
    return new NextResponse([
      "RAVEN PAPER LEDGER",
      "==================",
      "Status: needs_attention",
      "",
      "ERROR",
      "-----",
      error instanceof Error ? error.message : "Unknown paper ledger report failure"
    ].join("\n"), { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
}
