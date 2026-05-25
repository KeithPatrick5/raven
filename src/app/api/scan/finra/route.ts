import { NextResponse } from "next/server";
import { scanFinraShortVolume } from "@/lib/finra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const startedAt = new Date().toISOString();

  try {
    const result = await scanFinraShortVolume();
    return NextResponse.json({
      phase: "FINRA_SHORT_VOLUME_SCANNER",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "FINRA_SHORT_VOLUME_SCANNER",
      startedAt,
      finishedAt: new Date().toISOString(),
      rowCount: 0,
      signalCount: 0,
      errors: [{ error: error instanceof Error ? error.message : "Unknown FINRA scanner failure" }]
    }, { status: 500 });
  }
}

export async function POST() {
  return GET();
}
