import { NextRequest, NextResponse } from "next/server";
import { getPaperTradePlanTextReport } from "@/lib/paperPlanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 8;

  try {
    const report = await getPaperTradePlanTextReport(Number.isFinite(limit) ? limit : 8);
    return new NextResponse(report, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return new NextResponse([
      "RAVEN PAPER TRADE PLAN",
      "======================",
      "Status: needs_attention",
      "",
      "ERROR",
      "-----",
      error instanceof Error ? error.message : "Unknown paper plan report failure"
    ].join("\n"), {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
