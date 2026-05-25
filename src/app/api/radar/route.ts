import { NextResponse } from "next/server";
import { getRadarSnapshot } from "@/lib/radar";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await getRadarSnapshot(20);
  return NextResponse.json(result);
}
