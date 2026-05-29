import { getSignalTruthSnapshot } from "@/lib/signalTruth";

export const dynamic = "force-dynamic";

type ReportButton = {
  label: string;
  href: string;
  tone?: "green" | "blue" | "amber" | "red";
  note?: string;
};

type ReportGroup = {
  title: string;
  meta: string;
  buttons: ReportButton[];
};

const truthWindows = ["24h", "7d", "30d", "all"];
const performanceWindows = ["1h", "6h", "12h", "24h", "7d"];
const aiWindows = ["1h", "24h", "7d"];

function btn(button: ReportButton): ReportButton {
  return button;
}

function cleanPct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function reportCard(group: ReportGroup) {
  return (
    <section className="panel report-panel" key={group.title}>
      <div className="panel-header">
        <div>
          <div className="panel-title">{group.title}</div>
          <div className="panel-meta">{group.meta}</div>
        </div>
      </div>
      <div className="report-button-grid">
        {group.buttons.map((button) => (
          <a className={`report-button ${button.tone || "blue"}`} href={button.href} key={`${button.label}-${button.href}`}>
            <span>{button.label}</span>
            {button.note ? <small>{button.note}</small> : null}
          </a>
        ))}
      </div>
    </section>
  );
}

async function safeTruth() {
  try {
    return await getSignalTruthSnapshot("7d");
  } catch {
    return null;
  }
}

