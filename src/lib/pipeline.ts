import { confirmPendingSecSignalsWithAlpaca } from "@/lib/alpaca";
import { classifyPendingSecFilings } from "@/lib/classifier";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { runPaperTradeEngine, reviewOpenPaperTrades } from "@/lib/paper";
import { scorePendingSignals } from "@/lib/scoring";
import { scanWatchlistSecFilings } from "@/lib/sec";

type PipelineStep = {
  name: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result?: unknown;
  error?: string;
};

function now() {
  return new Date().toISOString();
}

async function runStep(name: string, fn: () => Promise<unknown>): Promise<PipelineStep> {
  const startedAt = now();
  const start = Date.now();

  try {
    const result = await fn();
    return {
      name,
      ok: true,
      startedAt,
      finishedAt: now(),
      durationMs: Date.now() - start,
      result
    };
  } catch (error) {
    return {
      name,
      ok: false,
      startedAt,
      finishedAt: now(),
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : "Unknown pipeline step failure"
    };
  }
}

async function saveScannedFilings(filings: Awaited<ReturnType<typeof scanWatchlistSecFilings>>["filings"]) {
  if (!hasDatabase()) {
    return { saved: 0, skipped: filings.length, database: "not_configured" as const };
  }

  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  let skipped = 0;

  for (const filing of filings) {
    const inserted = await sql<{ id: number }[]>`
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
      on conflict (accession_number) do nothing
      returning id
    `;

    if (inserted.length) saved += 1;
    else skipped += 1;
  }

  return { saved, skipped, database: "configured" as const };
}

async function scanAndStoreSecFilings() {
  const scan = await scanWatchlistSecFilings();
  const storage = await saveScannedFilings(scan.filings);

  return {
    ok: true,
    watchlistCount: 5,
    filingCount: scan.filings.length,
    storage,
    errors: scan.errors,
    sample: scan.filings.slice(0, 5).map((filing) => ({
      ticker: filing.ticker,
      form: filing.form,
      accessionNumber: filing.accessionNumber,
      filingDate: filing.filingDate
    }))
  };
}

export async function runRavenPipeline() {
  const startedAt = now();
  const steps: PipelineStep[] = [];

  steps.push(await runStep("sec_scan_and_store", scanAndStoreSecFilings));
  steps.push(await runStep("ai_classify_one", () => classifyPendingSecFilings(1)));
  steps.push(await runStep("alpaca_confirm", () => confirmPendingSecSignalsWithAlpaca(5)));
  steps.push(await runStep("score_signals", () => scorePendingSignals(10)));
  steps.push(await runStep("paper_trade_engine", () => runPaperTradeEngine(10)));
  steps.push(await runStep("paper_trade_review", () => reviewOpenPaperTrades(10)));

  const failed = steps.filter((step) => !step.ok);
  const opened = steps.find((step) => step.name === "paper_trade_engine")?.result as { opened?: number } | undefined;
  const reviewed = steps.find((step) => step.name === "paper_trade_review")?.result as { closed?: number } | undefined;

  return {
    ok: failed.length === 0,
    phase: "RAVEN_PIPELINE_RUNNER",
    startedAt,
    finishedAt: now(),
    liveTrading: "disabled" as const,
    summary: {
      steps: steps.length,
      failed: failed.length,
      paperTradesOpened: opened?.opened || 0,
      paperTradesClosed: reviewed?.closed || 0
    },
    steps
  };
}
