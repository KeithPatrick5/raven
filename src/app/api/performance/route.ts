import { NextRequest, NextResponse } from "next/server";
import { getPerformanceSnapshot } from "@/lib/performance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const window = request.nextUrl.searchParams.get("window");
  const result = await getPerformanceSnapshot(window);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
