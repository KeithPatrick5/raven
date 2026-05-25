import { NextResponse } from "next/server";
import { buildCronStatusReport, getCronStatusSnapshot } from "@/lib/cronStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getCronStatusSnapshot();
    return new NextResponse(buildCronStatusReport(snapshot), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  } catch (error) {
    return new NextResponse(`RAVEN CRON STATUS ERROR\n=======================\n${error instanceof Error ? error.message : "Unknown cron status failure"}\n`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
}
