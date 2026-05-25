import { getPaperAccountSnapshot } from "@/lib/alpaca";

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
  const snapshot = await getPaperAccountSnapshot();
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
