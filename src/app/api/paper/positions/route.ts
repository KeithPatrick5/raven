import { getAlpacaPositions, hasAlpacaProvider } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasAlpacaProvider()) {
    return Response.json({ ok: false, mode: "paper", positions: [], errors: [{ error: "Alpaca paper credentials are not configured." }] }, { status: 200 });
  }

  try {
    const positions = await getAlpacaPositions("paper");
    return Response.json({ ok: true, mode: "paper", positions });
  } catch (error) {
    return Response.json({ ok: false, mode: "paper", positions: [], errors: [{ error: error instanceof Error ? error.message : "Unknown Alpaca positions failure" }] }, { status: 200 });
  }
}
