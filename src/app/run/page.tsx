import Link from "next/link";
import { runRavenPipeline } from "@/lib/pipeline";
import RunResultClient from "./RunResultClient";

export const dynamic = "force-dynamic";

type RunSearchParams = {
  execute?: string;
} | Promise<{
  execute?: string;
}>;

type Step = {
  name: string;
  ok: boolean;
  durationMs: number;
  result?: any;
  error?: string;
};

type RunResult = {
  ok: boolean;
  phase: string;
  startedAt: string;
  finishedAt: string;
  liveTrading: "disabled";
  summary: {
    steps: number;
    failed: number;
    paperTradesOpened: number;
    paperTradesClosed: number;
  };
  steps: Step[];
};

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function duration(ms: number | null | undefined) {
  if (!ms || !Number.isFinite(ms)) return "--";
  return `${(ms / 1000).toFixed(1)}s`;
}

function step(result: RunResult | null, name: string) {
  return result?.steps.find((item) => item.name === name) || null;
}

function listTickers(items: Array<{ ticker?: string }> | undefined, limit = 8) {
  const tickers = Array.from(new Set((items || []).map((item) => item.ticker).filter(Boolean).map(String)));
  if (!tickers.length) return "None";
  const shown = tickers.slice(0, limit).join(", ");
  return tickers.length > limit ? `${shown}, +${tickers.length - limit} more` : shown;
}

function buildReadable(result: RunResult) {
  const failed = result.steps.filter((item) => !item.ok);
  const seeder = step(result, "paper_candidate_seeder")?.result;
  const engine = step(result, "paper_trade_engine")?.result;
  const execution = step(result, "paper_order_execution")?.result;
  const review = step(result, "paper_trade_review")?.result;
  const market = step(result, "market_anomalies")?.result;
  const router = step(result, "ai_budget_router")?.result;
  const classify = step(result, "ai_classify_one")?.result;
  const truth = step(result, "signal_truth_sync")?.result;

  const submittedOrder = execution?.submittedOrder || null;
  const selectedPlan = execution?.selectedPlan || null;
  const seededCandidates = Array.isArray(seeder?.candidates) ? seeder.candidates : [];
  const internalTrades = Array.isArray(engine?.trades) ? engine.trades : [];
  const rejects = Array.isArray(engine?.rejects) ? engine.rejects : [];
  const open = Array.isArray(review?.open) ? review.open : [];
  const anomalies = Array.isArray(market?.anomalies) ? market.anomalies : [];

  const bottomLine = failed.length
    ? `Run finished with ${failed.length} failed step${failed.length === 1 ? "" : "s"}. Check the attention section before trusting the output.`
    : submittedOrder
      ? `Run completed clean and submitted an Alpaca paper order for ${submittedOrder.symbol || selectedPlan?.ticker || "a candidate"}.`
      : internalTrades.length
        ? `Run completed clean and opened ${internalTrades.length} internal paper trade${internalTrades.length === 1 ? "" : "s"}. No Alpaca paper order was submitted in this run.`
        : `Run completed clean, but no new paper trade was opened.`;

  return {
    bottomLine,
    stats: [
      { label: "Steps", value: String(result.summary.steps), tone: result.summary.failed ? "red" : "green" },
      { label: "Failed", value: String(result.summary.failed), tone: result.summary.failed ? "red" : "green" },
      { label: "Seeded candidates", value: String(seeder?.seeded ?? 0), tone: (seeder?.seeded ?? 0) > 0 ? "green" : "amber" },
      { label: "Internal paper opens", value: String(engine?.opened ?? 0), tone: (engine?.opened ?? 0) > 0 ? "green" : "amber" },
      { label: "Rejected", value: String(engine?.rejected ?? 0), tone: (engine?.rejected ?? 0) > 0 ? "amber" : "green" },
      { label: "Alpaca order", value: execution?.orderSubmission || "none", tone: execution?.orderSubmission === "submitted" ? "green" : "amber" },
      { label: "Open paper trades", value: String(open.length), tone: open.length ? "green" : "amber" },
      { label: "Groq classifications", value: String(classify?.classified ?? 0), tone: (classify?.classified ?? 0) > 0 ? "blue" : "amber" }
    ],
    sections: [
      {
        title: "What Raven found",
        items: [
          `Market anomalies: ${market?.anomalyCount ?? 0} (${listTickers(anomalies)})`,
          `Paper candidates seeded: ${seeder?.seeded ?? 0} (${listTickers(seededCandidates)})`,
          `AI candidates routed this run: ${router?.routed ?? 0}; skipped before Groq: ${router?.skipped ?? 0}.`,
          `Signal Truth sync: ${truth?.ok === false ? "needs attention" : "ok"}; created ${truth?.created ?? 0}, updated ${truth?.updated ?? 0}.`
        ]
      },
      {
        title: "What Raven traded",
        items: [
          `Internal paper trades opened: ${engine?.opened ?? 0} (${listTickers(internalTrades)})`,
          submittedOrder
            ? `Alpaca paper order submitted: ${submittedOrder.symbol || selectedPlan?.ticker || "unknown"} ${submittedOrder.side || "buy"} ${submittedOrder.notional ? money(Number(submittedOrder.notional)) : selectedPlan?.suggestedNotional ? money(Number(selectedPlan.suggestedNotional)) : ""} ${submittedOrder.status ? `(${submittedOrder.status})` : ""}`.trim()
            : `Alpaca paper order submitted: none (${execution?.orderSubmission || "not run"}).`,
          selectedPlan ? `Selected Alpaca plan: ${selectedPlan.ticker} | score ${selectedPlan.score}/100 | notional ${money(selectedPlan.suggestedNotional)} | stop ${money(selectedPlan.stopPrice)} | target ${money(selectedPlan.targetPrice)}.` : "Selected Alpaca plan: none.",
          `Paper review still open: ${open.length}. Closed this review: ${review?.closed ?? 0}.`
        ]
      },
      {
        title: "What Raven rejected",
        items: rejects.length
          ? rejects.slice(0, 6).map((reject: any) => `${reject.ticker || "UNKNOWN"} | score ${reject.score ?? "?"} | ${(reject.rejects || []).join(", ") || "rejected"}`)
          : ["No new paper candidates were rejected by the internal paper engine in this run."]
      },
      {
        title: "Needs attention",
        items: [
          ...failed.map((item) => `${item.name}: ${item.error || "step failed"}`),
          ...(execution?.errors || []).slice(0, 5).map((item: any) => `Paper execution: ${item.error || JSON.stringify(item)}`),
          ...((truth?.errors || []) as any[]).slice(0, 5).map((item: any) => `Signal truth: ${item.error || JSON.stringify(item)}`),
          failed.length || (execution?.errors || []).length || (truth?.errors || []).length ? "Review the raw JSON below if you need the exact payload." : "Nothing urgent in this run."
        ]
      }
    ]
  };
}

