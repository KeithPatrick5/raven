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

function pct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function errorLabel(error: { ticker?: string; error: string }) {
  const ticker = "ticker" in error && error.ticker ? error.ticker : "UNKNOWN";
  return `${ticker}: ${error.error}`;
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
      `Cash after active open exposure: ${money(ledger.cash)}`,
      `Active open exposure: ${money(ledger.openExposure)}`,
      `Realized P/L: ${signedMoney(ledger.realizedPnl)}`,
      `Pending-close P/L: ${signedMoney(ledger.pendingExitPnl)}`,
      `Unrealized active-open P/L: ${signedMoney(ledger.unrealizedPnl)}`,
      "",
      "TRADE COUNTS",
      "------------",
      `Active open trades: ${ledger.openTrades}`,
      `Pending close/sync trades: ${ledger.pendingExitTrades}`,
      `Closed trades: ${ledger.closedTrades}`,
      `Wins: ${ledger.wins}`,
      `Losses: ${ledger.losses}`,
      `Win rate: ${ledger.winRate === null ? "--" : `${ledger.winRate}%`}`,
      "",
      "BROKER SYNC NOTE",
      "----------------",
      ledger.brokerSync.note
    ];

    if (ledger.openPositions.length) {
      lines.push("", "ACTIVE OPEN SIM POSITIONS", "-------------------------");
      for (const trade of ledger.openPositions.slice(0, 12)) {
        const legacy = trade.legacyDuplicate ? ` | legacy duplicate group ${trade.duplicateCount}x` : "";
        lines.push(`${trade.ticker} | ${trade.side.toUpperCase()} | ${money(trade.notional)} notional | entry ${trade.entryPrice} | latest ${trade.currentPrice ?? "--"} | P/L ${signedMoney(trade.pnl)} (${pct(trade.pnlPercent)})${legacy}`);
      }
    } else {
      lines.push("", "ACTIVE OPEN SIM POSITIONS", "-------------------------", "None");
    }

    if (ledger.pendingExitPositions.length) {
      lines.push("", "PENDING CLOSE / SYNC", "--------------------");
      for (const trade of ledger.pendingExitPositions.slice(0, 12)) {
        const legacy = trade.legacyDuplicate ? ` | legacy duplicate group ${trade.duplicateCount}x` : "";
        lines.push(`${trade.ticker} | ${trade.wouldOutcome.toUpperCase()} | ${trade.exitReason} | ${money(trade.notional)} notional | entry ${trade.entryPrice} | latest ${trade.currentPrice ?? "--"} | P/L ${signedMoney(trade.pnl)} (${pct(trade.pnlPercent)})${legacy}`);
      }
    }

    if (ledger.closedPositions.length) {
      lines.push("", "RECENT CLOSED SIM TRADES", "------------------------");
      for (const trade of ledger.closedPositions.slice(0, 12)) {
        lines.push(`${trade.ticker} | ${(trade.outcome || "closed").toUpperCase()} | ${money(trade.notional)} notional | entry ${trade.entryPrice} | exit ${trade.exitPrice ?? "--"} | P/L ${signedMoney(trade.pnl)} (${pct(trade.pnlPercent)}) | ${trade.closeReason || "closed"}`);
      }
    }

    if (ledger.duplicateTickers.length) {
      lines.push("", "LEGACY DUPLICATE TEST ROWS", "--------------------------");
      for (const row of ledger.duplicateTickers) {
        lines.push(`${row.ticker}: ${row.openCount} active open rows. Future runs are deduped; these remain historical test noise unless manually cleaned.`);
      }
    }

    const allWarnings = [...ledger.warnings, ...ledger.errors];
    if (allWarnings.length) {
      lines.push("", "WARNINGS", "--------");
      for (const error of allWarnings) lines.push(errorLabel(error));
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
