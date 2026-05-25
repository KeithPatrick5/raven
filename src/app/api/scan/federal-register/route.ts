import { NextResponse } from "next/server";
import { scanFederalRegisterSignals } from "@/lib/federalRegister";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const startedAt = new Date().toISOString();

  try {
    const result = await scanFederalRegisterSignals();
    return NextResponse.json({
      phase: "FEDERAL_REGISTER_SCANNER",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...result
    }, { status: result.ok ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "FEDERAL_REGISTER_SCANNER",
      startedAt,
      finishedAt: new Date().toISOString(),
      signalCount: 0,
      errors: [{ error: error instanceof Error ? error.message : "Unknown Federal Register scanner failure" }]
    }, { status: 500 });
  }
}

export async function POST() {
  return GET();
}
