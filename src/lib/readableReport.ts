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

function isCongressPaywalled(data: Record<string, unknown>) {
  return asArray(data.errors).every((error) => {
    const text = JSON.stringify(error).toLowerCase();
    return text.includes("returned 402") || text.includes("returned 403") || text.includes("payment required") || text.includes("forbidden");
  }) && asArray(data.errors).length > 0;
}

function sourceStepLine(run: PipelineLike, name: string, label: string) {
  const found = step(run, name);
  if (!found) return `${label}: not run`;
  const data = asObject(found.result);
  const errors = asArray(data.errors).length;
  const partialErrors = asArray(data.partialErrors).length;
  const signalCount = num(data.signalCount) || num(data.mappedSignalCount);
  const rawCount = num(data.rawArticleCount) || num(data.rawEventCount) || num(data.rawCandidateCount) || num(data.rawEntryCount) || num(data.rowCount);
  const suppressed = num(data.weakMatchesSuppressed);

  if (name === "paper_order_execution") {
    const status = found.ok && data.ok !== false ? "ok" : "needs attention";
    const orderSubmission = String(data.orderSubmission || "unknown");
    const enabled = data.paperTradingEnabled ? "enabled" : "disabled";
    const eligible = num(data.eligible);
    const reviewed = num(data.candidatesReviewed);
    const selectedPlan = data.selectedPlan ? "yes" : "no";
    return `${label}: ${status} | ${seconds(found.durationMs)} | paper ${enabled} | submission ${orderSubmission} | eligible ${eligible}/${reviewed} | selected ${selectedPlan}`;
  }

  if (name === "paper_position_lifecycle") {
    const status = found.ok && data.ok !== false ? "ok" : "needs attention";
    return `${label}: ${status} | ${seconds(found.durationMs)} | open positions ${num(data.openPositions)} | open orders ${num(data.openOrders)} | pending exits ${num(data.pendingExits)}`;
  }

  if (name === "radar_sync") {
    const radarCount = num(data.radarCount);
    const upserted = num(data.upserted);
    const scannedEvents = num(data.scannedEvents);
    const status = found.ok && data.ok !== false ? "ok" : "needs attention";
    return `${label}: ${status} | ${seconds(found.durationMs)} | active ${radarCount} | updated ${upserted} | scanned ${scannedEvents}`;
  }

  if (name === "congress" && isCongressPaywalled(data)) {
    return `${label}: parked | provider paywalled | no action needed | ${seconds(found.durationMs)}`;
  }

  if (name === "fda" && partialErrors && !errors) {
    const bits = [`${label}: ok with partial provider issue`, seconds(found.durationMs)];
    if (rawCount) bits.push(`raw ${rawCount}`);
    bits.push(`signals ${signalCount}`);
    if (suppressed) bits.push(`suppressed ${suppressed}`);
    bits.push(`provider warnings ${partialErrors}`);
    return bits.join(" | ");
  }

  const status = found.ok && data.ok !== false ? "ok" : data.partial ? "partial" : "needs attention";
  const bits = [`${label}: ${status}`, seconds(found.durationMs)];
  if (rawCount) bits.push(`raw ${rawCount}`);
  if (signalCount || name === "news" || name === "fda" || name === "federal_register" || name === "congress") bits.push(`signals ${signalCount}`);
  if (suppressed) bits.push(`suppressed ${suppressed}`);
  if (errors || partialErrors) bits.push(`errors ${errors + partialErrors}`);
  return bits.join(" | ");
}

function signalText(source: string, item: unknown) {
  const signal = asObject(item);
  const ticker = String(signal.ticker || "?");
  const action = String(signal.action || "?");
  const confidence = signal.confidence ?? signal.finalScore ?? "?";

  if (source === "FINRA") {
    const ratio = signal.shortRatioPercent ?? signal.short_ratio_percent;
    const shortVolume = signal.shortVolume ?? signal.short_volume;
    return `- FINRA | ${ticker} | ${action} | ${confidence}/100 | short volume ${ratio ?? "?"}% (${shortVolume ?? "?"} shares)`;
  }

  const headline = signal.headline || signal.title || signal.summary || signal.category || "signal";
  return `- ${source} | ${ticker} | ${action} | ${confidence}/100 | ${String(headline).slice(0, 150)}`;
}

function topSignalsFromStep(run: PipelineLike, name: string, source: string, max = 3) {
  const signals = asArray(result(run, name).signals).slice(0, max);
  return signals.map((item) => signalText(source, item));
}

