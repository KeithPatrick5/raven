import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { upsertSignalEvent } from "@/lib/signalEvents";
import { watchlist } from "@/lib/watchlist";

type RawCongressTrade = Record<string, unknown>;

type CongressSignal = {
  ticker: string;
  sourceId: string;
  provider: string;
  politician: string | null;
  chamber: string | null;
  transactionType: string;
  amountRange: string | null;
  transactionDate: string | null;
  reportDate: string | null;
  reportingDelayDays: number | null;
  assetDescription: string | null;
  priority: "medium" | "low";
  materiality: "possibly_material" | "context";
  action: "watch_only";
  confidence: number;
  sourceUrl: string;
  raw: RawCongressTrade;
};

const FINNHUB_BASE = "https://finnhub.io/api/v1/stock/congressional-trading";
const FMP_BASE = "https://financialmodelingprep.com/stable";
type CongressProvider = "finnhub" | "fmp" | "not_configured";

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstString(row: RawCongressTrade, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(row[key]);
    if (value) return value;
  }
  return null;
}

function nameFromRow(row: RawCongressTrade, keys: string[]): string | null {
  const direct = firstString(row, keys);
  if (direct) return direct;

  const first = firstString(row, ["firstName", "first_name", "memberFirstName"]);
  const last = firstString(row, ["lastName", "last_name", "memberLastName"]);
  const full = [first, last].filter(Boolean).join(" ").trim();
  return full || null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function delayDays(transactionDate: string | null, reportDate: string | null): number | null {
  if (!transactionDate || !reportDate) return null;
  const tx = new Date(`${transactionDate}T00:00:00Z`).getTime();
  const report = new Date(`${reportDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(tx) || !Number.isFinite(report)) return null;
  return Math.max(0, Math.round((report - tx) / 86400000));
}

function normalizeTransactionType(value: string | null): string {
  const lower = (value || "unknown").toLowerCase();
  if (lower.includes("purchase") || lower === "p" || lower.includes("buy")) return "buy";
  if (lower.includes("sale") || lower === "s" || lower.includes("sell")) return "sell";
  if (lower.includes("exchange")) return "exchange";
  return lower.replace(/[^a-z0-9_ -]/g, "").trim() || "unknown";
}

function confidenceForTrade(input: { transactionType: string; delay: number | null; amountRange: string | null }) {
  let confidence = 45;
  if (input.transactionType === "buy") confidence += 12;
  if (input.transactionType === "sell") confidence += 4;
  if (input.transactionType === "exchange") confidence -= 2;

  const amount = (input.amountRange || "").toLowerCase();
  if (amount.includes("1,000,001") || amount.includes("5,000,000") || amount.includes("million")) confidence += 10;
  else if (amount.includes("250,001") || amount.includes("500,001")) confidence += 6;
  else if (amount.includes("50,001") || amount.includes("100,001")) confidence += 3;

  if (input.delay !== null) {
    if (input.delay <= 7) confidence += 6;
    else if (input.delay <= 21) confidence += 3;
    else if (input.delay > 45) confidence -= 12;
    else if (input.delay > 30) confidence -= 6;
  }

  return Math.max(15, Math.min(70, confidence));
}

function sourceIdFor(provider: string, ticker: string, row: RawCongressTrade, index: number) {
  const transactionDate = firstString(row, ["transactionDate", "transaction_date", "transactionDateRaw", "transaction_date_raw", "date"]);
  const reportDate = firstString(row, ["filingDate", "reportDate", "disclosureDate", "reportedDate", "filedDate", "report_date", "filing_date"]);
  const politician = nameFromRow(row, ["name", "representative", "senator", "member", "politician", "owner", "office"]);
  const txType = firstString(row, ["transaction", "transactionType", "type", "transaction_type"]);
  const amount = firstString(row, ["amount", "amountRange", "range", "value"]);
  const asset = firstString(row, ["assetDescription", "asset", "asset_description", "description", "security", "assetName", "asset_name"]);
  const fallback = JSON.stringify(row).slice(0, 180);
  return [provider, ticker, transactionDate, reportDate, politician, txType, amount, asset, index, fallback]
    .filter(Boolean)
    .join(":")
    .slice(0, 500);
}

async function fetchFinnhubTradesForSymbol(symbol: string, token: string) {
  const url = `${FINNHUB_BASE}?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Raven private market scanner" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Finnhub congressional trading returned ${response.status} for ${symbol}`);
  }

  const json = await response.json() as { data?: RawCongressTrade[] } | RawCongressTrade[];
  const data = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
  return { rows: data.slice(0, 25), url };
}


async function fetchFmpTradesForSymbol(symbol: string, token: string) {
  const endpoints = [
    { chamber: "House", url: `${FMP_BASE}/house-trades?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(token)}` },
    { chamber: "Senate", url: `${FMP_BASE}/senate-trades?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(token)}` }
  ];

  const results: { rows: RawCongressTrade[]; url: string; chamber: string }[] = [];

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint.url, {
      headers: { "User-Agent": "Raven private market scanner" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`FMP ${endpoint.chamber.toLowerCase()} trades returned ${response.status} for ${symbol}`);
    }

    const json = await response.json() as RawCongressTrade[] | { data?: RawCongressTrade[]; error?: unknown; message?: unknown };
    const rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];

    results.push({ rows: rows.slice(0, 50), url: endpoint.url.replace(token, "REDACTED"), chamber: endpoint.chamber });
  }

  return results;
}

