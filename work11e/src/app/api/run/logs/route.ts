import { NextRequest, NextResponse } from "next/server";
import { getLatestPipelineRuns } from "@/lib/pipelineRuns";
import { hasDatabase } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const rawLimit = Number(request.nextUrl.searchParams.get("limit") || "10");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, Math.floor(rawLimit))) : 10;

  try {
    if (!hasDatabase()) {
      return NextResponse.json({
        ok: false,
        phase: "PIPELINE_RUN_LOGS",
        startedAt,
        finishedAt: new Date().toISOString(),
        database: "not_configured",
        runs: [],
        errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
      }, { status: 500 });
    }

    const runs = await getLatestPipelineRuns(limit);

    return NextResponse.json({
      ok: true,
      phase: "PIPELINE_RUN_LOGS",
      startedAt,
      finishedAt: new Date().toISOString(),
      database: "configured",
      count: runs.length,
      runs,
      errors: []
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "PIPELINE_RUN_LOGS",
      startedAt,
      finishedAt: new Date().toISOString(),
      database: hasDatabase() ? "configured" : "not_configured",
      runs: [],
      errors: [{ error: error instanceof Error ? error.message : "Unknown pipeline log failure" }]
    }, { status: 500 });
  }
}
