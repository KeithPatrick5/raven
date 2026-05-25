import { NextResponse } from "next/server";
import { getAlpacaPaperSnapshot } from "@/lib/alpacaTrading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = new Date().toISOString();

  try {
    const snapshot = await getAlpacaPaperSnapshot(5);
    return NextResponse.json({
      phase: "ALPACA_PAPER_POSITIONS_READ_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: snapshot.ok,
      configured: snapshot.configured,
      liveTrading: snapshot.liveTrading,
      positionCount: snapshot.positions.length,
      positions: snapshot.positions,
      summary: snapshot.summary,
      errors: snapshot.errors
    });
  } catch (error) {
    return NextResponse.json({
      phase: "ALPACA_PAPER_POSITIONS_READ_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      positions: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper positions route failure" }]
    }, { status: 500 });
  }
}
