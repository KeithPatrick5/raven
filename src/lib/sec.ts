import { analyzeFilingPriority } from "@/lib/filingIntelligence";
import { watchlist } from "@/lib/watchlist";

export type SecTickerMatch = {
  cik_str: number;
  ticker: string;
  title: string;
};

export type NormalizedSecFiling = {
  ticker: string;
  cik: string;
  companyName: string;
  accessionNumber: string;
  form: string;
  filingDate: string | null;
  reportDate: string | null;
  primaryDocument: string | null;
  primaryDocumentUrl: string | null;
  sourceUrl: string;
  priority: string;
  priorityScore: number;
  materiality: string;
  formFamily: string;
  priorityReasons: string[];
  rawPayload: Record<string, unknown>;
};

const SEC_BASE = "https://data.sec.gov";
const SEC_ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";

const FORMS_TO_KEEP = new Set([
  "8-K",
  "10-Q",
  "10-K",
  "S-1",
  "S-3",
  "424B5",
  "13D",
  "13G",
  "SC 13D",
  "SC 13D/A",
  "SC 13G",
  "SC 13G/A",
  "4",
  "NT 10-Q",
  "NT 10-K"
]);

function secHeaders(): HeadersInit {
  return {
    "User-Agent": process.env.SEC_USER_AGENT?.trim() || "RavenPrivateScanner/0.2 contact@example.com",
    "Accept-Encoding": "gzip, deflate",
    "Accept": "application/json"
  };
}

function padCik(cik: number | string): string {
  return String(cik).padStart(10, "0");
}

function compactCik(cik: number | string): string {
  return String(Number(cik));
}

function primaryDocumentUrl(cik: string, accessionNumber: string, primaryDocument: string | null): string | null {
  if (!primaryDocument) return null;
  const accessionPath = accessionNumber.replaceAll("-", "");
  return `${SEC_ARCHIVES}/${compactCik(cik)}/${accessionPath}/${primaryDocument}`;
}

export async function getTickerMap(): Promise<Map<string, SecTickerMatch>> {
  const response = await fetch(TICKER_MAP_URL, {
    headers: secHeaders(),
    next: { revalidate: 60 * 60 * 24 }
  });

  if (!response.ok) {
    throw new Error(`SEC ticker map failed: ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, SecTickerMatch>;
  const map = new Map<string, SecTickerMatch>();

  for (const item of Object.values(payload)) {
    map.set(item.ticker.toUpperCase(), item);
  }

  return map;
}

export async function getRecentFilingsForTicker(symbol: string, limit = 8): Promise<NormalizedSecFiling[]> {
  const tickerMap = await getTickerMap();
  const match = tickerMap.get(symbol.toUpperCase());

  if (!match) {
    return [];
  }

  const cik = padCik(match.cik_str);
  const sourceUrl = `${SEC_BASE}/submissions/CIK${cik}.json`;
  const response = await fetch(sourceUrl, {
    headers: secHeaders(),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`SEC submissions failed for ${symbol}: ${response.status}`);
  }

  const submission = await response.json();
  const recent = submission?.filings?.recent;

  if (!recent?.accessionNumber?.length) {
    return [];
  }

  const filings: NormalizedSecFiling[] = [];

  for (let index = 0; index < recent.accessionNumber.length && filings.length < limit; index += 1) {
    const form = String(recent.form?.[index] || "").trim();

    if (!FORMS_TO_KEEP.has(form)) {
      continue;
    }

    const accessionNumber = String(recent.accessionNumber[index]);
    const primaryDocument = recent.primaryDocument?.[index] ? String(recent.primaryDocument[index]) : null;
    const priority = analyzeFilingPriority({
      form,
      primaryDocument,
      primaryDocDescription: recent.primaryDocDescription?.[index] || null,
      items: recent.items?.[index] || null
    });

    filings.push({
      ticker: symbol.toUpperCase(),
      cik,
      companyName: match.title,
      accessionNumber,
      form,
      filingDate: recent.filingDate?.[index] || null,
      reportDate: recent.reportDate?.[index] || null,
      primaryDocument,
      primaryDocumentUrl: primaryDocumentUrl(cik, accessionNumber, primaryDocument),
      sourceUrl,
      priority: priority.priority,
      priorityScore: priority.priorityScore,
      materiality: priority.materiality,
      formFamily: priority.formFamily,
      priorityReasons: priority.reasons,
      rawPayload: {
        ravenPriority: priority.priority,
        ravenPriorityScore: priority.priorityScore,
        ravenMateriality: priority.materiality,
        ravenFormFamily: priority.formFamily,
        ravenIsRoutineForm4: priority.isRoutineForm4,
        ravenShouldClassify: priority.shouldClassify,
        ravenPriorityReasons: priority.reasons,
        accessionNumber,
        form,
        filingDate: recent.filingDate?.[index] || null,
        reportDate: recent.reportDate?.[index] || null,
        acceptanceDateTime: recent.acceptanceDateTime?.[index] || null,
        act: recent.act?.[index] || null,
        fileNumber: recent.fileNumber?.[index] || null,
        filmNumber: recent.filmNumber?.[index] || null,
        items: recent.items?.[index] || null,
        size: recent.size?.[index] || null,
        isXBRL: recent.isXBRL?.[index] || null,
        isInlineXBRL: recent.isInlineXBRL?.[index] || null,
        primaryDocument,
        primaryDocDescription: recent.primaryDocDescription?.[index] || null
      }
    });
  }

  return filings;
}

export async function scanWatchlistSecFilings() {
  const results: NormalizedSecFiling[] = [];
  const errors: Array<{ ticker: string; error: string }> = [];

  for (const item of watchlist) {
    try {
      const filings = await getRecentFilingsForTicker(item.symbol, 6);
      results.push(...filings);
    } catch (error) {
      errors.push({
        ticker: item.symbol,
        error: error instanceof Error ? error.message : "Unknown SEC scanner error"
      });
    }
  }

  results.sort((a, b) => b.priorityScore - a.priorityScore || String(b.filingDate || "").localeCompare(String(a.filingDate || "")));

  return { filings: results, errors };
}
