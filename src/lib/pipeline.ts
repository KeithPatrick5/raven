import { confirmPendingSecSignalsWithAlpaca } from "@/lib/alpaca";
import { classifyPendingSecFilings } from "@/lib/classifier";
import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { runPaperTradeEngine, reviewOpenPaperTrades } from "@/lib/paper";
import { scorePendingSignals } from "@/lib/scoring";
import { scanWatchlistSecFilings } from "@/lib/sec";
import { savePipelineRun } from "@/lib/pipelineRuns";
import { scanFinraShortVolume } from "@/lib/finra";
import { scanFederalRegisterSignals } from "@/lib/federalRegister";
import { scanFdaSignals } from "@/lib/fda";
import { scanNewsSignals } from "@/lib/news";
import { promoteSecDiscoveryFallbackCandidate, scanSecDiscoveryRadar } from "@/lib/secDiscovery";
import { scanCongressSignals } from "@/lib/congress";
import { syncRadarFromSignalEvents } from "@/lib/radar";
import { runPaperOrderExecution } from "@/lib/paperExecution";
import { getPaperPositionLifecycle } from "@/lib/paperLifecycle";
import { syncShadowTrades } from "@/lib/performance";

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
    const inserted = await sql<{ inserted: boolean }[]>`
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

    if (inserted[0]?.inserted) saved += 1;
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
  steps.push(await runStep("sec_discovery_radar", scanSecDiscoveryRadar));
  steps.push(await runStep("sec_discovery_ai_fallback", () => promoteSecDiscoveryFallbackCandidate(1)));
  steps.push(await runStep("ai_classify_one", () => classifyPendingSecFilings(1)));
  steps.push(await runStep("alpaca_confirm", () => confirmPendingSecSignalsWithAlpaca(5)));
  steps.push(await runStep("finra_short_volume", scanFinraShortVolume));
  steps.push(await runStep("federal_register", scanFederalRegisterSignals));
  steps.push(await runStep("fda", scanFdaSignals));
  steps.push(await runStep("congress", scanCongressSignals));
  steps.push(await runStep("news", scanNewsSignals));
  steps.push(await runStep("radar_sync", syncRadarFromSignalEvents));
  steps.push(await runStep("score_signals", () => scorePendingSignals(10)));
  steps.push(await runStep("paper_trade_engine", () => runPaperTradeEngine(10)));
  steps.push(await runStep("paper_order_execution", () => runPaperOrderExecution({ submit: true })));
  steps.push(await runStep("shadow_trade_sync", () => syncShadowTrades(25)));
  steps.push(await runStep("paper_position_lifecycle", getPaperPositionLifecycle));
  steps.push(await runStep("paper_trade_review", () => reviewOpenPaperTrades(10)));

  const failed = steps.filter((step) => !step.ok);
  const opened = steps.find((step) => step.name === "paper_trade_engine")?.result as { opened?: number } | undefined;
  const execution = steps.find((step) => step.name === "paper_order_execution")?.result as { orderSubmission?: string; submittedOrder?: unknown } | undefined;
  const reviewed = steps.find((step) => step.name === "paper_trade_review")?.result as { closed?: number } | undefined;

  const result = {
    ok: failed.length === 0,
    phase: "RAVEN_PIPELINE_RUNNER",
    startedAt,
    finishedAt: now(),
    liveTrading: "disabled" as const,
    summary: {
      steps: steps.length,
      failed: failed.length,
      paperTradesOpened: (execution?.orderSubmission === "submitted" ? 1 : 0) || opened?.opened || 0,
      paperTradesClosed: reviewed?.closed || 0
    },
    steps
  };

  await savePipelineRun(result).catch(() => null);

  return result;
}
