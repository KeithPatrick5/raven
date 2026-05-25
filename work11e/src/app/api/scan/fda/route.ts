import { NextResponse } from "next/server";
import { scanFdaSignals } from "@/lib/fda";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await scanFdaSignals();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
