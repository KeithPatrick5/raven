import { getAiUsageReport } from "@/lib/aiUsage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const window = url.searchParams.get("window") || "24h";
  const report = await getAiUsageReport(window);
  return new Response(report, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}
