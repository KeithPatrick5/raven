import { NextResponse } from "next/server";
import { confirmPendingSecSignalsWithAlpaca } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requestedLimit(url: string): number {
  const parsed = new URL(url);
  const raw = Number(parsed.searchParams.get("limit") || "3");
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(5, Math.floor(raw)));
}

async function runConfirmation(request: Request) {
  const startedAt = new Date().toISOString();
  const limit = requestedLimit(request.url);
  const result = await confirmPendingSecSignalsWithAlpaca(limit);

  return NextResponse.json({
    phase: "ALPACA_CONFIRMATION",
    startedAt,
    finishedAt: new Date().toISOString(),
    limit,
    ...result
  });
}

export async function GET(request: Request) {
  try {
    return await runConfirmation(request);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        phase: "ALPACA_CONFIRMATION",
        error: error instanceof Error ? error.message : "Unknown Alpaca confirmation failure"
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
