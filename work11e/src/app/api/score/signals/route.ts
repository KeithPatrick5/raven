import { NextResponse } from "next/server";
import { scorePendingSignals } from "@/lib/scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requestedLimit(url: string): number {
  const parsed = new URL(url);
  const raw = Number(parsed.searchParams.get("limit") || "10");
  if (!Number.isFinite(raw)) return 10;
  return Math.max(1, Math.min(25, Math.floor(raw)));
}

async function runScoring(request: Request) {
  const startedAt = new Date().toISOString();
  const limit = requestedLimit(request.url);
  const result = await scorePendingSignals(limit);

  return NextResponse.json({
    phase: "SIGNAL_SCORING",
    startedAt,
    finishedAt: new Date().toISOString(),
    limit,
    ...result
  });
}

export async function GET(request: Request) {
  try {
    return await runScoring(request);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        phase: "SIGNAL_SCORING",
        error: error instanceof Error ? error.message : "Unknown scoring failure"
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
