import { NextResponse } from "next/server";
import { getTradingSafetyStatus } from "@/lib/tradingSafety";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getTradingSafetyStatus());
}
