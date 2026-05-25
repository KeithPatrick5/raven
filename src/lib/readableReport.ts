type StepLike = {
  name?: string;
  ok?: boolean;
  durationMs?: number;
  result?: unknown;
  error?: string;
};

type PipelineLike = {
  ok?: boolean;
  phase?: string;
  startedAt?: string;
  finishedAt?: string;
  liveTrading?: string;
  summary?: Record<string, unknown>;
  steps?: StepLike[];
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function yesNo(value: unknown) {
  return value ? "yes" : "no";
}

function seconds(ms: unknown) {
  const value = num(ms);
  if (!value) return "0.0s";
  return `${(value / 1000).toFixed(1)}s`;
}

function shortTime(value: unknown) {
  const raw = String(value || "");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw || "unknown";
  return date.toISOString();
}

function step(run: PipelineLike, name: string): StepLike | undefined {
  return (run.steps || []).find((item) => item.name === name);
}

function result(run: PipelineLike, name: string) {
  return asObject(step(run, name)?.result);
}

function line(label: string, value: unknown) {
  return `${label}: ${String(value ?? "-")}`;
}

function sourceStepLine(run: PipelineLike, name: string, label: string) {
  const found = step(run, name);
  if (!found) return `${label}: not run`;
  const data = asObject(found.result);
  const errors = asArray(data.errors).length;
  const partialErrors = asArray(data.partialErrors).length;
  const signalCount = num(data.signalCount);
  const rawCount = num(data.rawArticleCount) || num(data.rawEventCount) || num(data.rawCandidateCount) || num(data.rowCount);
  const suppressed = num(data.weakMatchesSuppressed);
  const status = found.ok && data.ok !== false ? "ok" : data.partial ? "partial" : "needs attention";
  const bits = [`${label}: ${status}`, seconds(found.durationMs)];
  if (rawCount) bits.push(`raw ${rawCount}`);
  if (signalCount || name === "news" || name === "fda" || name === "federal_register" || name === "congress") bits.push(`signals ${signalCount}`);
  if (suppressed) bits.push(`suppressed ${suppressed}`);
  if (errors || partialErrors) bits.push(`errors ${errors + partialErrors}`);
  return bits.join(" | ");
}

function topSignalsFromStep(run: PipelineLike, name: string, max = 3) {
  const signals = asArray(result(run, name).signals).slice(0, max);
  return signals.map((item) => {
    const signal = asObject(item);
    const ticker = signal.ticker || "?";
    const action = signal.action || "?";
    const confidence = signal.confidence ?? signal.finalScore ?? "?";
    const headline = signal.headline || signal.title || signal.summary || signal.category || "signal";
    return `- ${ticker} | ${action} | ${confidence}/100 | ${String(headline).slice(0, 140)}`;
  });
}

export function buildPipelineTextReport(run: PipelineLike) {
  const summary = asObject(run.summary);
  const sec = result(run, "sec_scan_and_store");
  const secStorage = asObject(sec.storage);
  const ai = result(run, "ai_classify_one");
  const alpaca = result(run, "alpaca_confirm");
  const score = result(run, "score_signals");
  const paper = result(run, "paper_trade_engine");
  const review = result(run, "paper_trade_review");
  const paperRejects = asArray(paper.rejects);
  const paperTrades = asArray(paper.trades);
  const errors = (run.steps || []).flatMap((item) => {
    const data = asObject(item.result);
    return [
      ...(item.error ? [`${item.name}: ${item.error}`] : []),
      ...asArray(data.errors).map((error) => `${item.name}: ${JSON.stringify(error)}`),
      ...asArray(data.partialErrors).map((error) => `${item.name}: ${JSON.stringify(error)}`)
    ];
  });

  const lines = [
    "RAVEN RUN REPORT",
    "================",
    line("Status", run.ok ? "ok" : "needs attention"),
    line("Started", shortTime(run.startedAt)),
    line("Finished", shortTime(run.finishedAt)),
    line("Live trading", run.liveTrading || "disabled"),
    line("Steps", `${summary.steps ?? (run.steps || []).length} total, ${summary.failed ?? 0} failed`),
    "",
    "CORE RESULT",
    "-----------",
    line("SEC filings", `${num(sec.filingCount)} found, ${num(secStorage.saved)} new, ${num(secStorage.skipped)} skipped`),
    line("AI classified", num(ai.classified)),
    line("Alpaca confirmed", num(alpaca.confirmed)),
    line("Signals scored", num(score.scored)),
    line("Paper trades opened", num(paper.opened)),
    line("Paper trades rejected", num(paper.rejected)),
    line("Paper trades closed", num(review.closed)),
    "",
    "SOURCE HEALTH",
    "-------------",
    sourceStepLine(run, "finra_short_volume", "FINRA"),
    sourceStepLine(run, "federal_register", "Federal Register"),
    sourceStepLine(run, "fda", "FDA"),
    sourceStepLine(run, "congress", "Congress"),
    sourceStepLine(run, "news", "News"),
    "",
    "TOP SIGNALS THIS RUN",
    "--------------------",
    ...[
      ...topSignalsFromStep(run, "score_signals", 3),
      ...topSignalsFromStep(run, "news", 3),
      ...topSignalsFromStep(run, "federal_register", 2),
      ...topSignalsFromStep(run, "finra_short_volume", 2)
    ].slice(0, 10),
    "",
    "TRADE DECISION",
    "--------------",
    paperTrades.length ? `${paperTrades.length} paper trade(s) opened.` : "No paper trades opened.",
    paperRejects.length ? `Rejected ${paperRejects.length} candidate(s).` : "No new rejects.",
    ...paperRejects.slice(0, 5).map((item) => {
      const reject = asObject(item);
      return `- ${reject.ticker || "?"} | score ${reject.score ?? "?"} | ${reject.action || "?"} | ${(asArray(reject.rejects).join(", ") || "rejected")}`;
    }),
    "",
    "ERRORS / PARTIALS",
    "-----------------",
    ...(errors.length ? errors.slice(0, 12) : ["None"]),
    "",
    "COPY NOTE",
    "---------",
    "Paste this full report into ChatGPT when you want Raven debug help."
  ];

  return `${lines.join("\n")}\n`;
}

export function buildRunLogsTextReport(runs: Array<Record<string, unknown>>) {
  const lines = [
    "RAVEN RUN HISTORY",
    "=================",
    `Runs shown: ${runs.length}`,
    ""
  ];

  for (const run of runs) {
    lines.push([
      `#${run.id}`,
      String(run.status || "unknown"),
      shortTime(run.started_at),
      seconds(run.duration_ms),
      `steps failed ${num(run.steps_failed)}`,
      `SEC ${num(run.sec_filings_found)} found/${num(run.sec_filings_saved)} new`,
      `AI ${num(run.ai_classified)}`,
      `Alpaca ${num(run.alpaca_confirmed)}`,
      `Scored ${num(run.signals_scored)}`,
      `Opened ${num(run.paper_trades_opened)}`,
      `Rejected ${num(run.paper_trades_rejected)}`,
      `Closed ${num(run.paper_trades_closed)}`
    ].join(" | "));
  }

  lines.push("", "COPY NOTE", "---------", "Paste this full report into ChatGPT when you want Raven cron/run-history debug help.");
  return `${lines.join("\n")}\n`;
}
