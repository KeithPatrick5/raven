import { NextRequest, NextResponse } from "next/server";
import { runPaperTradeEngine } from "@/lib/paper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const limitParam = Number(request.nextUrl.searchParams.get("limit") || "10");
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(25, Math.floor(limitParam))) : 10;

  try {
    const result = await runPaperTradeEngine(limit);

    return NextResponse.json({
      phase: "PAPER_TRADE_ENGINE",
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      liveTrading: "disabled",
      ...result
    });
  } catch (error) {
    return NextResponse.json({
      phase: "PAPER_TRADE_ENGINE",
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      liveTrading: "disabled",
      ok: false,
      evaluated: 0,
      opened: 0,
      rejected: 0,
      trades: [],
      rejects: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper-trade route failure" }]
    }, { status: 500 });
  }
}
