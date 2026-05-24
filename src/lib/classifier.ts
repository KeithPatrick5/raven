import { classifySecFilingWithAi, hasAiProvider } from "@/lib/ai";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type RawSecFilingRow = {
  id: number;
  ticker: string;
  cik: string;
  accession_number: string;
  form: string;
  filing_date: string | null;
  report_date: string | null;
  primary_document: string | null;
  primary_document_url: string | null;
  source_url: string;
  raw_payload: Record<string, unknown> | null;
};

function stripFilingText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFilingText(url: string | null): Promise<string> {
  if (!url) return "No primary document URL was available.";

  const response = await fetch(url, {
    headers: {
      "User-Agent": process.env.SEC_USER_AGENT?.trim() || "RavenPrivateScanner/0.3 contact@example.com",
      Accept: "text/html,application/xml,text/plain,*/*"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`SEC filing document fetch failed: ${response.status}`);
  }

  const text = await response.text();
  return stripFilingText(text).slice(0, 28000);
}

async function getPendingRawFilings(limit: number): Promise<RawSecFilingRow[]> {
  const sql = db();
  const rows = await sql<RawSecFilingRow[]>`
    select
      raw_sec_filings.id,
      raw_sec_filings.ticker,
      raw_sec_filings.cik,
      raw_sec_filings.accession_number,
      raw_sec_filings.form,
      raw_sec_filings.filing_date::text as filing_date,
      raw_sec_filings.report_date::text as report_date,
      raw_sec_filings.primary_document,
      raw_sec_filings.primary_document_url,
      raw_sec_filings.source_url,
      raw_sec_filings.raw_payload
    from raw_sec_filings
    left join sec_filing_summaries
      on sec_filing_summaries.raw_filing_id = raw_sec_filings.id
    where sec_filing_summaries.id is null
    order by raw_sec_filings.filing_date desc nulls last, raw_sec_filings.id desc
    limit ${limit}
  `;

  return rows;
}

async function saveClassification(row: RawSecFilingRow, result: Awaited<ReturnType<typeof classifySecFilingWithAi>>) {
  const sql = db();
  const summary = result.classification;

  await sql`
    insert into sec_filing_summaries (
      raw_filing_id,
      accession_number,
      ticker,
      form,
      filing_date,
      classifier_model,
      direction,
      category,
      risk_level,
      tradeability,
      summary,
      bull_case,
      bear_case,
      verdict,
      confirmation_needed,
      avoid_if,
      raw_ai
    ) values (
      ${row.id},
      ${row.accession_number},
      ${row.ticker},
      ${row.form},
      ${row.filing_date},
      ${result.model},
      ${summary.direction},
      ${summary.category},
      ${summary.risk_level},
      ${summary.tradeability},
      ${summary.summary},
      ${summary.bull_case},
      ${summary.bear_case},
      ${summary.verdict},
      ${JSON.stringify(summary.confirmation_needed)}::jsonb,
      ${JSON.stringify(summary.avoid_if)}::jsonb,
      ${JSON.stringify(result.raw)}::jsonb
    )
    on conflict (accession_number) do nothing
  `;
}

export async function classifyPendingSecFilings(limit = 4) {
  if (!hasDatabase()) {
    return {
      ok: false,
      database: "not_configured" as const,
      ai: hasAiProvider() ? "configured" : "not_configured",
      classified: 0,
      pending: 0,
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }],
      summaries: []
    };
  }

  await ensureRavenTables();

  if (!hasAiProvider()) {
    const pending = await getPendingRawFilings(limit);
    return {
      ok: false,
      database: "configured" as const,
      ai: "not_configured" as const,
      classified: 0,
      pending: pending.length,
      errors: [{ error: "GROQ_API_KEY is not configured." }],
      summaries: []
    };
  }

  const pending = await getPendingRawFilings(limit);
  const summaries: Array<Record<string, unknown>> = [];
  const errors: Array<{ ticker?: string; accessionNumber?: string; error: string }> = [];

  for (const row of pending) {
    try {
      const filingText = await fetchFilingText(row.primary_document_url);
      const result = await classifySecFilingWithAi({
        ticker: row.ticker,
        companyName: typeof row.raw_payload?.companyName === "string" ? row.raw_payload.companyName : undefined,
        form: row.form,
        filingDate: row.filing_date,
        reportDate: row.report_date,
        accessionNumber: row.accession_number,
        primaryDocumentUrl: row.primary_document_url,
        filingText
      });

      await saveClassification(row, result);
      summaries.push({
        ticker: row.ticker,
        accessionNumber: row.accession_number,
        form: row.form,
        filingDate: row.filing_date,
        ...result.classification
      });
    } catch (error) {
      errors.push({
        ticker: row.ticker,
        accessionNumber: row.accession_number,
        error: error instanceof Error ? error.message : "Unknown classification failure"
      });
    }
  }

  return {
    ok: errors.length === 0,
    database: "configured" as const,
    ai: "configured" as const,
    classified: summaries.length,
    pending: Math.max(0, pending.length - summaries.length),
    errors,
    summaries
  };
}

export async function getLatestSecSummaries(limit = 8) {
  if (!hasDatabase()) return [];

  await ensureRavenTables();
  const sql = db();

  const rows = await sql<Array<{
    ticker: string;
    accession_number: string;
    form: string;
    filing_date: string | null;
    direction: string;
    category: string;
    risk_level: string;
    tradeability: number;
    summary: string;
    bull_case: string;
    bear_case: string;
    verdict: string;
    created_at: string;
  }>>`
    select
      ticker,
      accession_number,
      form,
      filing_date::text as filing_date,
      direction,
      category,
      risk_level,
      tradeability,
      summary,
      bull_case,
      bear_case,
      verdict,
      created_at::text as created_at
    from sec_filing_summaries
    order by created_at desc
    limit ${limit}
  `;

  return rows;
}
