import { NextResponse } from "next/server";
import { getPaperAccountSnapshot } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function money(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export async function GET() {
  const snapshot = await getPaperAccountSnapshot();
  const summary = snapshot.summary;

  const openPositions = snapshot.positions.length
    ? snapshot.positions.map((position) => `${position.symbol} | ${position.side} | qty ${position.qty} | value ${position.market_value} | P/L ${position.unrealized_pl} (${position.unrealized_plpc})`)
    : ["None"];

  const openOrders = snapshot.openOrders.length
    ? snapshot.openOrders.map((order) => `${order.symbol} | ${order.side} | ${order.type} | qty ${order.qty || order.notional || "--"} | ${order.status}`)
    : ["None"];

  const recentOrders = snapshot.recentOrders.length
    ? snapshot.recentOrders.slice(0, 10).map((order) => `${order.symbol} | ${order.side} | ${order.type} | ${order.status} | submitted ${order.submitted_at || "--"}`)
    : ["None"];

  const lines = [
    "RAVEN PAPER ACCOUNT",
    "===================",
    `Status: ${snapshot.ok ? "connected" : "needs attention"}`,
    "Mode: PAPER",
    "Live trading: disabled",
    `Alpaca: ${snapshot.alpaca}`,
    "",
    "ACCOUNT",
    "-------",
    `Equity: ${money(summary.equity)}`,
    `Cash: ${money(summary.cash)}`,
    `Buying power: ${money(summary.buyingPower)}`,
    `Portfolio value: ${money(summary.portfolioValue)}`,
    `Long market value: ${money(summary.longMarketValue)}`,
    `Today P/L: ${money(summary.todayPl)} / ${pct(summary.todayPlPercent)}`,
    `Open positions: ${summary.openPositions}`,
    `Open orders: ${summary.openOrders}`,
    "",
    "OPEN POSITIONS",
    "--------------",
    ...openPositions,
    "",
    "OPEN ORDERS",
    "-----------",
    ...openOrders,
    "",
    "RECENT ORDERS",
    "-------------",
    ...recentOrders,
    "",
    "RAVEN STATUS",
    "------------",
    "Paper account is read-only in 13A.",
    "Order placement remains disabled until 13B.",
    ...snapshot.errors.length ? ["", "ISSUES", "------", ...snapshot.errors.map((item) => item.error)] : []
  ];

  return new NextResponse(`${lines.join("\n")}\n`, {
    status: snapshot.ok ? 200 : 207,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
