import { NextRequest, NextResponse } from "next/server";
import { reviewOpenPaperTrades } from "@/lib/paper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const limitParam = Number(request.nextUrl.searchParams.get("limit") || "10");
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(25, Math.floor(limitParam))) : 10;

  try {
    const result = await reviewOpenPaperTrades(limit);

    return NextResponse.json({
      phase: "PAPER_TRADE_REVIEW",
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      liveTrading: "disabled",
      ...result
    });
  } catch (error) {
    return NextResponse.json({
      phase: "PAPER_TRADE_REVIEW",
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      liveTrading: "disabled",
      ok: false,
      reviewed: 0,
      closed: 0,
      stillOpen: 0,
      closes: [],
      open: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper-trade review route failure" }]
    }, { status: 500 });
  }
}
