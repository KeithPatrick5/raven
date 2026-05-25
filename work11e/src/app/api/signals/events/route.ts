import { NextResponse } from "next/server";
import { backfillSecSignalEvents, getLatestSignalEvents, getSignalSourceHealth } from "@/lib/signalEvents";

export const dynamic = "force-dynamic";

export async function GET() {
  const backfill = await backfillSecSignalEvents(50);
  const [events, sources] = await Promise.all([
    getLatestSignalEvents(25),
    getSignalSourceHealth()
  ]);

  return NextResponse.json({
    ok: true,
    phase: "SIGNAL_EVENT_FRAMEWORK",
    backfill,
    eventCount: events.length,
    sourceCount: sources.length,
    sources,
    events
  });
}
