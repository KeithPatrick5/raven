import { getMarketAnomalyReport } from "@/lib/marketAnomalies";

export async function GET() {
  return new Response(await getMarketAnomalyReport(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
