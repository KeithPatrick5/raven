import { NextRequest, NextResponse } from "next/server";
import { getSignalTruthSnapshot, syncSignalTruthOutcomes } from "@/lib/signalTruth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const window = request.nextUrl.searchParams.get("window") || "7d";
  const sync = request.nextUrl.searchParams.get("sync") === "1";

  if (sync) {
    await syncSignalTruthOutcomes(25);
  }

  const snapshot = await getSignalTruthSnapshot(window);
  return NextResponse.json(snapshot);
}
