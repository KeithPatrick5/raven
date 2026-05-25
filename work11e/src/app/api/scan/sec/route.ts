import { NextResponse } from "next/server";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { scanWatchlistSecFilings } from "@/lib/sec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function saveFilings(filings: Awaited<ReturnType<typeof scanWatchlistSecFilings>>["filings"]) {
  if (!hasDatabase()) {
    return { saved: 0, skipped: filings.length, database: "not_configured" as const };
  }

  await ensureRavenTables();
  const sql = db();
  let saved = 0;

  for (const filing of filings) {
    const result = await sql<{ inserted: boolean }[]>`
      insert into raw_sec_filings (
        ticker,
        cik,
        accession_number,
        form,
        filing_date,
        report_date,
        primary_document,
        primary_document_url,
        source_url,
        raw_payload
      ) values (
        ${filing.ticker},
        ${filing.cik},
        ${filing.accessionNumber},
        ${filing.form},
        ${filing.filingDate},
        ${filing.reportDate},
        ${filing.primaryDocument},
        ${filing.primaryDocumentUrl},
        ${filing.sourceUrl},
        ${JSON.stringify(filing.rawPayload)}::jsonb
      )
      on conflict (accession_number) do update set
        primary_document = excluded.primary_document,
        primary_document_url = excluded.primary_document_url,
        source_url = excluded.source_url,
        raw_payload = raw_sec_filings.raw_payload || excluded.raw_payload
      returning (xmax = 0) as inserted
    `;
    if (Array.isArray(result) && result[0]?.inserted) saved += 1;
  }

  return { saved, skipped: filings.length - saved, database: "configured" as const };
}

async function runSecScan() {
  const startedAt = new Date().toISOString();
  const scan = await scanWatchlistSecFilings();
  const storage = await saveFilings(scan.filings);

  return NextResponse.json({
    ok: true,
    phase: "SEC_EDGAR_SCANNER",
    startedAt,
    finishedAt: new Date().toISOString(),
    watchlistCount: 5,
    filingCount: scan.filings.length,
    storage,
    errors: scan.errors,
    filings: scan.filings.slice(0, 20)
  });
}

export async function GET() {
  try {
    return await runSecScan();
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        phase: "SEC_EDGAR_SCANNER",
        error: error instanceof Error ? error.message : "Unknown SEC scanner failure"
      },
      { status: 500 }
    );
  }
}

export async function POST() {
  return GET();
}
