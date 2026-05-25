import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { upsertSignalEvent } from "@/lib/signalEvents";
import { watchlist } from "@/lib/watchlist";

type FinraShortVolumeRow = {
  date: string;
  symbol: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  market: string | null;
  sourceUrl: string;
};

type FinraSignal = FinraShortVolumeRow & {
  shortRatio: number;
  priority: "high" | "medium" | "low";
  confidence: number;
  action: "watch_only" | "ignore";
  status: "watch" | "ignored";
  summary: string;
};

const FINRA_BASE = "https://cdn.finra.org/equity/regsho/daily";

function yyyymmdd(date: Date) {
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("");
}

function isoDateFromCompact(value: string) {
  if (!/^\d{8}$/.test(value)) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function previousCalendarDates(days = 10) {
  const dates: Date[] = [];
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);

  for (let offset = 1; dates.length < days && offset <= 20; offset += 1) {
    const d = new Date(cursor);
    d.setUTCDate(cursor.getUTCDate() - offset);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d);
  }

  return dates;
}

function feedUrls(date: Date) {
  const compact = yyyymmdd(date);
  return [
    `${FINRA_BASE}/CNMSshvol${compact}.txt`,
    `${FINRA_BASE}/FNSQshvol${compact}.txt`,
    `${FINRA_BASE}/FNYXshvol${compact}.txt`
  ];
}

function parseNumber(value: string | undefined) {
  const parsed = Number(value || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFinraText(text: string, sourceUrl: string, watchSymbols: Set<string>) {
  const rows: FinraShortVolumeRow[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (line.toLowerCase().startsWith("date|symbol|")) continue;
    const [date, symbol, shortVolume, shortExemptVolume, totalVolume, market] = line.split("|");
    const normalizedSymbol = (symbol || "").toUpperCase().trim();
    if (!watchSymbols.has(normalizedSymbol)) continue;

    const total = parseNumber(totalVolume);
    if (total <= 0) continue;

    rows.push({
      date: isoDateFromCompact(date || ""),
      symbol: normalizedSymbol,
      shortVolume: parseNumber(shortVolume),
      shortExemptVolume: parseNumber(shortExemptVolume),
      totalVolume: total,
      market: market || null,
      sourceUrl
    });
  }

  return rows;
}

function scoreFinraRow(row: FinraShortVolumeRow): FinraSignal {
  const shortRatio = row.totalVolume > 0 ? row.shortVolume / row.totalVolume : 0;
  let confidence = Math.round(shortRatio * 100);
  let priority: FinraSignal["priority"] = "low";
  let action: FinraSignal["action"] = "ignore";
  let status: FinraSignal["status"] = "ignored";

  if (shortRatio >= 0.65 && row.totalVolume >= 100000) {
    priority = "high";
    confidence += 10;
    action = "watch_only";
    status = "watch";
  } else if (shortRatio >= 0.5 && row.totalVolume >= 50000) {
    priority = "medium";
    confidence += 5;
    action = "watch_only";
    status = "watch";
  }

  confidence = Math.max(0, Math.min(100, confidence));
  const percent = (shortRatio * 100).toFixed(1);
  const summary = `${row.symbol} short-sale volume was ${percent}% of reported volume on ${row.date}. Raven treats this as pressure context, not a standalone trade trigger.`;

  return {
    ...row,
    shortRatio,
    priority,
    confidence,
    action,
    status,
    summary
  };
}

export async function fetchLatestFinraShortVolume() {
  const watchSymbols = new Set(watchlist.map((item) => item.symbol.toUpperCase()));
  const errors: Array<{ url?: string; error: string }> = [];

  for (const date of previousCalendarDates(8)) {
    const rows: FinraShortVolumeRow[] = [];

    for (const url of feedUrls(date)) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          errors.push({ url, error: `FINRA feed returned ${response.status}` });
          continue;
        }
        const text = await response.text();
        rows.push(...parseFinraText(text, url, watchSymbols));
      } catch (error) {
        errors.push({ url, error: error instanceof Error ? error.message : "Unknown FINRA fetch failure" });
      }
    }

    if (rows.length > 0) {
      const deduped = new Map<string, FinraShortVolumeRow>();
      for (const row of rows) {
        const key = `${row.date}:${row.symbol}`;
        const existing = deduped.get(key);
        if (!existing || row.totalVolume > existing.totalVolume) deduped.set(key, row);
      }
      return { ok: true, date: isoDateFromCompact(yyyymmdd(date)), rows: [...deduped.values()], errors };
    }
  }

  return { ok: true, date: null, rows: [] as FinraShortVolumeRow[], errors };
}

