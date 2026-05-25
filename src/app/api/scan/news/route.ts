import { NextResponse } from "next/server";
import { scanNewsSignals } from "@/lib/news";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await scanNewsSignals();
  return NextResponse.json(result, { status: result.ok || result.partial ? 200 : 500 });
}