function normalizeFinnhubRow(symbol: string, row: RawCongressTrade, index: number, sourceUrl: string): CongressSignal {
  const transactionDate = normalizeDate(firstString(row, ["transactionDate", "transaction_date", "transactionDateRaw"]));
  const reportDate = normalizeDate(firstString(row, ["filingDate", "reportDate", "disclosureDate", "filedDate", "filing_date"]));
  const transactionType = normalizeTransactionType(firstString(row, ["transaction", "transactionType", "type", "transaction_type"]));
  const amountRange = firstString(row, ["amount", "amountRange", "range", "value"]);
  const reportingDelayDays = delayDays(transactionDate, reportDate);
  const confidence = confidenceForTrade({ transactionType, delay: reportingDelayDays, amountRange });

  return {
    ticker: symbol,
    sourceId: sourceIdFor("finnhub", symbol, row, index),
    provider: "finnhub",
    politician: nameFromRow(row, ["name", "representative", "senator", "member", "politician", "owner"]),
    chamber: firstString(row, ["chamber", "office", "branch"]),
    transactionType,
    amountRange,
    transactionDate,
    reportDate,
    reportingDelayDays,
    assetDescription: firstString(row, ["assetDescription", "asset", "asset_description", "description", "security"]),
    priority: confidence >= 58 ? "medium" : "low",
    materiality: confidence >= 58 ? "possibly_material" : "context",
    action: "watch_only",
    confidence,
    sourceUrl,
    raw: row
  };
}

function normalizeFmpRow(symbol: string, row: RawCongressTrade, index: number, sourceUrl: string, chamber: string): CongressSignal {
  const transactionDate = normalizeDate(firstString(row, ["transactionDate", "transaction_date", "date"]));
  const reportDate = normalizeDate(firstString(row, ["disclosureDate", "filingDate", "reportedDate", "reportDate", "filedDate", "filing_date"]));
  const transactionType = normalizeTransactionType(firstString(row, ["transactionType", "transaction", "type", "transaction_type"]));
  const amountRange = firstString(row, ["amount", "amountRange", "range", "value"]);
  const reportingDelayDays = delayDays(transactionDate, reportDate);
  const confidence = confidenceForTrade({ transactionType, delay: reportingDelayDays, amountRange });

  return {
    ticker: symbol,
    sourceId: sourceIdFor(`fmp_${chamber.toLowerCase()}`, symbol, row, index),
    provider: "fmp",
    politician: nameFromRow(row, ["representative", "senator", "name", "member", "politician", "owner", "office"]),
    chamber,
    transactionType,
    amountRange,
    transactionDate,
    reportDate,
    reportingDelayDays,
    assetDescription: firstString(row, ["assetDescription", "asset", "asset_description", "description", "security", "assetName", "asset_name"]),
    priority: confidence >= 58 ? "medium" : "low",
    materiality: confidence >= 58 ? "possibly_material" : "context",
    action: "watch_only",
    confidence,
    sourceUrl,
    raw: row
  };
}

