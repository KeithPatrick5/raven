import { getAiRouterReport } from "@/lib/aiRouter";

export async function GET() {
  return new Response(await getAiRouterReport(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
