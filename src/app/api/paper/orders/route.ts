import { getAlpacaOrders, hasAlpacaProvider } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") || "open";
  const status = statusParam === "closed" || statusParam === "all" ? statusParam : "open";
  const limit = Number(url.searchParams.get("limit") || "25");

  if (!hasAlpacaProvider()) {
    return Response.json({ ok: false, mode: "paper", status, orders: [], errors: [{ error: "Alpaca paper credentials are not configured." }] }, { status: 200 });
  }

  try {
    const orders = await getAlpacaOrders("paper", status, limit);
    return Response.json({ ok: true, mode: "paper", status, orders });
  } catch (error) {
    return Response.json({ ok: false, mode: "paper", status, orders: [], errors: [{ error: error instanceof Error ? error.message : "Unknown Alpaca orders failure" }] }, { status: 200 });
  }
}