async function saveCongressSignals(signals: CongressSignal[]) {
  if (!hasDatabase()) {
    return { saved: 0, skipped: signals.length, database: "not_configured" as const, errors: [] as string[] };
  }

  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const signal of signals) {
    try {
      const rows = await sql<{ inserted: boolean }[]>`
        insert into raw_congress_trades (
          source_id,
          provider,
          ticker,
          politician,
          chamber,
          transaction_type,
          amount_range,
          transaction_date,
          report_date,
          reporting_delay_days,
          asset_description,
          source_url,
          raw_payload
        ) values (
          ${signal.sourceId},
          ${signal.provider},
          ${signal.ticker},
          ${signal.politician},
          ${signal.chamber},
          ${signal.transactionType},
          ${signal.amountRange},
          ${signal.transactionDate},
          ${signal.reportDate},
          ${signal.reportingDelayDays},
          ${signal.assetDescription},
          ${signal.sourceUrl},
          ${JSON.stringify(signal.raw)}::jsonb
        )
        on conflict (source_id) do update set
          provider = excluded.provider,
          ticker = excluded.ticker,
          politician = excluded.politician,
          chamber = excluded.chamber,
          transaction_type = excluded.transaction_type,
          amount_range = excluded.amount_range,
          transaction_date = excluded.transaction_date,
          report_date = excluded.report_date,
          reporting_delay_days = excluded.reporting_delay_days,
          asset_description = excluded.asset_description,
          source_url = excluded.source_url,
          raw_payload = excluded.raw_payload,
          updated_at = now()
        returning (xmax = 0) as inserted
      `;

      if (rows[0]?.inserted) saved += 1;
      else skipped += 1;
    } catch (error) {
      errors.push(`${signal.ticker}: ${error instanceof Error ? error.message : "unknown congress storage error"}`);
    }
  }

  return { saved, skipped, database: "configured" as const, errors };
}

async function upsertCongressEvents(signals: CongressSignal[]) {
  let count = 0;

  for (const signal of signals) {
    const direction = signal.transactionType === "buy" ? "bullish" : signal.transactionType === "sell" ? "bearish" : "neutral";
    const delayText = signal.reportingDelayDays === null ? "unknown reporting delay" : `${signal.reportingDelayDays} day reporting delay`;
    const memberText = signal.politician ? `${signal.politician} disclosed` : "Congressional disclosure reported";
    const amountText = signal.amountRange ? ` Amount: ${signal.amountRange}.` : "";
    const assetText = signal.assetDescription ? ` Asset: ${signal.assetDescription}.` : "";

    const row = await upsertSignalEvent({
      source: "CONGRESS",
      sourceEventId: signal.sourceId,
      ticker: signal.ticker,
      eventType: `congress_${signal.transactionType}`,
      eventTime: signal.transactionDate || signal.reportDate || null,
      headline: `${signal.ticker} Congress ${signal.transactionType}`,
      summary: `${memberText} a ${signal.transactionType} in ${signal.ticker}. ${delayText}.${amountText}${assetText} Raven treats congressional disclosures as delayed context only unless other signals confirm.`,
      sourceUrl: signal.sourceUrl,
      priority: signal.priority,
      materiality: signal.materiality,
      direction,
      confidence: signal.confidence,
      status: "watch",
      action: signal.action,
      metadata: {
        provider: signal.provider,
        politician: signal.politician,
        chamber: signal.chamber,
        transactionType: signal.transactionType,
        amountRange: signal.amountRange,
        transactionDate: signal.transactionDate,
        reportDate: signal.reportDate,
        reportingDelayDays: signal.reportingDelayDays,
        assetDescription: signal.assetDescription,
        note: "Congressional trades are delayed disclosure/context signals. They should not trigger a trade by themselves."
      }
    });
    if (row) count += 1;
  }

  return count;
}

