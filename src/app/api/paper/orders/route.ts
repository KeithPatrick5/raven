import { NextResponse } from "next/server";
import { getPaperAccountSnapshot } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getPaperAccountSnapshot();

  return NextResponse.json({
    phase: "PAPER_ORDERS_READ_ONLY",
    ok: snapshot.ok,
    mode: snapshot.mode,
    liveTrading: snapshot.liveTrading,
    alpaca: snapshot.alpaca,
    openCount: snapshot.openOrders.length,
    recentCount: snapshot.recentOrders.length,
    openOrders: snapshot.openOrders,
    recentOrders: snapshot.recentOrders,
    errors: snapshot.errors
  }, { status: snapshot.ok ? 200 : 207 });
}