async function saveRawFinraRows(rows: FinraShortVolumeRow[]) {
  if (!hasDatabase()) return { saved: 0, skipped: rows.length, database: "not_configured" as const };

  await ensureRavenTables();
  const sql = db();
  let saved = 0;

  for (const row of rows) {
    const result = await sql<Array<{ inserted: boolean }>>`
      insert into raw_finra_short_volume (
        trade_date,
        symbol,
        short_volume,
        short_exempt_volume,
        total_volume,
        market,
        source_url,
        raw_payload
      ) values (
        ${row.date},
        ${row.symbol},
        ${row.shortVolume},
        ${row.shortExemptVolume},
        ${row.totalVolume},
        ${row.market},
        ${row.sourceUrl},
        ${JSON.stringify(row)}::jsonb
      )
      on conflict (trade_date, symbol, market) do update set
        short_volume = excluded.short_volume,
        short_exempt_volume = excluded.short_exempt_volume,
        total_volume = excluded.total_volume,
        source_url = excluded.source_url,
        raw_payload = excluded.raw_payload,
        updated_at = now()
      returning (xmax = 0) as inserted
    `;
    if (result[0]?.inserted) saved += 1;
  }

  return { saved, skipped: rows.length - saved, database: "configured" as const };
}

export async function scanFinraShortVolume() {
  const fetched = await fetchLatestFinraShortVolume();
  const storage = await saveRawFinraRows(fetched.rows);
  const signals = fetched.rows.map(scoreFinraRow);
  let eventsCreatedOrUpdated = 0;
  const eventErrors: Array<{ symbol: string; error: string }> = [];

  for (const signal of signals) {
    try {
      await upsertSignalEvent({
        source: "FINRA",
        sourceEventId: `${signal.date}:${signal.symbol}:short-volume`,
        ticker: signal.symbol,
        eventType: "short_volume",
        eventTime: signal.date,
        headline: `${signal.symbol} short pressure ${Math.round(signal.shortRatio * 100)}%`,
        summary: signal.summary,
        sourceUrl: signal.sourceUrl,
        priority: signal.priority,
        materiality: signal.priority === "high" ? "possibly_material" : "routine",
        direction: "neutral",
        confidence: signal.confidence,
        status: signal.status,
        action: signal.action,
        metadata: {
          shortVolume: signal.shortVolume,
          shortExemptVolume: signal.shortExemptVolume,
          totalVolume: signal.totalVolume,
          shortRatio: Number(signal.shortRatio.toFixed(4)),
          market: signal.market,
          note: "FINRA daily short-sale volume is not short interest. Raven uses it as pressure context."
        }
      });
      eventsCreatedOrUpdated += 1;
    } catch (error) {
      eventErrors.push({ symbol: signal.symbol, error: error instanceof Error ? error.message : "Unknown FINRA signal event failure" });
    }
  }

  return {
    ok: fetched.errors.length === 0 || fetched.rows.length > 0,
    date: fetched.date,
    watchlistCount: watchlist.length,
    rowCount: fetched.rows.length,
    signalCount: signals.length,
    storage,
    eventsCreatedOrUpdated,
    signals: signals.map((signal) => ({
      ticker: signal.symbol,
      date: signal.date,
      shortVolume: signal.shortVolume,
      totalVolume: signal.totalVolume,
      shortRatioPercent: Number((signal.shortRatio * 100).toFixed(1)),
      priority: signal.priority,
      action: signal.action,
      confidence: signal.confidence
    })),
    errors: [...fetched.errors.slice(0, 12), ...eventErrors]
  };
}
