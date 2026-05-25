import { NextResponse } from "next/server";
import { getPaperExecutionTextReport } from "@/lib/paperExecution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await getPaperExecutionTextReport();
    return new NextResponse(report, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return new NextResponse([
      "RAVEN PAPER EXECUTION SWITCH",
      "============================",
      "Status: needs_attention",
      "",
      "ERROR",
      "-----",
      error instanceof Error ? error.message : "Unknown paper execution report failure"
    ].join("\n"), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
