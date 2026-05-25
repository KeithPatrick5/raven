import { NextResponse } from "next/server";
import { getCronStatusSnapshot } from "@/lib/cronStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getCronStatusSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "CRON_STATUS",
      error: error instanceof Error ? error.message : "Unknown cron status failure"
    }, { status: 500 });
  }
}