export default async function RunPage({ searchParams }: { searchParams?: RunSearchParams }) {
  const params = searchParams ? await Promise.resolve(searchParams) : {};
  const shouldExecute = params.execute === "1" || params.execute === "true";
  const result = shouldExecute ? await runRavenPipeline() as RunResult : null;
  const readable = result ? buildReadable(result) : null;
  const rawJson = result ? JSON.stringify(result, null, 2) : "{}";

  return (
    <main className="raven-shell readable-shell run-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">R</div>
          <div>
            <div className="brand-title">RAVEN</div>
            <div className="brand-subtitle">manual run</div>
          </div>
        </div>
        <nav className="nav" aria-label="Raven navigation">
          <Link className="nav-item" href="/">Dashboard <span className="nav-pill">live</span></Link>
          <Link className="nav-item" href="/reports">Reports <span className="nav-pill">hub</span></Link>
          <a className="nav-item" href="/api/run/pipeline">Raw run <span className="nav-pill">json</span></a>
        </nav>
        <div className="sidebar-footer compact-status">
          <div><span>Mode</span><strong>Readable</strong></div>
          <div><span>Live</span><strong>OFF</strong></div>
          <div><span>Orders</span><strong>Paper</strong></div>
        </div>
      </aside>

      <section className="main readable-main">
        <div className="topbar">
          <div>
            <div className="eyebrow">Manual run</div>
            <h1>Run Raven now</h1>
          </div>
          <div className="top-actions">
            <Link className="badge blue" href="/reports">Reports</Link>
            <a className="badge green" href="/run?execute=1">Run again</a>
            <a className="badge blue" href="/api/run/pipeline">Raw JSON endpoint</a>
          </div>
        </div>

        {!result || !readable ? (
          <section className="panel readable-hero">
            <div className="panel-header">
              <div>
                <div className="panel-title">Ready</div>
                <div className="panel-meta">This page runs Raven and turns the result into an operator summary.</div>
              </div>
              <span className="badge blue">manual</span>
            </div>
            <p className="readable-bottom-line">Click Run Raven to start the pipeline. The raw JSON endpoint remains available for debugging.</p>
            <div className="readable-action-row">
              <a className="report-choice primary mini" href="/run?execute=1"><span>Run Raven</span><small>show readable summary after it finishes</small></a>
              <a className="report-choice mini" href="/api/run/pipeline"><span>Raw JSON endpoint</span><small>old behavior, kept intact</small></a>
            </div>
          </section>
        ) : (
          <>
            <section className="panel readable-hero">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Bottom line</div>
                  <div className="panel-meta">Started {result.startedAt} · finished {result.finishedAt}</div>
                </div>
                <span className={`badge ${result.summary.failed ? "red" : "green"}`}>{result.summary.failed ? "needs attention" : "ok"}</span>
              </div>
              <p className="readable-bottom-line">{readable.bottomLine}</p>
              <div className="readable-meta-row">
                <span>Total duration: {duration(new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime())}</span>
                <span>Live trading: disabled</span>
              </div>
            </section>

            <section className="panel readable-panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Key numbers</div>
                  <div className="panel-meta">Fast read before the details.</div>
                </div>
              </div>
              <div className="readable-stat-grid">
                {readable.stats.map((stat) => (
                  <div className={`readable-stat ${stat.tone || ""}`} key={stat.label}>
                    <span>{stat.label}</span>
                    <strong>{stat.value}</strong>
                  </div>
                ))}
              </div>
            </section>

            <div className="readable-sections">
              {readable.sections.map((section) => (
                <section className="panel readable-panel" key={section.title}>
                  <div className="panel-header">
                    <div><div className="panel-title">{section.title}</div></div>
                  </div>
                  <ul className="readable-list">
                    {section.items.map((item: string, index: number) => <li key={`${section.title}-${index}`}>{item}</li>)}
                  </ul>
                </section>
              ))}
            </div>

            <RunResultClient rawJson={rawJson} />
          </>
        )}
      </section>
    </main>
  );
}