export async function scanCongressSignals() {
  const startedAt = new Date().toISOString();
  const preferred = (process.env.CONGRESS_PROVIDER || "").trim().toLowerCase();
  const fmpToken = process.env.FMP_API_KEY?.trim();
  const finnhubToken = process.env.FINNHUB_API_KEY?.trim();
  const provider: CongressProvider = preferred === "fmp"
    ? fmpToken ? "fmp" : "not_configured"
    : preferred === "finnhub"
      ? finnhubToken ? "finnhub" : "not_configured"
      : fmpToken
        ? "fmp"
        : finnhubToken
          ? "finnhub"
          : "not_configured";

  const errors: { ticker?: string; provider?: string; error: string }[] = [];
  const signals: CongressSignal[] = [];

  if (provider === "not_configured") {
    return {
      phase: "CONGRESS_SCANNER",
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      provider,
      configured: false,
      watchlistCount: watchlist.length,
      rawTradeCount: 0,
      signalCount: 0,
      storage: { saved: 0, skipped: 0, database: hasDatabase() ? "configured" : "not_configured", errors: [] },
      eventsCreatedOrUpdated: 0,
      signals: [],
      setupRequired: "Add FMP_API_KEY with CONGRESS_PROVIDER=fmp, or add FINNHUB_API_KEY with CONGRESS_PROVIDER=finnhub.",
      errors: []
    };
  }

  if (provider === "fmp") {
    const token = fmpToken as string;
    for (const item of watchlist) {
      try {
        const batches = await fetchFmpTradesForSymbol(item.symbol, token);
        batches.forEach((batch, batchIndex) => {
          batch.rows.forEach((row, index) => {
            signals.push(normalizeFmpRow(item.symbol, row, batchIndex * 1000 + index, batch.url, batch.chamber));
          });
        });
      } catch (error) {
        errors.push({ ticker: item.symbol, provider, error: error instanceof Error ? error.message : "unknown FMP congress fetch error" });
      }
    }
  }

  if (provider === "finnhub") {
    const token = finnhubToken as string;
    for (const item of watchlist) {
      try {
        const { rows, url } = await fetchFinnhubTradesForSymbol(item.symbol, token);
        rows.forEach((row, index) => {
          signals.push(normalizeFinnhubRow(item.symbol, row, index, url));
        });
      } catch (error) {
        errors.push({ ticker: item.symbol, provider, error: error instanceof Error ? error.message : "unknown Finnhub congress fetch error" });
      }
    }
  }

  const filteredSignals = signals
    .filter((signal) => signal.transactionType === "buy" || signal.transactionType === "sell")
    .filter((signal) => signal.reportingDelayDays === null || signal.reportingDelayDays <= 180)
    .slice(0, 75);

  const storage = await saveCongressSignals(filteredSignals);
  const eventsCreatedOrUpdated = await upsertCongressEvents(filteredSignals);
  const ok = errors.length === 0 || filteredSignals.length > 0;

  return {
    phase: "CONGRESS_SCANNER",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok,
    partial: errors.length > 0,
    provider,
    configured: true,
    watchlistCount: watchlist.length,
    rawTradeCount: signals.length,
    signalCount: filteredSignals.length,
    storage,
    eventsCreatedOrUpdated,
    signals: filteredSignals.slice(0, 15).map((signal) => ({
      ticker: signal.ticker,
      provider: signal.provider,
      chamber: signal.chamber,
      politician: signal.politician,
      transactionType: signal.transactionType,
      amountRange: signal.amountRange,
      transactionDate: signal.transactionDate,
      reportDate: signal.reportDate,
      reportingDelayDays: signal.reportingDelayDays,
      priority: signal.priority,
      materiality: signal.materiality,
      action: signal.action,
      confidence: signal.confidence
    })),
    errors
  };
}
