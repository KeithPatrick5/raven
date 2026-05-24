import { NextRequest, NextResponse } from "next/server";
import { sendTelegramTestMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const mode = request.nextUrl.searchParams.get("mode") || "test";

  try {
    if (mode !== "test" && mode !== "status") {
      return NextResponse.json({
        phase: "TELEGRAM_TEST_ONLY",
        startedAt,
        finishedAt: new Date().toISOString(),
        mode,
        ok: false,
        sent: 0,
        message: "Telegram signal spam is intentionally disabled. Raven will only send Telegram trade alerts after the paper-trade engine exists.",
        allowedModes: ["test", "status"]
      }, { status: 400 });
    }

    const result = await sendTelegramTestMessage();

    return NextResponse.json({
      phase: "TELEGRAM_TEST_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      mode,
      ...result
    });
  } catch (error) {
    return NextResponse.json({
      phase: "TELEGRAM_TEST_ONLY",
      startedAt,
      finishedAt: new Date().toISOString(),
      mode,
      ok: false,
      sent: 0,
      errors: [{ error: error instanceof Error ? error.message : "Unknown Telegram test failure" }]
    }, { status: 500 });
  }
}
