import { getAiRouterReport } from "@/lib/aiRouter";
import { getAiUsageReport, getAiUsageSnapshot } from "@/lib/aiUsage";
import { getAlpacaPaperSnapshot, getAlpacaPaperTextReport } from "@/lib/alpacaTrading";
import { getCandidateRankingReport } from "@/lib/candidateRanking";
import { buildCronStatusReport, getCronStatusSnapshot } from "@/lib/cronStatus";
import { getMarketAnomalyReport } from "@/lib/marketAnomalies";
import { getPaperExecutionTextReport } from "@/lib/paperExecution";
import { getPaperLifecycleTextReport } from "@/lib/paperLifecycle";
import { getPaperRiskTextReport, getPaperTradePlan, getPaperTradePlanTextReport } from "@/lib/paperPlanner";
import { buildPerformanceReport, getPerformanceSnapshot } from "@/lib/performance";
import { getSignalTruthReport, getSignalTruthSnapshot } from "@/lib/signalTruth";

export type ReportKind =
  | "signal-truth"
  | "performance"
  | "cron"
  | "ai-usage"
  | "ai-router"
  | "paper-account"
  | "paper-plan"
  | "paper-risk"
  | "paper-execution"
  | "paper-lifecycle"
  | "candidate-ranking"
  | "market-anomalies";

export type OperatorReport = {
  kind: ReportKind;
  title: string;
  subtitle: string;
  status: "ok" | "watch" | "needs_attention";
  generatedAt: string;
  window?: string;
  bottomLine: string;
  stats: Array<{ label: string; value: string; tone?: "good" | "bad" | "watch" }>;
  sections: Array<{ title: string; items: string[] }>;
  rawJsonHref?: string;
  oldTextHref?: string;
  copyText: string;
};

type TextReportConfig = {
  kind: ReportKind;
  title: string;
  subtitle: string;
  bottomLine: string;
  sections?: Array<{ title: string; items: string[] }>;
  textReport: string;
  rawJsonHref?: string;
  oldTextHref?: string;
  window?: string;
  status?: OperatorReport["status"];
};

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function maybeNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function pct(value: unknown) {
  const n = maybeNum(value);
  if (n === null) return "--";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function money(value: unknown) {
  const n = maybeNum(value);
  if (n === null) return "--";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function lineItems(text: string, limit = 12) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.match(/^[=-]+$/))
    .slice(0, limit);
}

function buildCopyText(report: Omit<OperatorReport, "copyText">) {
  const lines: string[] = [];
  lines.push(report.title.toUpperCase());
  lines.push("=".repeat(report.title.length));
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.window) lines.push(`Window: ${report.window}`);
  lines.push("");
  lines.push("BOTTOM LINE");
  lines.push(report.bottomLine);
  lines.push("");
  if (report.stats.length) {
    lines.push("KEY NUMBERS");
    for (const stat of report.stats) lines.push(`- ${stat.label}: ${stat.value}`);
    lines.push("");
  }
  for (const section of report.sections) {
    lines.push(section.title.toUpperCase());
    for (const item of section.items) lines.push(`- ${item}`);
    lines.push("");
  }
  if (report.rawJsonHref) lines.push(`Raw JSON: ${report.rawJsonHref}`);
  if (report.oldTextHref) lines.push(`Old text report: ${report.oldTextHref}`);
  return lines.join("\n").trim() + "\n";
}

function finalize(report: Omit<OperatorReport, "copyText">): OperatorReport {
  return { ...report, copyText: buildCopyText(report) };
}

function fromTextReport(config: TextReportConfig): OperatorReport {
  const generatedAt = new Date().toISOString();
  const preview = lineItems(config.textReport, 18);
  const baseSections = config.sections || [];
  const report = finalize({
    kind: config.kind,
    title: config.title,
    subtitle: config.subtitle,
    status: config.status || "ok",
    generatedAt,
    window: config.window,
    bottomLine: config.bottomLine,
    stats: [],
    sections: [
      ...baseSections,
      { title: "Report details", items: preview.length ? preview : ["The underlying report returned no lines."] }
    ],
    rawJsonHref: config.rawJsonHref,
    oldTextHref: config.oldTextHref
  });
  return report;
}

