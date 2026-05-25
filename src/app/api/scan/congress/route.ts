import { NextResponse } from "next/server";
import { scanCongressSignals } from "@/lib/congress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const result = await scanCongressSignals();
    return NextResponse.json(result, { status: result.ok ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "CONGRESS_SCANNER",
      finishedAt: new Date().toISOString(),
      signalCount: 0,
      errors: [{ error: error instanceof Error ? error.message : "Unknown congressional scanner failure" }]
    }, { status: 500 });
  }
}

export async function POST() {
  return GET();
}
