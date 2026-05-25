import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { analyzeFilingPriority } from "@/lib/filingIntelligence";
import { getTickerMap } from "@/lib/sec";
import { upsertSignalEvent } from "@/lib/signalEvents";
import { watchlist } from "@/lib/watchlist";

const SEC_CURRENT_URL = "https://www.sec.gov/cgi-bin/browse-edgar";

const DISCOVERY_FORMS = ["8-K", "S-3", "S-1", "424B5", "SC 13D", "SC 13G", "NT 10-Q", "NT 10-K"];
const CORE_TICKERS = new Set(watchlist.map((item) => item.symbol));

type AtomEntry = {
  form: string;
  title: string;
  companyName: string;
  cik: string | null;
  accessionNumber: string | null;
  filingUrl: string | null;
  filedAt: string | null;
  summary: string;
};

type DiscoverySignal = {
  ticker: string;
  form: string;
  accessionNumber: string;
  filingDate: string | null;
  companyName: string;
  cik: string;
  priority: string;
  priorityScore: number;
  materiality: string;
  formFamily: string;
  action: string;
  direction: string;
  confidence: number;
  headline: string;
  summary: string;
  sourceUrl: string | null;
};

function secHeaders(): HeadersInit {
  return {
    "User-Agent": process.env.SEC_USER_AGENT?.trim() || "RavenPrivateScanner/0.2 contact@example.com",
    "Accept-Encoding": "gzip, deflate",
    "Accept": "application/atom+xml, application/xml, text/xml, */*"
  };
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

function tag(entry: string, name: string) {
  const match = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(stripTags(match[1])) : null;
}

function linkHref(entry: string) {
  const match = entry.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return match ? decodeXml(match[1]) : null;
}

function extractCik(value: string) {
  const archive = value.match(/\/Archives\/edgar\/data\/(\d+)\//i);
  if (archive) return archive[1];
  const cik = value.match(/CIK=(\d+)/i) || value.match(/CIK\s*:?\s*(\d{5,10})/i);
  return cik ? cik[1] : null;
}

function extractAccession(value: string) {
  const dashed = value.match(/(\d{10}-\d{2}-\d{6})/);
  if (dashed) return dashed[1];
  const compact = value.match(/\/(\d{18})\//);
  if (!compact) return null;
  const raw = compact[1];
  return `${raw.slice(0, 10)}-${raw.slice(10, 12)}-${raw.slice(12)}`;
}

function cleanCompanyName(title: string, form: string) {
  let value = title.replace(new RegExp(`^${form}\\s*[-:]*\\s*`, "i"), "").trim();
  value = value.replace(/\s*\(.*?\)\s*$/, "").trim();
  return value || title;
}

function normalizeDiscoveryForm(form: string) {
  return form.trim().toUpperCase();
}

type DiscoveryInterpretation = {
  action: string;
  direction: string;
  confidence: number;
  headlineLabel: string;
  summaryLabel: string;
};

function interpretDiscoveryForm(form: string, priorityScore: number, core: boolean): DiscoveryInterpretation {
  const normalized = normalizeDiscoveryForm(form);
  const coreBoost = core ? 0 : 2;

  if (normalized === "424B5") {
    return {
      action: "dilution_watch",
      direction: "bearish",
      confidence: Math.min(92, 88 + coreBoost),
      headlineLabel: "offering / dilution watch",
      summaryLabel: "424B5 prospectus supplement. Raven treats this as possible offering, dilution, or financing risk until market reaction confirms otherwise."
    };
  }

  if (normalized === "S-3") {
    return {
      action: "shelf_watch",
      direction: "bearish",
      confidence: Math.min(86, 82 + coreBoost),
      headlineLabel: "shelf registration watch",
      summaryLabel: "S-3 registration or shelf filing. Raven treats this as possible future issuance or dilution risk."
    };
  }

  if (normalized === "S-1") {
    return {
      action: "registration_watch",
      direction: "neutral",
      confidence: Math.min(84, 80 + coreBoost),
      headlineLabel: "registration watch",
      summaryLabel: "S-1 registration filing. Raven treats this as a speculative registration event that needs price, volume, and company-quality confirmation."
    };
  }

  if (normalized.includes("13D")) {
    return {
      action: "activist_watch",
      direction: "bullish",
      confidence: Math.min(88, 84 + coreBoost),
      headlineLabel: "activist / ownership watch",
      summaryLabel: "Schedule 13D ownership filing. Raven treats this as a possible activist or strategic ownership signal, not an automatic trade."
    };
  }

  if (normalized.includes("13G")) {
    return {
      action: "ownership_watch",
      direction: "neutral",
      confidence: Math.min(74, 70 + coreBoost),
      headlineLabel: "passive ownership watch",
      summaryLabel: "Schedule 13G ownership filing. Raven treats this as passive ownership context unless other catalysts line up."
    };
  }

  if (normalized === "NT 10-Q" || normalized === "NT 10-K") {
    return {
      action: "late_filing_risk",
      direction: "bearish",
      confidence: Math.min(90, 86 + coreBoost),
      headlineLabel: "late filing risk",
      summaryLabel: "Late filing notice. Raven treats this as accounting, reporting, or operational risk until clarified."
    };
  }

  if (normalized === "8-K") {
    return {
      action: priorityScore >= 80 ? "material_event_watch" : "watch_only",
      direction: "neutral",
      confidence: Math.min(84, Math.max(70, priorityScore + coreBoost)),
      headlineLabel: "material event watch",
      summaryLabel: "8-K material event filing. Raven treats this as a catalyst candidate that needs classification and price/volume confirmation."
    };
  }

  return {
    action: priorityScore >= 70 ? "watch_only" : "ignore",
    direction: "neutral",
    confidence: Math.max(0, Math.min(100, Math.round(priorityScore + coreBoost))),
    headlineLabel: "SEC discovery watch",
    summaryLabel: "SEC discovery filing. Raven added it to radar for short-term monitoring."
  };
}

function parseAtom(xml: string, form: string): AtomEntry[] {
  const entries = Array.from(xml.matchAll(/<entry[\s\S]*?<\/entry>/gi)).map((match) => match[0]);

  return entries.map((entry) => {
    const title = tag(entry, "title") || `${form} filing`;
    const summary = tag(entry, "summary") || title;
    const updated = tag(entry, "updated") || tag(entry, "filing-date");
    const href = linkHref(entry);
    const combined = `${entry} ${title} ${summary} ${href || ""}`;
    return {
      form,
      title,
      companyName: cleanCompanyName(title, form),
      cik: extractCik(combined),
      accessionNumber: extractAccession(combined),
      filingUrl: href,
      filedAt: updated,
      summary
    };
  });
}

async function fetchCurrentFilings(form: string, count = 40) {
  const url = `${SEC_CURRENT_URL}?action=getcurrent&type=${encodeURIComponent(form)}&owner=exclude&count=${count}&output=atom`;
  const response = await fetch(url, { headers: secHeaders(), cache: "no-store" });
  if (!response.ok) throw new Error(`SEC current filings returned ${response.status} for ${form}`);
  const xml = await response.text();
  return parseAtom(xml, form);
}

async function saveRawDiscoverySignals(signals: DiscoverySignal[]) {
  if (!hasDatabase()) return { saved: 0, skipped: signals.length, database: "not_configured" as const, errors: [] as Array<{ ticker?: string; error: string }> };

  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  let skipped = 0;
  const errors: Array<{ ticker?: string; error: string }> = [];

  for (const signal of signals) {
    try {
      const inserted = await sql<Array<{ inserted: boolean }>>`
        insert into raw_sec_discovery_filings (
          source_id,
          ticker,
          cik,
          company_name,
          form,
          accession_number,
          filing_date,
          filing_url,
          priority,
          priority_score,
          materiality,
          form_family,
          raw_payload
        ) values (
          ${signal.accessionNumber},
          ${signal.ticker},
          ${signal.cik},
          ${signal.companyName},
          ${signal.form},
          ${signal.accessionNumber},
          ${signal.filingDate},
          ${signal.sourceUrl},
          ${signal.priority},
          ${signal.priorityScore},
          ${signal.materiality},
          ${signal.formFamily},
          ${JSON.stringify(signal)}::jsonb
        )
        on conflict (source_id) do update set
          ticker = excluded.ticker,
          filing_url = excluded.filing_url,
          priority = excluded.priority,
          priority_score = excluded.priority_score,
          materiality = excluded.materiality,
          form_family = excluded.form_family,
          raw_payload = excluded.raw_payload,
          updated_at = now()
        returning (xmax = 0) as inserted
      `;
      if (inserted[0]?.inserted) saved += 1;
      else skipped += 1;
    } catch (error) {
      errors.push({ ticker: signal.ticker, error: error instanceof Error ? error.message : "Unknown SEC discovery storage error" });
    }
  }

  return { saved, skipped, database: "configured" as const, errors };
}

export async function scanSecDiscoveryRadar() {
  const startedAt = new Date().toISOString();
  const errors: Array<{ form?: string; ticker?: string; error: string }> = [];
  const rawEntries: AtomEntry[] = [];
  const signals: DiscoverySignal[] = [];

  const tickerMap = await getTickerMap();
  const tickerByCik = new Map<string, { ticker: string; title: string }>();
  for (const item of tickerMap.values()) {
    tickerByCik.set(String(item.cik_str), { ticker: item.ticker.toUpperCase(), title: item.title });
  }

  for (const form of DISCOVERY_FORMS) {
    try {
      const entries = await fetchCurrentFilings(form, 40);
      rawEntries.push(...entries);
    } catch (error) {
      errors.push({ form, error: error instanceof Error ? error.message : "Unknown SEC discovery fetch error" });
    }
  }

  const seen = new Set<string>();

  for (const entry of rawEntries) {
    if (!entry.cik || !entry.accessionNumber) continue;
    const match = tickerByCik.get(String(Number(entry.cik)));
    if (!match) continue;
    const ticker = match.ticker;
    const key = `${ticker}:${entry.accessionNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const priority = analyzeFilingPriority({ form: entry.form });
    if (priority.priorityScore < 70) continue;

    const interpretation = interpretDiscoveryForm(entry.form, priority.priorityScore, CORE_TICKERS.has(ticker));
    const headline = `${ticker} SEC discovery: ${interpretation.headlineLabel}`;
    const summary = `${interpretation.summaryLabel} Filing: ${entry.form}. Company: ${match.title || entry.companyName}.`;
    signals.push({
      ticker,
      form: entry.form,
      accessionNumber: entry.accessionNumber,
      filingDate: entry.filedAt ? entry.filedAt.slice(0, 10) : null,
      companyName: match.title || entry.companyName,
      cik: String(Number(entry.cik)),
      priority: priority.priority,
      priorityScore: priority.priorityScore,
      materiality: priority.materiality,
      formFamily: priority.formFamily,
      action: interpretation.action,
      direction: interpretation.direction,
      confidence: interpretation.confidence,
      headline,
      summary,
      sourceUrl: entry.filingUrl
    });
  }

  signals.sort((a, b) => b.confidence - a.confidence || String(b.filingDate || "").localeCompare(String(a.filingDate || "")));
  const limitedSignals = signals.slice(0, 30);
  const storage = await saveRawDiscoverySignals(limitedSignals);

  let eventsCreatedOrUpdated = 0;
  for (const signal of limitedSignals) {
    try {
      await upsertSignalEvent({
        source: "SEC_DISCOVERY",
        sourceEventId: signal.accessionNumber,
        ticker: signal.ticker,
        eventType: signal.form,
        eventTime: signal.filingDate,
        headline: signal.headline,
        summary: signal.summary,
        sourceUrl: signal.sourceUrl,
        priority: signal.priority,
        materiality: signal.materiality,
        direction: signal.direction,
        confidence: signal.confidence,
        status: "watch",
        action: signal.action,
        metadata: {
          accessionNumber: signal.accessionNumber,
          companyName: signal.companyName,
          formFamily: signal.formFamily,
          priorityScore: signal.priorityScore,
          coreWatchlist: CORE_TICKERS.has(signal.ticker),
          note: "SEC discovery adds non-core tickers to radar. Offering and late-filing events are risk/dilution watches, not bullish trade calls."
        }
      });
      eventsCreatedOrUpdated += 1;
    } catch (error) {
      errors.push({ ticker: signal.ticker, error: error instanceof Error ? error.message : "Unknown SEC discovery signal event error" });
    }
  }

  const discoveredTickers = Array.from(new Set(limitedSignals.map((signal) => signal.ticker).filter((ticker) => !CORE_TICKERS.has(ticker))));

  return {
    phase: "SEC_DISCOVERY_RADAR",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: errors.length === 0,
    forms: DISCOVERY_FORMS,
    rawEntryCount: rawEntries.length,
    mappedSignalCount: limitedSignals.length,
    discoveredTickerCount: discoveredTickers.length,
    discoveredTickers: discoveredTickers.slice(0, 20),
    storage,
    eventsCreatedOrUpdated,
    signals: limitedSignals.slice(0, 15).map((signal) => ({
      ticker: signal.ticker,
      form: signal.form,
      accessionNumber: signal.accessionNumber,
      filingDate: signal.filingDate,
      priority: signal.priority,
      materiality: signal.materiality,
      action: signal.action,
      direction: signal.direction,
      confidence: signal.confidence,
      headline: signal.headline,
      sourceUrl: signal.sourceUrl
    })),
    errors
  };
}
