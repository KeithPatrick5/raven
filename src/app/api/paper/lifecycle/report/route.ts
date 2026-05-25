import { NextResponse } from "next/server";
import { getPaperLifecycleTextReport } from "@/lib/paperLifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await getPaperLifecycleTextReport();
    return new NextResponse(report, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return new NextResponse([
      "RAVEN PAPER POSITION LIFECYCLE",
      "==============================",
      "Status: needs_attention",
      "",
      "ERROR",
      "-----",
      error instanceof Error ? error.message : "Unknown paper lifecycle report failure"
    ].join("\n"), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
