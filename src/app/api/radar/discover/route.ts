import { NextResponse } from "next/server";
import { scanSecDiscoveryRadar } from "@/lib/secDiscovery";
import { syncRadarFromSignalEvents } from "@/lib/radar";

export const dynamic = "force-dynamic";

export async function GET() {
  const discovery = await scanSecDiscoveryRadar();
  const radarSync = await syncRadarFromSignalEvents();

  return NextResponse.json({
    ok: discovery.ok && radarSync.ok,
    phase: "RADAR_DISCOVERY",
    discovery,
    radarSync
  });
}
