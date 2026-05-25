import { NextResponse } from "next/server";
import { getPaperRiskTextReport } from "@/lib/paperPlanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await getPaperRiskTextReport();
    return new NextResponse(report, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return new NextResponse([
      "RAVEN PAPER RISK LIMITS",
      "=======================",
      "Status: needs_attention",
      "",
      "ERROR",
      "-----",
      error instanceof Error ? error.message : "Unknown paper risk report failure"
    ].join("\n"), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
