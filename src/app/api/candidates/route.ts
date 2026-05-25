import { NextResponse } from "next/server";
import { rankSignalCandidates } from "@/lib/candidateRanking";

export async function GET() {
  const result = await rankSignalCandidates(100);
  return NextResponse.json(result);
}
