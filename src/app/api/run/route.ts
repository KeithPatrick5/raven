import { NextResponse } from "next/server";
import { runRavenPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const result = await runRavenPipeline();
    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "RAVEN_PIPELINE_RUNNER",
      liveTrading: "disabled",
      error: error instanceof Error ? error.message : "Unknown Raven pipeline failure"
    }, { status: 500 });
  }
}

export async function POST() {
  return GET();
}
