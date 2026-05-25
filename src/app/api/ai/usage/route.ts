import { getAiUsageSnapshot } from "@/lib/aiUsage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const window = url.searchParams.get("window") || "24h";
  const payload = await getAiUsageSnapshot(window);
  return Response.json(payload);
}
