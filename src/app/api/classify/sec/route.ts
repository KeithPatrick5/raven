import { NextResponse } from "next/server";
import { classifyPendingSecFilings } from "@/lib/classifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requestedLimit(url: string): number {
  const parsed = new URL(url);
  const raw = Number(parsed.searchParams.get("limit") || "1");
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(3, Math.floor(raw)));
}

async function runClassification(request: Request) {
  const startedAt = new Date().toISOString();
  const limit = requestedLimit(request.url);
  const result = await classifyPendingSecFilings(limit);

  return NextResponse.json({
    phase: "AI_SEC_CLASSIFIER",
    startedAt,
    finishedAt: new Date().toISOString(),
    limit,
    ...result
  });
}

export async function GET(request: Request) {
  try {
    return await runClassification(request);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        phase: "AI_SEC_CLASSIFIER",
        error: error instanceof Error ? error.message : "Unknown classifier failure"
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
