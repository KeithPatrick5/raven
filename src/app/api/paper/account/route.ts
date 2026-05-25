import { NextResponse } from "next/server";
import { getAlpacaPaperSnapshot } from "@/lib/alpacaTrading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = new Date().toISOString();

  try {
    const snapshot = await getAlpacaPaperSnapshot(10);
    return NextResponse.json({
      phase: "ALPACA_PAPER_ACCOUNT_READ_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...snapshot
    });
  } catch (error) {
    return NextResponse.json({
      phase: "ALPACA_PAPER_ACCOUNT_READ_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      configured: false,
      mode: "paper_read_only",
      liveTrading: "disabled",
      account: null,
      positions: [],
      orders: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper account route failure" }]
    }, { status: 500 });
  }
}
