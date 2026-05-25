import { getCandidateRankingReport } from "@/lib/candidateRanking";

export async function GET() {
  return new Response(await getCandidateRankingReport(12), {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
