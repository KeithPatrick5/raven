import { NextRequest, NextResponse } from "next/server";
import { getLatestPipelineRuns } from "@/lib/pipelineRuns";
import { runRavenPipeline } from "@/lib/pipeline";
import { buildPipelineTextReport, buildRunLogsTextReport } from "@/lib/readableReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const shouldRun = request.nextUrl.searchParams.get("run") === "1";

  try {
    if (shouldRun) {
      const result = await runRavenPipeline();
      return new NextResponse(buildPipelineTextReport(result), {
        status: result.ok ? 200 : 207,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    const rawLimit = Number(request.nextUrl.searchParams.get("limit") || "8");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, Math.floor(rawLimit))) : 8;
    const runs = await getLatestPipelineRuns(limit);
    return new NextResponse(buildRunLogsTextReport(runs), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  } catch (error) {
    return new NextResponse(`RAVEN REPORT ERROR\n==================\n${error instanceof Error ? error.message : "Unknown report failure"}\n`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
}
