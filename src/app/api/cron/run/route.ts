import { NextResponse } from "next/server";
import { runRavenPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run() {
  try {
    const result = await runRavenPipeline();
    return NextResponse.json({
      ...result,
      routeAlias: "/api/cron/run",
      actualCronRoute: "/api/run"
    }, { status: result.ok ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "RAVEN_PIPELINE_RUNNER",
      routeAlias: "/api/cron/run",
      actualCronRoute: "/api/run",
      liveTrading: "disabled",
      error: error instanceof Error ? error.message : "Unknown Raven pipeline failure"
    }, { status: 500 });
  }
}

export async function GET() {
  return run();
}

export async function POST() {
  return run();
}