export default async function ReportsPage() {
  const truth = await safeTruth();
  const groups: ReportGroup[] = [
    {
      title: "Quick reports",
      meta: "The reports you will actually use most often.",
      buttons: [
        { label: "Run Raven now", href: "/api/run/report?run=1", tone: "green", note: "manual run + text report" },
        { label: "Latest run history", href: "/api/run/report", note: "stored pipeline runs" },
        { label: "Cron health", href: "/api/cron/status/report", note: "schedule + last run" },
        { label: "Performance 24h", href: "/api/performance/report?window=24h", note: "operator report" },
        { label: "Signal Truth 7d", href: "/api/signals/truth/report?window=7d&sync=1", tone: "green", note: "prove the edge" },
        { label: "Safety", href: "/api/trading/safety/report", tone: "amber", note: "kill switch + live status" },
        { label: "Paper account", href: "/api/paper/report", note: "Alpaca paper snapshot" },
        { label: "Paper lifecycle", href: "/api/paper/lifecycle/report", note: "open exits + position state" },
        { label: "AI usage 24h", href: "/api/ai/usage/report?window=24h", note: "Groq cost/usage" }
      ]
    },
    {
      title: "Signal truth audit",
      meta: "Outcome tracking by source, action, score bucket, and later price moves.",
      buttons: truthWindows.flatMap((window) => ([
        btn({ label: `Truth ${window}`, href: `/api/signals/truth/report?window=${window}&sync=1`, tone: window === "7d" ? "green" : "blue", note: "readable" }),
        btn({ label: `Truth ${window} JSON`, href: `/api/signals/truth?window=${window}&sync=1`, note: "debug" })
      ]))
    },
    {
      title: "Performance windows",
      meta: "Existing performance reports, kept intact, now one click away.",
      buttons: performanceWindows.flatMap((window) => ([
        btn({ label: `Performance ${window}`, href: `/api/performance/report?window=${window}`, note: "readable" }),
        btn({ label: `Performance ${window} JSON`, href: `/api/performance?window=${window}`, note: "debug" })
      ]))
    },
    {
      title: "Paper trading",
      meta: "Paper account, planning, risk, execution switch, lifecycle, and debug JSON.",
      buttons: [
        { label: "Paper account report", href: "/api/paper/report" },
        { label: "Paper account JSON", href: "/api/paper/account" },
        { label: "Trade plan report", href: "/api/paper/plan/report" },
        { label: "Trade plan JSON", href: "/api/paper/plan" },
        { label: "Risk limits", href: "/api/paper/risk/report", tone: "amber" },
        { label: "Execution report", href: "/api/paper/execute/report", tone: "amber" },
        { label: "Execution preview JSON", href: "/api/paper/execute" },
        { label: "Lifecycle report", href: "/api/paper/lifecycle/report" },
        { label: "Lifecycle JSON", href: "/api/paper/lifecycle" },
        { label: "Decisions JSON", href: "/api/paper/decisions" },
        { label: "Trades JSON", href: "/api/paper/trades" },
        { label: "Trade review JSON", href: "/api/paper/trades/review" },
        { label: "Positions JSON", href: "/api/paper/positions" },
        { label: "Orders JSON", href: "/api/paper/orders" }
      ]
    },
    {
      title: "AI and intelligence",
      meta: "AI budget, candidates, market anomalies, radar, and signal events.",
      buttons: [
        ...aiWindows.flatMap((window) => ([
          btn({ label: `AI usage ${window}`, href: `/api/ai/usage/report?window=${window}`, note: "readable" }),
          btn({ label: `AI usage ${window} JSON`, href: `/api/ai/usage?window=${window}`, note: "debug" })
        ])),
        { label: "AI router report", href: "/api/ai/router/report" },
        { label: "AI router JSON", href: "/api/ai/router" },
        { label: "Candidate ranking", href: "/api/candidates/report" },
        { label: "Candidates JSON", href: "/api/candidates" },
        { label: "Market anomalies", href: "/api/market/anomalies/report" },
        { label: "Market anomalies JSON", href: "/api/market/anomalies" },
        { label: "Radar JSON", href: "/api/radar" },
        { label: "Radar discovery JSON", href: "/api/radar/discover" },
        { label: "Signal events JSON", href: "/api/signals/events" }
      ]
    },
    {
      title: "Advanced manual tools",
      meta: "Manual scan/debug endpoints. Use when you are testing a source or forcing a step.",
      buttons: [
        { label: "SEC watchlist scan", href: "/api/scan/sec", tone: "amber" },
        { label: "SEC discovery scan", href: "/api/scan/sec-discovery", tone: "amber" },
        { label: "FINRA scan", href: "/api/scan/finra", tone: "amber" },
        { label: "Federal Register scan", href: "/api/scan/federal-register", tone: "amber" },
        { label: "FDA scan", href: "/api/scan/fda", tone: "amber" },
        { label: "Congress scan", href: "/api/scan/congress", tone: "amber" },
        { label: "News scan", href: "/api/scan/news", tone: "amber" },
        { label: "Classify SEC", href: "/api/classify/sec", tone: "amber" },
        { label: "Alpaca confirm", href: "/api/confirm/alpaca", tone: "amber" },
        { label: "Score signals", href: "/api/score/signals", tone: "amber" },
        { label: "Telegram test", href: "/api/alert/telegram", tone: "amber" }
      ]
    }
  ];

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
          <a className="nav-item" href="/">Dashboard <span className="nav-pill">live</span></a>
          <a className="nav-item active" href="/reports">Reports <span className="nav-pill">one-click</span></a>
          <a className="nav-item" href="#truth">Signal truth <span className="nav-pill">audit</span></a>
          <a className="nav-item" href="#advanced">Advanced <span className="nav-pill">manual</span></a>
        </nav>

        <div className="sidebar-footer compact-status">
          <div><span>Live</span><strong>OFF</strong></div>
          <div><span>Mode</span><strong>Paper</strong></div>
          <div><span>Reports</span><strong>Safe</strong></div>
        </div>
      </aside>

      <section className="main">
        <div className="topbar">
          <div>
            <div className="eyebrow">Raven command</div>
            <h1>Reports</h1>
          </div>
          <div className="top-actions">
            <a className="badge blue" href="/">Dashboard</a>
            <a className="badge green" href="/api/run/report?run=1">Run now</a>
          </div>
        </div>

        <section className="panel truth-hero" id="truth">
          <div className="panel-header">
            <div>
              <div className="panel-title">Signal truth audit</div>
              <div className="panel-meta">This is the new proof layer. It tracks what happened after Raven scored a signal.</div>
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
            <a className="report-button green" href="/api/signals/truth/report?window=7d&sync=1"><span>Open Signal Truth 7d</span><small>readable report</small></a>
            <a className="report-button blue" href="/api/signals/truth?window=7d&sync=1"><span>Open Signal Truth JSON</span><small>debug data</small></a>
          </div>
        </section>

        <div className="report-stack">
          {groups.map((group, index) => (
            <div id={group.title === "Signal truth audit" ? "truth-buttons" : group.title === "Advanced manual tools" ? "advanced" : undefined} key={group.title}>
              {reportCard(group)}
              {index === 0 ? <div className="section-spacer" /> : null}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
