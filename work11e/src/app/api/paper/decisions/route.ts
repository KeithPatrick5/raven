import { NextRequest, NextResponse } from "next/server";
import { getLatestPaperDecisions, getLatestPaperTrades } from "@/lib/paper";
import { hasDatabase } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const limitParam = Number(request.nextUrl.searchParams.get("limit") || "10");
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(50, Math.floor(limitParam))) : 10;

  try {
    if (!hasDatabase()) {
      return NextResponse.json({
        phase: "PAPER_TRADE_DECISIONS",
        startedAt,
        finishedAt: new Date().toISOString(),
        limit,
        ok: false,
        database: "not_configured",
        decisions: [],
        trades: [],
        errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
      }, { status: 500 });
    }

    const [decisions, trades] = await Promise.all([
      getLatestPaperDecisions(limit),
      getLatestPaperTrades(limit)
    ]);

    return NextResponse.json({
      phase: "PAPER_TRADE_DECISIONS",
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      ok: true,
      database: "configured",
      decisionCount: decisions.length,
      tradeCount: trades.length,
      decisions,
      trades,
      errors: []
    });
  } catch (error) {
    return NextResponse.json({
      phase: "PAPER_TRADE_DECISIONS",
      startedAt,
      finishedAt: new Date().toISOString(),
      limit,
      ok: false,
      database: hasDatabase() ? "configured" : "not_configured",
      decisions: [],
      trades: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper decision route failure" }]
    }, { status: 500 });
  }
}
