import { NextResponse } from "next/server";
import { runPaperOrderExecution } from "@/lib/paperExecution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await runPaperOrderExecution({ submit: false });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "preview_only",
      liveTrading: "disabled",
      paperTradingEnabled: false,
      orderSubmission: "failed",
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper execution preview failure" }]
    }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await runPaperOrderExecution({ submit: true });
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "PAPER_ORDER_EXECUTION_SWITCH",
      mode: "paper_execution_enabled",
      liveTrading: "disabled",
      paperTradingEnabled: false,
      orderSubmission: "failed",
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper order execution failure" }]
    }, { status: 500 });
  }
}