export async function buildSignalTruthOperatorReport(window = "7d"): Promise<OperatorReport> {
  const snapshot = await getSignalTruthSnapshot(window);
  const text = await getSignalTruthReport(window);
  const generatedAt = new Date().toISOString();

  if (!snapshot.ok) {
    return finalize({
      kind: "signal-truth",
      title: "Signal Truth Audit",
      subtitle: "Outcome tracking for Raven signals.",
      status: "needs_attention",
      generatedAt,
      window,
      bottomLine: "Raven cannot audit signal outcomes yet because the database is not configured.",
      stats: [],
      sections: [
        { title: "Needs attention", items: ["Set DATABASE_URL or STORAGE_URL before relying on Signal Truth."] },
        { title: "Debug extract", items: lineItems(text, 10) }
      ],
      rawJsonHref: `/api/signals/truth?window=${window}&sync=1`,
      oldTextHref: `/api/signals/truth/report?window=${window}&sync=1`
    });
  }

  const totals = snapshot.totals;
  const signals = num(totals.signals);
  const avgLatest = maybeNum(totals.avgLatestReturn);
  const winRate = maybeNum(totals.winRateLatest);
  const status: OperatorReport["status"] = signals === 0 ? "watch" : avgLatest !== null && avgLatest < 0 ? "watch" : "ok";
  const bestSource = Array.isArray(snapshot.bySource) ? snapshot.bySource[0] as Record<string, unknown> | undefined : undefined;
  const bestAction = Array.isArray(snapshot.byAction) ? snapshot.byAction[0] as Record<string, unknown> | undefined : undefined;
  const leaders = Array.isArray(snapshot.leaders) ? snapshot.leaders.slice(0, 5) as Array<Record<string, unknown>> : [];
  const laggards = Array.isArray(snapshot.laggards) ? snapshot.laggards.slice(0, 5) as Array<Record<string, unknown>> : [];

  let bottomLine = "Raven is collecting outcome data, but there is not enough signal history yet to judge the edge.";
  if (signals > 0 && avgLatest !== null) {
    if (avgLatest > 0 && (winRate || 0) >= 50) {
      bottomLine = `Raven signals are positive in this window so far: average latest move ${pct(avgLatest)} with a ${winRate ?? "--"}% latest win rate.`;
    } else if (avgLatest > 0) {
      bottomLine = `Average latest move is positive at ${pct(avgLatest)}, but win rate is not strong enough yet. Keep paper-only until more outcomes mature.`;
    } else {
      bottomLine = `Signals are not proving edge in this window yet. Average latest move is ${pct(avgLatest)}, so do not loosen trading rules.`;
    }
  }

  return finalize({
    kind: "signal-truth",
    title: "Signal Truth Audit",
    subtitle: "The proof layer: what happened after Raven scored signals.",
    status,
    generatedAt,
    window,
    bottomLine,
    stats: [
      { label: "Signals tracked", value: String(totals.signals) },
      { label: "Tracking", value: String(totals.tracking) },
      { label: "Complete 5d", value: String(totals.complete) },
      { label: "Avg latest", value: pct(totals.avgLatestReturn), tone: avgLatest !== null && avgLatest >= 0 ? "good" : "bad" },
      { label: "Avg 1d", value: pct(totals.avgOneDayReturn) },
      { label: "Win rate", value: totals.winRateLatest === null ? "--" : `${totals.winRateLatest}%` }
    ],
    sections: [
      {
        title: "What matters",
        items: [
          bestSource ? `Top source by count is ${bestSource.name || "unknown"} with ${bestSource.count || 0} tracked signal(s) and average latest return ${pct(bestSource.avg_latest_return)}.` : "No source breakdown yet.",
          bestAction ? `Most common action is ${bestAction.name || "unknown"} with ${bestAction.count || 0} signal(s).` : "No action breakdown yet.",
          "This report should decide whether Raven deserves more sources or tighter rules. Do not use it as a live-trading trigger."
        ]
      },
      {
        title: "Best latest moves",
        items: leaders.length ? leaders.map((row) => `${row.ticker || "?"} | ${row.source || "source"} | ${row.action || "action"} | score ${row.final_score || "--"} | latest ${pct(row.latest_return_percent)} | 1d ${pct(row.one_day_return_percent)}`) : ["No winners recorded yet."]
      },
      {
        title: "Worst latest moves",
        items: laggards.length ? laggards.map((row) => `${row.ticker || "?"} | ${row.source || "source"} | ${row.action || "action"} | score ${row.final_score || "--"} | latest ${pct(row.latest_return_percent)} | 1d ${pct(row.one_day_return_percent)}`) : ["No laggards recorded yet."]
      },
      {
        title: "Suggested next move",
        items: [
          signals < 20 ? "Collect more outcomes before changing rules." : "Start reviewing which source/action buckets deserve stricter or looser thresholds.",
          "Keep live trading disabled. Paper and shadow results still need proof."
        ]
      }
    ],
    rawJsonHref: `/api/signals/truth?window=${window}&sync=1`,
    oldTextHref: `/api/signals/truth/report?window=${window}&sync=1`
  });
}

