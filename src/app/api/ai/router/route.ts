import { NextResponse } from "next/server";
import { routeBestCandidatesToAi } from "@/lib/aiRouter";

export async function GET() {
  const result = await routeBestCandidatesToAi(1);
  return NextResponse.json(result);
}
