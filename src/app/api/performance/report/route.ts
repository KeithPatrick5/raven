import { NextRequest, NextResponse } from "next/server";
import { buildPerformanceReport, getPerformanceSnapshot } from "@/lib/performance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const window = request.nextUrl.searchParams.get("window");
  const snapshot = await getPerformanceSnapshot(window);
  return new NextResponse(buildPerformanceReport(snapshot), {
    status: snapshot.ok ? 200 : 500,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
