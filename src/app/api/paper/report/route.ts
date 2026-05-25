import { getPaperAccountSnapshot } from "@/lib/alpaca";
import { getLatestPaperDecisions, getLatestPaperTrades } from "@/lib/paper";

export const dynamic = "force-dynamic";

function money(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${money(value)}`;
}

function signedPct(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export async function GET() {
  const [snapshot, trades, decisions] = await Promise.all([
    getPaperAccountSnapshot(),
    getLatestPaperTrades(25),
    getLatestPaperDecisions(25)
  ]);
  const pendingTrades = trades.filter((trade) => trade.status === "pending_entry");
  const openTrades = trades.filter((trade) => trade.status === "open" || trade.status === "pending_exit");
  const closedTrades = trades.filter((trade) => trade.status === "closed");
  const rejected = decisions.filter((decision) => decision.decision === "reject");
  const lines: string[] = [];

  lines.push("RAVEN PAPER ACCOUNT");
  lines.push("===================");
  lines.push(`Status: ${snapshot.ok ? "connected" : snapshot.alpaca}`);
  lines.push("Mode: PAPER");
  lines.push("Live trading: disabled");
  lines.push(`Equity: ${money(snapshot.summary.equity)}`);
  lines.push(`Cash: ${money(snapshot.summary.cash)}`);
  lines.push(`Buying power: ${money(snapshot.summary.buyingPower)}`);
  lines.push(`Portfolio value: ${money(snapshot.summary.portfolioValue)}`);
  lines.push(`Today P/L: ${signedMoney(snapshot.summary.todayPl)} / ${signedPct(snapshot.summary.todayPlPercent)}`);
  lines.push(`Open positions: ${snapshot.summary.openPositions}`);
  lines.push(`Open orders: ${snapshot.summary.openOrders}`);
  lines.push("");
  lines.push("OPEN POSITIONS");
  lines.push("--------------");
  if (snapshot.positions.length) {
    for (const position of snapshot.positions) {
      const pl = Number(position.unrealized_pl);
      const plpc = Number(position.unrealized_plpc) * 100;
      lines.push(`${position.symbol} | qty ${position.qty} | avg $${position.avg_entry_price} | current $${position.current_price} | P/L ${Number.isFinite(pl) ? signedMoney(pl) : "--"} / ${Number.isFinite(plpc) ? signedPct(plpc) : "--"}`);
    }
  } else {
    lines.push("None");
  }
  lines.push("");
  lines.push("OPEN ORDERS");
  lines.push("-----------");
  if (snapshot.openOrders.length) {
    for (const order of snapshot.openOrders) {
      lines.push(`${order.symbol} | ${order.side} | ${order.type} | ${order.status} | qty ${order.qty || "--"} | notional ${order.notional || "--"}`);
    }
  } else {
    lines.push("None");
  }
  lines.push("");
  lines.push("RECENT ORDERS");
  lines.push("-------------");
  if (snapshot.recentOrders.length) {
    for (const order of snapshot.recentOrders.slice(0, 10)) {
      lines.push(`${order.symbol} | ${order.side} | ${order.type} | ${order.status} | submitted ${order.submitted_at || "--"}`);
    }
  } else {
    lines.push("None");
  }

  lines.push("");
  lines.push("RAVEN PAPER TRADES");
  lines.push("------------------");
  lines.push(`Pending entries: ${pendingTrades.length}`);
  lines.push(`Open local trades: ${openTrades.length}`);
  lines.push(`Closed local trades: ${closedTrades.length}`);
  lines.push(`Rejected candidates: ${rejected.length}`);

  lines.push("");
  lines.push("PENDING ENTRIES");
  lines.push("---------------");
  if (pendingTrades.length) {
    for (const trade of pendingTrades.slice(0, 10)) {
      lines.push(`${trade.ticker} | score ${trade.final_score} | notional ${money(trade.notional)} | entry ref ${money(trade.entry_price)} | target ${money(trade.target_price)} | stop ${money(trade.stop_price)}`);
    }
  } else {
    lines.push("None");
  }

  lines.push("");
  lines.push("LOCAL OPEN TRADES");
  lines.push("-----------------");
  if (openTrades.length) {
    for (const trade of openTrades.slice(0, 10)) {
      lines.push(`${trade.ticker} | ${trade.status} | notional ${money(trade.notional)} | qty ${trade.qty || "--"} | target ${money(trade.target_price)} | stop ${money(trade.stop_price)} | order ${trade.alpaca_order_id || "--"}`);
    }
  } else {
    lines.push("None");
  }

  lines.push("");
  lines.push("LOCAL CLOSED TRADES");
  lines.push("-------------------");
  if (closedTrades.length) {
    for (const trade of closedTrades.slice(0, 10)) {
      lines.push(`${trade.ticker} | ${trade.outcome || "closed"} | entry ${money(trade.entry_price)} | exit ${money(trade.exit_price)} | P/L ${signedPct(trade.pnl_percent)}`);
    }
  } else {
    lines.push("None");
  }

  lines.push("");
  lines.push("REJECTED CANDIDATES");
  lines.push("-------------------");
  if (rejected.length) {
    for (const item of rejected.slice(0, 10)) {
      const rejects = Array.isArray(item.reject_codes) ? item.reject_codes.join(", ") : "rejected";
      lines.push(`${item.ticker} | score ${item.final_score} | ${item.action} | ${rejects}`);
    }
  } else {
    lines.push("None");
  }

  lines.push("");
  lines.push("RAVEN STATUS");
  lines.push("------------");
  lines.push("Paper execution requires RAVEN_PAPER_EXECUTION_ENABLED=true.");
  lines.push("Live trading disabled.");

  if (snapshot.errors.length) {
    lines.push("");
    lines.push("ERRORS");
    lines.push("------");
    snapshot.errors.forEach((item) => lines.push(item.error));
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
