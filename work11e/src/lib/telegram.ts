import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type SignalForTelegram = {
  id: number;
  ticker: string;
  accession_number: string;
  form: string;
  direction: string;
  category: string;
  risk_level: string;
  ai_tradeability: number;
  market_confirmation: string;
  final_score: number;
  action: string;
  readable_summary: string;
  reason_codes: string[];
  risk_flags: string[];
  created_at: string;
};

type TelegramSendResponse = {
  ok: boolean;
  result?: {
    message_id?: number;
    chat?: { id?: number | string };
    date?: number;
    text?: string;
  };
  description?: string;
};

export function hasTelegramConfig() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
}

function telegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  return token;
}

function telegramChatId() {
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not configured.");
  return chatId;
}

export async function sendTelegramMessage(message: string) {
  const response = await fetch(`https://api.telegram.org/bot${telegramToken()}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramChatId(),
      text: message.slice(0, 3900),
      disable_web_page_preview: true
    })
  });

  const payload = (await response.json()) as TelegramSendResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram send failed with HTTP ${response.status}.`);
  }

  return payload;
}

function actionLabel(action: string) {
  switch (action) {
    case "paper_trade_candidate":
      return "PAPER CANDIDATE";
    case "high_watch":
      return "HIGH WATCH";
    case "watch_only":
      return "WATCH ONLY";
    case "danger_watch":
      return "DANGER WATCH";
    case "avoid":
      return "AVOID";
    case "ignore":
      return "IGNORE";
    default:
      return action.toUpperCase();
  }
}

function formatSignal(signal: SignalForTelegram, index: number) {
  const reasons = Array.isArray(signal.reason_codes) ? signal.reason_codes.slice(0, 2) : [];
  const risks = Array.isArray(signal.risk_flags) ? signal.risk_flags.slice(0, 1) : [];

  return [
    `${index}. ${signal.ticker} | score ${signal.final_score}/100 | ${actionLabel(signal.action)}`,
    `Form: ${signal.form} | ${signal.category} | ${signal.direction} | ${signal.risk_level} risk`,
    `Market: ${signal.market_confirmation} | AI: ${signal.ai_tradeability}/100`,
    `Take: ${signal.readable_summary}`,
    reasons.length ? `Why: ${reasons.join(" ")}` : null,
    risks.length ? `Risk: ${risks.join(" ")}` : null
  ].filter(Boolean).join("\n");
}

function formatReport(signals: SignalForTelegram[]) {
  const header = [
    "RAVEN ALERTS",
    `Signals: ${signals.length}`,
    "Live trading: disabled",
    "AI is the analyst. Deterministic scoring decides eligibility.",
    ""
  ].join("\n");

  return header + signals.map((signal, index) => formatSignal(signal, index + 1)).join("\n\n");
}

async function getPendingTelegramSignals(limit: number, minScore: number, resend: boolean) {
  const sql = db();

  if (resend) {
    return sql<SignalForTelegram[]>`
      select
        id,
        ticker,
        accession_number,
        form,
        direction,
        category,
        risk_level,
        ai_tradeability,
        market_confirmation,
        final_score,
        action,
        readable_summary,
        reason_codes,
        risk_flags,
        created_at::text as created_at
      from scored_signals
      where final_score >= ${minScore}
      order by final_score desc, created_at desc
      limit ${limit}
    `;
  }

  return sql<SignalForTelegram[]>`
    select
      s.id,
      s.ticker,
      s.accession_number,
      s.form,
      s.direction,
      s.category,
      s.risk_level,
      s.ai_tradeability,
      s.market_confirmation,
      s.final_score,
      s.action,
      s.readable_summary,
      s.reason_codes,
      s.risk_flags,
      s.created_at::text as created_at
    from scored_signals s
    left join telegram_alerts a
      on a.scored_signal_id = s.id
      and a.alert_type = 'signal'
      and a.telegram_chat_id = ${telegramChatId()}
    where a.id is null
      and s.final_score >= ${minScore}
    order by s.final_score desc, s.created_at desc
    limit ${limit}
  `;
}

async function logTelegramSignals(signals: SignalForTelegram[], message: string, messageId: number | null) {
  const sql = db();
  const chatId = telegramChatId();

  for (const signal of signals) {
    await sql`
      insert into telegram_alerts (
        scored_signal_id,
        accession_number,
        ticker,
        alert_type,
        telegram_chat_id,
        message,
        telegram_message_id
      ) values (
        ${signal.id},
        ${signal.accession_number},
        ${signal.ticker},
        'signal',
        ${chatId},
        ${message},
        ${messageId}
      )
      on conflict (scored_signal_id, alert_type, telegram_chat_id) do nothing
    `;
  }
}

export async function sendTelegramSignalReport(options?: { limit?: number; minScore?: number; resend?: boolean }) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      telegram: hasTelegramConfig() ? "configured" as const : "not_configured" as const,
      sent: 0,
      skipped: 0,
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  if (!hasTelegramConfig()) {
    return {
      ok: false,
      database: "configured" as const,
      telegram: "not_configured" as const,
      sent: 0,
      skipped: 0,
      errors: [{ error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured." }]
    };
  }

  await ensureRavenTables();

  const limit = Math.max(1, Math.min(options?.limit ?? 5, 10));
  const minScore = Math.max(0, Math.min(options?.minScore ?? 0, 100));
  const resend = Boolean(options?.resend);
  const signals = await getPendingTelegramSignals(limit, minScore, resend);

  if (signals.length === 0) {
    return {
      ok: true,
      database: "configured" as const,
      telegram: "configured" as const,
      sent: 0,
      skipped: 0,
      message: "No scored signals are waiting for Telegram alerting.",
      signals: []
    };
  }

  const message = formatReport(signals);
  const telegramResponse = await sendTelegramMessage(message);
  const messageId = telegramResponse.result?.message_id ?? null;

  if (!resend) {
    await logTelegramSignals(signals, message, messageId);
  }

  return {
    ok: true,
    database: "configured" as const,
    telegram: "configured" as const,
    sent: signals.length,
    skipped: 0,
    telegramMessageId: messageId,
    signals: signals.map((signal) => ({
      ticker: signal.ticker,
      accessionNumber: signal.accession_number,
      finalScore: signal.final_score,
      action: signal.action,
      marketConfirmation: signal.market_confirmation
    }))
  };
}

export async function sendTelegramTestMessage() {
  if (!hasTelegramConfig()) {
    return {
      ok: false,
      telegram: "not_configured" as const,
      errors: [{ error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured." }]
    };
  }

  const message = [
    "RAVEN TEST",
    "Telegram route is online.",
    "Live trading: disabled.",
    "Signal spam: disabled.",
    "Next real alerts will be paper-trade executions only."
  ].join("\n");

  const telegramResponse = await sendTelegramMessage(message);

  return {
    ok: true,
    telegram: "configured" as const,
    sent: 1,
    telegramMessageId: telegramResponse.result?.message_id ?? null
  };
}
