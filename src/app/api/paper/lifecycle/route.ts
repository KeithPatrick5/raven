import { NextResponse } from "next/server";
import { getPaperPositionLifecycle } from "@/lib/paperLifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getPaperPositionLifecycle();
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "PAPER_POSITION_LIFECYCLE",
      mode: "paper_lifecycle_read_only",
      liveTrading: "disabled",
      orderSubmission: "disabled_by_default",
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper lifecycle failure" }]
    }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
