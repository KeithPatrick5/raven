import { NextRequest, NextResponse } from "next/server";
import { getAlpacaPaperSnapshot } from "@/lib/alpacaTrading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const limitParam = Number(request.nextUrl.searchParams.get("limit") || "20");
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, Math.floor(limitParam))) : 20;

  try {
    const snapshot = await getAlpacaPaperSnapshot(limit);
    return NextResponse.json({
      phase: "ALPACA_PAPER_ORDERS_READ_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: snapshot.ok,
      configured: snapshot.configured,
      liveTrading: snapshot.liveTrading,
      orderCount: snapshot.orders.length,
      orders: snapshot.orders,
      summary: snapshot.summary,
      errors: snapshot.errors
    });
  } catch (error) {
    return NextResponse.json({
      phase: "ALPACA_PAPER_ORDERS_READ_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      orders: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper orders route failure" }]
    }, { status: 500 });
  }
}
