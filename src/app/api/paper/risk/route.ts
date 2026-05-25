import { NextResponse } from "next/server";
import { getPaperTradePlan } from "@/lib/paperPlanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const plan = await getPaperTradePlan(1);
    return NextResponse.json({
      ok: plan.ok,
      phase: "PAPER_RISK_LIMITS",
      mode: "risk_read_only",
      account: plan.account,
      riskLimits: plan.riskLimits,
      riskState: plan.riskState,
      errors: plan.errors
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "PAPER_RISK_LIMITS",
      error: error instanceof Error ? error.message : "Unknown paper risk failure"
    }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
