import { NextResponse } from "next/server";
import { scanSecDiscoveryRadar } from "@/lib/secDiscovery";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await scanSecDiscoveryRadar();
  return NextResponse.json(result);
}