export async function buildPerformanceOperatorReport(window = "24h"): Promise<OperatorReport> {
  const snapshot = await getPerformanceSnapshot(window);
  const text = buildPerformanceReport(snapshot);
  const generatedAt = new Date().toISOString();
  const totals = (snapshot as Record<string, any>).totals || {};
  const ok = Boolean((snapshot as Record<string, any>).ok);
  const runs = num(totals.runs ?? (snapshot as Record<string, any>).runs?.total);
  const failed = num(totals.failedRuns ?? (snapshot as Record<string, any>).runs?.failed);
  const signals = num(totals.signalsScored ?? (snapshot as Record<string, any>).signals?.scored);

  return finalize({
    kind: "performance",
    title: "Performance Brief",
    subtitle: "Pipeline and paper-trading health in plain English.",
    status: !ok || failed > 0 ? "needs_attention" : runs === 0 ? "watch" : "ok",
    generatedAt,
    window,
    bottomLine: !ok
      ? "Performance reporting could not load cleanly. Use the old text report for the exact error."
      : runs === 0
        ? "No pipeline runs were found in this window. That may be normal outside cron hours, but check cron if this is during market time."
        : failed > 0
          ? `Raven ran ${runs} time(s), but ${failed} run(s) failed. Check failed steps before trusting the scanner.`
          : `Raven ran ${runs} time(s) in this window without obvious failed-run pressure. ${signals} signal(s) were scored.`,
    stats: [
      { label: "Runs", value: String(runs) },
      { label: "Failed runs", value: String(failed), tone: failed > 0 ? "bad" : "good" },
      { label: "Signals scored", value: String(signals) }
    ],
    sections: [
      { title: "Operator read", items: lineItems(text, 10) },
      { title: "Suggested next move", items: [failed > 0 ? "Fix the failed step before increasing cadence or adding sources." : "Use Signal Truth next to see whether these runs created useful outcomes."] }
    ],
    rawJsonHref: `/api/performance?window=${window}`,
    oldTextHref: `/api/performance/report?window=${window}`
  });
}

export async function buildCronOperatorReport(): Promise<OperatorReport> {
  const snapshot = await getCronStatusSnapshot();
  const text = buildCronStatusReport(snapshot);
  const generatedAt = new Date().toISOString();
  const latest = snapshot.latestRun;
  const stale = latest ? latest.ageMinutes > 45 && snapshot.expected.inWindow : true;

  return finalize({
    kind: "cron",
    title: "Cron Health Brief",
    subtitle: "Whether Raven is actually running when it should.",
    status: stale ? "needs_attention" : "ok",
    generatedAt,
    bottomLine: latest
      ? stale
        ? `Latest stored run is ${latest.ageMinutes} minutes old during/near the cron window. Check Vercel cron if this stays stale.`
        : `Latest stored run is ${latest.ageMinutes} minutes old and cron health looks acceptable.`
      : "No stored Raven runs were found yet.",
    stats: [
      { label: "Cron window", value: snapshot.expected.inWindow ? "Inside" : "Outside" },
      { label: "Latest age", value: latest ? `${latest.ageMinutes}m` : "none", tone: stale ? "bad" : "good" },
      { label: "Steps failed", value: latest ? String(latest.stepsFailed) : "--", tone: latest && latest.stepsFailed > 0 ? "bad" : "good" },
      { label: "Next expected", value: snapshot.expected.nextExpectedRunInMinutes === null ? "unknown" : `${snapshot.expected.nextExpectedRunInMinutes}m` }
    ],
    sections: [
      { title: "Diagnosis", items: snapshot.diagnosis.length ? snapshot.diagnosis : ["No diagnosis messages."] },
      { title: "Recent runs", items: snapshot.recentRuns.length ? snapshot.recentRuns.slice(0, 6).map((run) => `#${run.id} | ${run.status} | age ${run.ageMinutes}m | AI ${run.aiClassified} | scored ${run.signalsScored}`) : ["No recent runs stored."] }
    ],
    rawJsonHref: "/api/cron/status",
    oldTextHref: "/api/cron/status/report"
  });
}

