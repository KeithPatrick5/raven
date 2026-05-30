import { NextResponse } from "next/server";
import { getPaperLedgerSnapshot } from "@/lib/paperLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ledger = await getPaperLedgerSnapshot();
    return NextResponse.json(ledger, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      database: "error",
      errors: [{ error: error instanceof Error ? error.message : "Unknown paper ledger route failure" }]
    }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
