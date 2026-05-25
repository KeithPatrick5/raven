import { NextRequest, NextResponse } from "next/server";
import { getPaperTradePlan } from "@/lib/paperPlanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 10;

  try {
    const result = await getPaperTradePlan(Number.isFinite(limit) ? limit : 10);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "PAPER_TRADE_PLANNER",
      mode: "plan_only_no_orders",
      liveTrading: "disabled",
      paperTrading: "not_enabled_for_execution",
      candidatesReviewed: 0,
      eligible: 0,
      rejected: 0,
      plans: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper planner failure" }]
    }, { status: 500 });
  }
}