export async function buildAiUsageOperatorReport(window = "24h"): Promise<OperatorReport> {
  const snapshot = await getAiUsageSnapshot(window);
  const text = await getAiUsageReport(window);
  const generatedAt = new Date().toISOString();
  const calls = (snapshot as Record<string, any>).calls || {};
  const tokens = (snapshot as Record<string, any>).tokens || {};
  const cost = (snapshot as Record<string, any>).cost || {};
  const failed = num(calls.failed);
  const total = num(calls.total);

  return finalize({
    kind: "ai-usage",
    title: "AI Usage Brief",
    subtitle: "Groq call volume, failures, and cost pressure.",
    status: failed > 0 ? "needs_attention" : total === 0 ? "watch" : "ok",
    generatedAt,
    window,
    bottomLine: failed > 0
      ? `${failed} AI call(s) failed in this window. Check the recent errors before trusting classifications.`
      : total === 0
        ? "No AI calls were logged in this window. That is normal if Raven did not find fresh items to classify."
        : `AI usage looks clean: ${total} call(s), ${num(tokens.total).toLocaleString()} token(s), estimated cost ${cost.display || "--"}.`,
    stats: [
      { label: "Calls", value: String(total) },
      { label: "Failed", value: String(failed), tone: failed > 0 ? "bad" : "good" },
      { label: "Tokens", value: num(tokens.total).toLocaleString() },
      { label: "Cost", value: cost.display || "--" }
    ],
    sections: [
      { title: "Operator read", items: lineItems(text, 12) },
      { title: "Suggested next move", items: [failed > 0 ? "Fix provider/API issues before increasing AI usage." : "Keep AI as analyst only. Signal Truth should decide whether the analysis is useful."] }
    ],
    rawJsonHref: `/api/ai/usage?window=${window}`,
    oldTextHref: `/api/ai/usage/report?window=${window}`
  });
}

export async function buildPaperPlanOperatorReport(): Promise<OperatorReport> {
  const plan = await getPaperTradePlan(10);
  const text = await getPaperTradePlanTextReport(8);
  const generatedAt = new Date().toISOString();
  const eligible = num((plan as Record<string, any>).eligible);
  const rejected = num((plan as Record<string, any>).rejected);

  return finalize({
    kind: "paper-plan",
    title: "Paper Trade Plan Brief",
    subtitle: "What Raven would trade and what it rejected.",
    status: eligible > 0 ? "watch" : "ok",
    generatedAt,
    bottomLine: eligible > 0
      ? `Raven found ${eligible} paper-eligible candidate(s). Review them before enabling any execution switch.`
      : `No paper-eligible candidates right now. ${rejected} candidate(s) were rejected by the planner.`,
    stats: [
      { label: "Eligible", value: String(eligible), tone: eligible > 0 ? "watch" : "good" },
      { label: "Rejected", value: String(rejected) },
      { label: "Reviewed", value: String(num((plan as Record<string, any>).candidatesReviewed)) }
    ],
    sections: [
      { title: "Planner notes", items: lineItems(text, 14) },
      { title: "Suggested next move", items: ["Use Signal Truth to see whether rejected candidates later became winners before loosening planner rules."] }
    ],
    rawJsonHref: "/api/paper/plan",
    oldTextHref: "/api/paper/plan/report"
  });
}

