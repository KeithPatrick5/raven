"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type ReportButton = {
  label: string;
  kind?: string;
  href?: string;
  jsonHref?: string;
  textHref?: string;
  window?: string;
  tone?: "green" | "blue" | "amber" | "red";
  note?: string;
  mode?: "modal" | "direct";
};

type ReportGroup = {
  title: string;
  meta: string;
  buttons: ReportButton[];
};

type TruthSummary = {
  ok: boolean;
  totals: {
    signals: number;
    tracking: number;
    complete: number;
    avgLatestReturn: number | null;
    avgOneDayReturn: number | null;
    winRateLatest: number | null;
  };
} | null;

const truthWindows = ["24h", "7d", "30d", "all"];
const performanceWindows = ["1h", "6h", "12h", "24h", "7d"];
const aiWindows = ["1h", "24h", "7d"];

function cleanPct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function readableHref(button: ReportButton) {
  if (button.kind) {
    const params = new URLSearchParams({ kind: button.kind });
    if (button.window) params.set("window", button.window);
    return `/reports/readable?${params.toString()}`;
  }
  return button.href || "#";
}

function reportButton(label: string, kind: string, textHref: string, jsonHref: string, window?: string, note?: string, tone: ReportButton["tone"] = "blue"): ReportButton {
  return { label, kind, textHref, jsonHref, window, note, tone, mode: "modal" };
}

function directButton(label: string, href: string, note?: string, tone: ReportButton["tone"] = "amber"): ReportButton {
  return { label, href, note, tone, mode: "direct" };
}

