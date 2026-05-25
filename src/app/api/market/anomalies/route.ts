import { NextResponse } from "next/server";
import { scanMarketAnomalies } from "@/lib/marketAnomalies";

export async function GET() {
  const result = await scanMarketAnomalies(35);
  return NextResponse.json(result);
}