function buildRavenRead(run: PipelineLike) {
  const paper = result(run, "paper_trade_engine");
  const execution = result(run, "paper_order_execution");
  const score = result(run, "score_signals");
  const rejects = asArray(paper.rejects);
  const trades = asArray(paper.trades);
  const scoredSignals = asArray(score.signals);
  const submittedOrder = execution.submittedOrder;
  const selectedPlan = asObject(execution.selectedPlan);

  if (execution.orderSubmission === "submitted") {
    return `Raven autonomously submitted a paper order for ${selectedPlan.ticker || "unknown"}. Live trading remains disabled.`;
  }

  if (execution.orderSubmission === "blocked" && selectedPlan.ticker) {
    return `Raven found an eligible paper plan for ${selectedPlan.ticker}, but execution was blocked by safety/risk gates. No paper order was submitted.`;
  }

  if (trades.length) {
    const trade = asObject(trades[0]);
    return `Raven opened ${trades.length} paper trade(s). Lead trade: ${trade.ticker || "unknown"}. Live trading remains disabled.`;
  }

  if (rejects.length) {
    const reject = asObject(rejects[0]);
    return `Raven found ${reject.ticker || "a candidate"} as the strongest evaluated candidate, but rejected it because ${(asArray(reject.rejects).join(", ") || "rules did not pass")}. No paper trade opened.`;
  }

  if (scoredSignals.length) {
    const signal = asObject(scoredSignals[0]);
    return `Raven scored ${scoredSignals.length} signal(s). Strongest visible score was ${signal.ticker || "unknown"} at ${signal.finalScore ?? signal.confidence ?? "?"}/100 with action ${signal.action || "unknown"}. No paper trade opened.`;
  }

  return "Raven completed the run without opening a paper trade. No tradeable setup passed the deterministic rules.";
}

function reportIssues(run: PipelineLike) {
  const issues: string[] = [];

  for (const item of run.steps || []) {
    const data = asObject(item.result);
    if (item.error) issues.push(`${item.name}: ${item.error}`);

    if (item.name === "congress" && isCongressPaywalled(data)) {
      issues.push("congress: parked/provider paywalled. No action needed unless you decide to pay for congressional data later.");
      continue;
    }

    if (item.name === "fda") {
      for (const error of asArray(data.partialErrors)) {
        const text = JSON.stringify(error);
        issues.push(`fda: partial provider issue, scanner still ok: ${text}`);
      }
      for (const error of asArray(data.errors)) issues.push(`fda: ${JSON.stringify(error)}`);
      continue;
    }

    for (const error of asArray(data.errors)) issues.push(`${item.name}: ${JSON.stringify(error)}`);
    for (const error of asArray(data.partialErrors)) issues.push(`${item.name}: ${JSON.stringify(error)}`);
  }

  return Array.from(new Set(issues));
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
  const paperExec = result(run, "paper_order_execution");
  const lifecycle = result(run, "paper_position_lifecycle");
  const paperRejects = asArray(paper.rejects);
  const paperTrades = asArray(paper.trades);
  const issues = reportIssues(run);

  const topSignals = [
    ...topSignalsFromStep(run, "score_signals", "SEC", 3),
    ...topSignalsFromStep(run, "sec_discovery_radar", "SEC DISC", 3),
    ...topSignalsFromStep(run, "news", "NEWS", 3),
    ...topSignalsFromStep(run, "federal_register", "FED REG", 2),
    ...topSignalsFromStep(run, "finra_short_volume", "FINRA", 2)
  ].slice(0, 10);

  const lines = [
    "RAVEN RUN REPORT",
    "================",
    line("Status", run.ok ? "ok" : "needs attention"),
    line("Started", shortTime(run.startedAt)),
    line("Finished", shortTime(run.finishedAt)),
    line("Live trading", run.liveTrading || "disabled"),
    line("Steps", `${summary.steps ?? (run.steps || []).length} total, ${summary.failed ?? 0} failed`),
    "",
    "RAVEN READ",
    "----------",
    buildRavenRead(run),
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
    line("Autonomous paper execution", `${paperExec.paperTradingEnabled ? "enabled" : "disabled"}, ${paperExec.orderSubmission || "not run"}`),
    line("Lifecycle", `${num(lifecycle.openPositions)} open positions, ${num(lifecycle.openOrders)} open orders, ${num(lifecycle.pendingExits)} pending exits`),
    "",
    "SOURCE HEALTH",
    "-------------",
    sourceStepLine(run, "finra_short_volume", "FINRA"),
    sourceStepLine(run, "federal_register", "Federal Register"),
    sourceStepLine(run, "fda", "FDA"),
    sourceStepLine(run, "congress", "Congress"),
    sourceStepLine(run, "news", "News"),
    sourceStepLine(run, "sec_discovery_radar", "SEC Discovery"),
    sourceStepLine(run, "radar_sync", "Radar"),
    sourceStepLine(run, "paper_order_execution", "Paper Execution"),
    sourceStepLine(run, "paper_position_lifecycle", "Lifecycle"),
    "",
    "TOP SIGNALS THIS RUN",
    "--------------------",
    ...(topSignals.length ? topSignals : ["None"]),
    "",
    "TRADE DECISION",
    "--------------",
    paperExec.orderSubmission === "submitted" ? "Autonomous Alpaca paper order submitted." : paperTrades.length ? `${paperTrades.length} paper trade(s) opened.` : "No paper trades opened.",
    paperRejects.length ? `Rejected ${paperRejects.length} candidate(s).` : "No new rejects.",
    ...paperRejects.slice(0, 5).map((item) => {
      const reject = asObject(item);
      return `- ${reject.ticker || "?"} | score ${reject.score ?? "?"} | ${reject.action || "?"} | ${(asArray(reject.rejects).join(", ") || "rejected")}`;
    }),
    "",
    "WARNINGS / PARTIALS",
    "-------------------",
    ...(issues.length ? issues.slice(0, 8) : ["None"]),
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
