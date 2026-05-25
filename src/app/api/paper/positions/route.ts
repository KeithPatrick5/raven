import { NextResponse } from "next/server";
import { getPaperAccountSnapshot } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getPaperAccountSnapshot();

  return NextResponse.json({
    phase: "PAPER_POSITIONS_READ_ONLY",
    ok: snapshot.ok,
    mode: snapshot.mode,
    liveTrading: snapshot.liveTrading,
    alpaca: snapshot.alpaca,
    count: snapshot.positions.length,
    positions: snapshot.positions,
    errors: snapshot.errors
  }, { status: snapshot.ok ? 200 : 207 });
}
