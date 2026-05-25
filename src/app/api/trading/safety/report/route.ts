import { getTradingSafetyTextReport } from "@/lib/tradingSafety";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(getTradingSafetyTextReport(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
