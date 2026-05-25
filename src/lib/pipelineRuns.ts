import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type PipelineStepRecord = {
  name: string;
  ok: boolean;
  durationMs?: number;
  result?: unknown;
  error?: string;
};

type PipelineRunRecord = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  summary: {
    steps: number;
    failed: number;
    paperTradesOpened: number;
    paperTradesClosed: number;
  };
  steps: PipelineStepRecord[];
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stepResult(run: PipelineRunRecord, name: string): Record<string, unknown> {
  const step = run.steps.find((item) => item.name === name);
  return asObject(step?.result);
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function collectErrors(run: PipelineRunRecord) {
  const errors: Array<Record<string, unknown>> = [];

  for (const step of run.steps) {
    if (step.error) errors.push({ step: step.name, error: step.error });
    const result = asObject(step.result);
    const stepErrors = result.errors;
    if (Array.isArray(stepErrors) && stepErrors.length) {
      errors.push({ step: step.name, errors: stepErrors });
    }
  }

  return errors;
}

export async function savePipelineRun(run: PipelineRunRecord) {
  if (!hasDatabase()) return null;

  await ensureRavenTables();
  const sql = db();

  const sec = stepResult(run, "sec_scan_and_store");
  const secStorage = asObject(sec.storage);
  const ai = stepResult(run, "ai_classify_one");
  const alpaca = stepResult(run, "alpaca_confirm");
  const score = stepResult(run, "score_signals");
  const paper = stepResult(run, "paper_trade_engine");
  const execution = stepResult(run, "paper_order_execution");
  const review = stepResult(run, "paper_trade_review");
  const duration = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  const errors = collectErrors(run);
  const status = run.ok ? "completed" : "needs_attention";

  const inserted = await sql<Array<{ id: number }>>`
    insert into pipeline_runs (
      status,
      started_at,
      finished_at,
      duration_ms,
      steps_total,
      steps_failed,
      sec_filings_found,
      sec_filings_saved,
      ai_classified,
      alpaca_confirmed,
      signals_scored,
      paper_trades_opened,
      paper_trades_closed,
      paper_trades_rejected,
      summary,
      steps,
      errors
    ) values (
      ${status},
      ${run.startedAt},
      ${run.finishedAt},
      ${duration},
      ${run.summary.steps},
      ${run.summary.failed},
      ${num(sec.filingCount)},
      ${num(secStorage.saved)},
      ${num(ai.classified)},
      ${num(alpaca.confirmed)},
      ${num(score.scored)},
      ${execution.orderSubmission === "submitted" ? 1 : num(paper.opened)},
      ${num(review.closed)},
      ${num(paper.rejected)},
      ${JSON.stringify(run.summary)}::jsonb,
      ${JSON.stringify(run.steps)}::jsonb,
      ${JSON.stringify(errors)}::jsonb
    )
    returning id
  `;

  return inserted[0] || null;
}

export async function getLatestPipelineRuns(limit = 5) {
  if (!hasDatabase()) return [];

  await ensureRavenTables();
  const sql = db();

  return sql<Array<{
    id: number;
    status: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    steps_total: number;
    steps_failed: number;
    sec_filings_found: number;
    sec_filings_saved: number;
    ai_classified: number;
    alpaca_confirmed: number;
    signals_scored: number;
    paper_trades_opened: number;
    paper_trades_closed: number;
    paper_trades_rejected: number;
    errors: unknown;
    created_at: string;
  }>>`
    select
      id,
      status,
      started_at::text as started_at,
      finished_at::text as finished_at,
      duration_ms,
      steps_total,
      steps_failed,
      sec_filings_found,
      sec_filings_saved,
      ai_classified,
      alpaca_confirmed,
      signals_scored,
      paper_trades_opened,
      paper_trades_closed,
      paper_trades_rejected,
      errors,
      created_at::text as created_at
    from pipeline_runs
    order by created_at desc
    limit ${Math.max(1, Math.min(20, limit))}
  `;
}
