import { NextRequest, NextResponse } from "next/server";
import { getSignalTruthReport, syncSignalTruthOutcomes } from "@/lib/signalTruth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const window = request.nextUrl.searchParams.get("window") || "7d";
  const sync = request.nextUrl.searchParams.get("sync") === "1";

  if (sync) {
    await syncSignalTruthOutcomes(25);
  }

  const report = await getSignalTruthReport(window);
  return new NextResponse(report, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
