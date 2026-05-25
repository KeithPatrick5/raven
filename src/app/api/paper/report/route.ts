import { NextResponse } from "next/server";
import { getAlpacaPaperTextReport } from "@/lib/alpacaTrading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await getAlpacaPaperTextReport();
    return new NextResponse(report, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return new NextResponse([
      "RAVEN PAPER ACCOUNT",
      "===================",
      "Status: needs_attention",
      "",
      "ERROR",
      "-----",
      error instanceof Error ? error.message : "Unknown paper report route failure"
    ].join("\n"), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
