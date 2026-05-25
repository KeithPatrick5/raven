import { getPaperAccountSnapshot } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getPaperAccountSnapshot();
  return Response.json(snapshot);
}