export async function buildPaperAccountOperatorReport(): Promise<OperatorReport> {
  const snapshot = await getAlpacaPaperSnapshot(20);
  const text = await getAlpacaPaperTextReport();
  const generatedAt = new Date().toISOString();
  const summary = (snapshot as Record<string, any>).summary || {};
  const positions = Array.isArray((snapshot as Record<string, any>).positions) ? (snapshot as Record<string, any>).positions : [];

  return finalize({
    kind: "paper-account",
    title: "Paper Account Brief",
    subtitle: "Alpaca paper balance, positions, and order state.",
    status: (snapshot as Record<string, any>).ok === false ? "needs_attention" : "ok",
    generatedAt,
    bottomLine: (snapshot as Record<string, any>).ok === false
      ? "Alpaca paper account could not be read. Check Alpaca environment variables."
      : `Paper account loaded with ${positions.length} open position(s). Equity: ${money(summary.equity)}.`,
    stats: [
      { label: "Equity", value: money(summary.equity) },
      { label: "Cash", value: money(summary.cash) },
      { label: "Positions", value: String(positions.length) }
    ],
    sections: [
      { title: "Account details", items: lineItems(text, 14) },
      { title: "Suggested next move", items: ["Keep this as read-only unless the paper execution switch is intentionally enabled."] }
    ],
    rawJsonHref: "/api/paper/account",
    oldTextHref: "/api/paper/report"
  });
}

export async function buildTextOnlyOperatorReport(kind: ReportKind): Promise<OperatorReport> {
  switch (kind) {
    case "paper-risk":
      return fromTextReport({ kind, title: "Paper Risk Brief", subtitle: "Risk limits and safety settings.", bottomLine: "Risk limits are the guardrails. Treat this as the checklist before any execution work.", textReport: await getPaperRiskTextReport(), rawJsonHref: "/api/paper/risk", oldTextHref: "/api/paper/risk/report", status: "watch" });
    case "paper-execution":
      return fromTextReport({ kind, title: "Paper Execution Brief", subtitle: "Execution switch status and paper-order readiness.", bottomLine: "This report tells you whether Raven is allowed to submit paper orders. Live trading remains off.", textReport: await getPaperExecutionTextReport(), rawJsonHref: "/api/paper/execute", oldTextHref: "/api/paper/execute/report", status: "watch" });
    case "paper-lifecycle":
      return fromTextReport({ kind, title: "Paper Lifecycle Brief", subtitle: "Open position lifecycle and exit review.", bottomLine: "Use this to see whether paper positions need exits, updates, or review.", textReport: await getPaperLifecycleTextReport(), rawJsonHref: "/api/paper/lifecycle", oldTextHref: "/api/paper/lifecycle/report" });
    case "ai-router":
      return fromTextReport({ kind, title: "AI Router Brief", subtitle: "AI routing and budget behavior.", bottomLine: "This explains how Raven is deciding which AI model route to use.", textReport: await getAiRouterReport(), rawJsonHref: "/api/ai/router", oldTextHref: "/api/ai/router/report" });
    case "candidate-ranking":
      return fromTextReport({ kind, title: "Candidate Ranking Brief", subtitle: "Ranked candidates before deeper action.", bottomLine: "This is the candidate queue. Signal Truth decides whether this ranking logic is actually useful over time.", textReport: await getCandidateRankingReport(), rawJsonHref: "/api/candidates", oldTextHref: "/api/candidates/report" });
    case "market-anomalies":
      return fromTextReport({ kind, title: "Market Anomalies Brief", subtitle: "Unusual price and volume behavior.", bottomLine: "Market anomalies are interesting, but they need filing or context confirmation before becoming trade candidates.", textReport: await getMarketAnomalyReport(), rawJsonHref: "/api/market/anomalies", oldTextHref: "/api/market/anomalies/report" });
    default:
      return buildSignalTruthOperatorReport("7d");
  }
}

export async function buildOperatorReport(kindInput?: string | null, windowInput?: string | null): Promise<OperatorReport> {
  const kind = (kindInput || "signal-truth") as ReportKind;
  const window = windowInput || undefined;

  switch (kind) {
    case "signal-truth":
      return buildSignalTruthOperatorReport(window || "7d");
    case "performance":
      return buildPerformanceOperatorReport(window || "24h");
    case "cron":
      return buildCronOperatorReport();
    case "ai-usage":
      return buildAiUsageOperatorReport(window || "24h");
    case "paper-account":
      return buildPaperAccountOperatorReport();
    case "paper-plan":
      return buildPaperPlanOperatorReport();
    case "paper-risk":
    case "paper-execution":
    case "paper-lifecycle":
    case "ai-router":
    case "candidate-ranking":
    case "market-anomalies":
      return buildTextOnlyOperatorReport(kind);
    default:
      return buildSignalTruthOperatorReport("7d");
  }
}
