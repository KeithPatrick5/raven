import { NextResponse } from "next/server";
import { getPaperAccountSnapshot } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = new Date().toISOString();
  const snapshot = await getPaperAccountSnapshot();

  return NextResponse.json({
    phase: "PAPER_ACCOUNT_READ_ONLY",
    startedAt,
    finishedAt: new Date().toISOString(),
    ...snapshot
  }, { status: snapshot.ok ? 200 : 207 });
}