function ActionModal({ button, onClose }: { button: ReportButton; onClose: () => void }) {
  const human = readableHref(button);
  const json = button.jsonHref || button.href || "#";
  const oldText = button.textHref || button.href || "#";
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${json}`);
    } catch {
      // Browser clipboard permissions can fail. The link still opens normally.
    }
  };

  return (
    <div className="report-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="report-modal" role="dialog" aria-modal="true" aria-label="Choose report format" onClick={(event) => event.stopPropagation()}>
        <div className="report-modal-head">
          <div>
            <div className="eyebrow">Choose format</div>
            <h2>{button.label}</h2>
            <p>{button.note || "Pick the readable operator version or the raw data/debug version."}</p>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>×</button>
        </div>

        <div className="report-choice-grid">
          <a className="report-choice primary" href={human}>
            <span>Readable Summary</span>
            <small>Plain-English operator brief for you. Bottom line, key numbers, what matters, and next move.</small>
          </a>
          <a className="report-choice" href={json}>
            <span>Raw JSON / ChatGPT Debug</span>
            <small>Machine-readable data for deeper analysis, debugging, or sending back into ChatGPT.</small>
          </a>
          <a className="report-choice" href={oldText}>
            <span>Old Text Report</span>
            <small>Original text endpoint, kept intact so old reporting does not break.</small>
          </a>
          <button className="report-choice button-reset" type="button" onClick={copyJson}>
            <span>Copy JSON Link</span>
            <small>Copies the raw endpoint URL so you can paste it somewhere else.</small>
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportCard({ group, onPick }: { group: ReportGroup; onPick: (button: ReportButton) => void }) {
  return (
    <section className="panel report-panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">{group.title}</div>
          <div className="panel-meta">{group.meta}</div>
        </div>
      </div>
      <div className="report-button-grid">
        {group.buttons.map((button) => {
          const className = `report-button ${button.tone || "blue"}`;
          if (button.mode === "direct" || !button.kind) {
            return (
              <a className={className} href={button.href || "#"} key={`${button.label}-${button.href}`}>
                <span>{button.label}</span>
                {button.note ? <small>{button.note}</small> : null}
              </a>
            );
          }
          return (
            <button className={`${className} report-button-reset`} type="button" onClick={() => onPick(button)} key={`${button.label}-${button.kind}-${button.window}`}>
              <span>{button.label}</span>
              {button.note ? <small>{button.note}</small> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default function ReportsClient({ truth }: { truth: TruthSummary }) {
  const [selected, setSelected] = useState<ReportButton | null>(null);
  const groups = useMemo<ReportGroup[]>(() => [
    {
      title: "Quick reports",
      meta: "The reports you will actually use most often. Click once, then choose readable or raw.",
      buttons: [
        directButton("Run Raven now", "/api/run/report?run=1", "manual run + text report", "green"),
        reportButton("Latest performance", "performance", "/api/performance/report?window=24h", "/api/performance?window=24h", "24h", "operator health", "blue"),
        reportButton("Cron health", "cron", "/api/cron/status/report", "/api/cron/status", undefined, "schedule + last run", "blue"),
        reportButton("Signal Truth 7d", "signal-truth", "/api/signals/truth/report?window=7d&sync=1", "/api/signals/truth?window=7d&sync=1", "7d", "prove the edge", "green"),
        reportButton("Paper account", "paper-account", "/api/paper/report", "/api/paper/account", undefined, "Alpaca paper snapshot", "blue"),
        reportButton("Paper plan", "paper-plan", "/api/paper/plan/report", "/api/paper/plan", undefined, "would-trade + rejects", "blue"),
        reportButton("Safety / risk", "paper-risk", "/api/paper/risk/report", "/api/paper/risk", undefined, "limits + guardrails", "amber"),
        reportButton("AI usage 24h", "ai-usage", "/api/ai/usage/report?window=24h", "/api/ai/usage?window=24h", "24h", "Groq cost/usage", "blue")
      ]
    },
    {
      title: "Signal truth audit",
      meta: "Outcome tracking by source, action, score bucket, and later price moves.",
      buttons: truthWindows.map((window) => reportButton(`Truth ${window}`, "signal-truth", `/api/signals/truth/report?window=${window}&sync=1`, `/api/signals/truth?window=${window}&sync=1`, window, "readable or raw", window === "7d" ? "green" : "blue"))
    },
    {
      title: "Performance windows",
      meta: "Existing performance reports, kept intact, now easier to read.",
      buttons: performanceWindows.map((window) => reportButton(`Performance ${window}`, "performance", `/api/performance/report?window=${window}`, `/api/performance?window=${window}`, window, "readable or raw"))
    },
    {
      title: "Paper trading",
      meta: "Paper account, planning, risk, execution switch, lifecycle, and debug JSON.",
      buttons: [
        reportButton("Paper account", "paper-account", "/api/paper/report", "/api/paper/account"),
        reportButton("Trade plan", "paper-plan", "/api/paper/plan/report", "/api/paper/plan"),
        reportButton("Risk limits", "paper-risk", "/api/paper/risk/report", "/api/paper/risk", undefined, "guardrails", "amber"),
        reportButton("Execution switch", "paper-execution", "/api/paper/execute/report", "/api/paper/execute", undefined, "paper orders only", "amber"),
        reportButton("Lifecycle", "paper-lifecycle", "/api/paper/lifecycle/report", "/api/paper/lifecycle"),
        directButton("Decisions JSON", "/api/paper/decisions", "debug data"),
        directButton("Trades JSON", "/api/paper/trades", "debug data"),
        directButton("Positions JSON", "/api/paper/positions", "debug data"),
        directButton("Orders JSON", "/api/paper/orders", "debug data")
      ]
    },
    {
      title: "AI and intelligence",
      meta: "AI budget, candidates, market anomalies, radar, and signal events.",
      buttons: [
        ...aiWindows.map((window) => reportButton(`AI usage ${window}`, "ai-usage", `/api/ai/usage/report?window=${window}`, `/api/ai/usage?window=${window}`, window, "readable or raw")),
        reportButton("AI router", "ai-router", "/api/ai/router/report", "/api/ai/router"),
        reportButton("Candidate ranking", "candidate-ranking", "/api/candidates/report", "/api/candidates"),
        reportButton("Market anomalies", "market-anomalies", "/api/market/anomalies/report", "/api/market/anomalies"),
        directButton("Radar JSON", "/api/radar", "debug data"),
        directButton("Radar discovery JSON", "/api/radar/discover", "debug data"),
        directButton("Signal events JSON", "/api/signals/events", "debug data")
      ]
    },
    {
      title: "Advanced manual tools",
      meta: "Manual scan/debug endpoints. Use when you are testing a source or forcing a step.",
      buttons: [
        directButton("SEC watchlist scan", "/api/scan/sec"),
        directButton("SEC discovery scan", "/api/scan/sec-discovery"),
        directButton("FINRA scan", "/api/scan/finra"),
        directButton("Federal Register scan", "/api/scan/federal-register"),
        directButton("FDA scan", "/api/scan/fda"),
        directButton("Congress scan", "/api/scan/congress"),
        directButton("News scan", "/api/scan/news"),
        directButton("Classify SEC", "/api/classify/sec"),
        directButton("Alpaca confirm", "/api/confirm/alpaca"),
        directButton("Score signals", "/api/score/signals"),
        directButton("Telegram test", "/api/alert/telegram")
      ]
    }
  ], []);

  return (
    <main className="raven-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">R</div>
          <div>
            <div className="brand-title">RAVEN</div>
            <div className="brand-subtitle">reports</div>
          </div>
        </div>

        <nav className="nav" aria-label="Raven navigation">
          <Link className="nav-item" href="/">Dashboard <span className="nav-pill">live</span></Link>
          <Link className="nav-item active" href="/reports">Reports <span className="nav-pill">one-click</span></Link>
          <a className="nav-item" href="#truth">Signal truth <span className="nav-pill">audit</span></a>
          <a className="nav-item" href="#advanced">Advanced <span className="nav-pill">manual</span></a>
        </nav>

        <div className="sidebar-footer compact-status">
          <div><span>Live</span><strong>OFF</strong></div>
          <div><span>Mode</span><strong>Paper</strong></div>
          <div><span>Reports</span><strong>Readable</strong></div>
        </div>
      </aside>

      <section className="main">
        <div className="topbar">
          <div>
            <div className="eyebrow">Raven command</div>
            <h1>Reports</h1>
          </div>
          <div className="top-actions">
            <Link className="badge blue" href="/">Dashboard</Link>
            <a className="badge green" href="/api/run/report?run=1">Run now</a>
          </div>
        </div>

        <section className="panel truth-hero" id="truth">
          <div className="panel-header">
            <div>
              <div className="panel-title">Signal truth audit</div>
              <div className="panel-meta">The proof layer. Click the report and choose a readable summary or raw JSON.</div>
            </div>
            <span className="badge green">7d</span>
          </div>
          <div className="run-summary run-summary-tight">
            <div><span>Tracked</span><strong>{truth && truth.ok ? truth.totals.signals : 0}</strong></div>
            <div><span>Tracking</span><strong>{truth && truth.ok ? truth.totals.tracking : 0}</strong></div>
            <div><span>Complete 5d</span><strong>{truth && truth.ok ? truth.totals.complete : 0}</strong></div>
            <div><span>Avg latest</span><strong className={(truth?.ok && (truth.totals.avgLatestReturn || 0) >= 0) ? "text-green" : "text-red"}>{truth && truth.ok ? cleanPct(truth.totals.avgLatestReturn) : "--"}</strong></div>
            <div><span>Avg 1d</span><strong>{truth && truth.ok ? cleanPct(truth.totals.avgOneDayReturn) : "--"}</strong></div>
            <div><span>Win rate</span><strong>{truth && truth.ok && truth.totals.winRateLatest !== null ? `${truth.totals.winRateLatest}%` : "--"}</strong></div>
          </div>
          <div className="report-button-grid compact-report-grid">
            <button className="report-button green report-button-reset" type="button" onClick={() => setSelected(reportButton("Signal Truth 7d", "signal-truth", "/api/signals/truth/report?window=7d&sync=1", "/api/signals/truth?window=7d&sync=1", "7d", "operator brief + raw data", "green"))}>
              <span>Open Signal Truth 7d</span><small>choose readable or raw</small>
            </button>
            <a className="report-button blue" href="/api/signals/truth?window=7d&sync=1"><span>Open Signal Truth JSON</span><small>direct debug data</small></a>
          </div>
        </section>

        <div className="report-stack">
          {groups.map((group) => (
            <div id={group.title === "Advanced manual tools" ? "advanced" : undefined} key={group.title}>
              <ReportCard group={group} onPick={setSelected} />
            </div>
          ))}
        </div>
      </section>
      {selected ? <ActionModal button={selected} onClose={() => setSelected(null)} /> : null}
    </main>
  );
}
