import Link from "next/link";
import { buildOperatorReport } from "@/lib/reportNarratives";

export const dynamic = "force-dynamic";

type ReadableSearchParams = {
  kind?: string;
  window?: string;
} | Promise<{
  kind?: string;
  window?: string;
}>;

function statusLabel(status: string) {
  if (status === "needs_attention") return "needs attention";
  return status;
}

export default async function ReadableReportPage({ searchParams }: { searchParams?: ReadableSearchParams }) {
  const params = searchParams ? await Promise.resolve(searchParams) : {};
  const report = await buildOperatorReport(params.kind, params.window);

  return (
    <main className="raven-shell readable-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">R</div>
          <div>
            <div className="brand-title">RAVEN</div>
            <div className="brand-subtitle">operator report</div>
          </div>
        </div>

        <nav className="nav" aria-label="Raven navigation">
          <Link className="nav-item" href="/">Dashboard <span className="nav-pill">live</span></Link>
          <Link className="nav-item" href="/reports">Reports <span className="nav-pill">hub</span></Link>
          {report.rawJsonHref ? <a className="nav-item" href={report.rawJsonHref}>Raw JSON <span className="nav-pill">debug</span></a> : null}
          {report.oldTextHref ? <a className="nav-item" href={report.oldTextHref}>Old text <span className="nav-pill">legacy</span></a> : null}
        </nav>

        <div className="sidebar-footer compact-status">
          <div><span>Status</span><strong>{statusLabel(report.status)}</strong></div>
          <div><span>Mode</span><strong>Readable</strong></div>
          <div><span>Live</span><strong>OFF</strong></div>
        </div>
      </aside>

      <section className="main readable-main">
        <div className="topbar">
          <div>
            <div className="eyebrow">Readable report</div>
            <h1>{report.title}</h1>
          </div>
          <div className="top-actions">
            <Link className="badge blue" href="/reports">Reports</Link>
            {report.rawJsonHref ? <a className="badge green" href={report.rawJsonHref}>Raw JSON</a> : null}
          </div>
        </div>

        <section className="panel readable-hero">
          <div className="panel-header">
            <div>
              <div className="panel-title">Bottom line</div>
              <div className="panel-meta">{report.subtitle}</div>
            </div>
            <span className={`badge ${report.status === "ok" ? "green" : report.status === "needs_attention" ? "red" : "amber"}`}>{statusLabel(report.status)}</span>
          </div>
          <p className="readable-bottom-line">{report.bottomLine}</p>
          <div className="readable-meta-row">
            <span>Generated: {report.generatedAt}</span>
            {report.window ? <span>Window: {report.window}</span> : null}
          </div>
        </section>

        {report.stats.length ? (
          <section className="panel readable-panel">
            <div className="panel-header">
              <div>
                <div className="panel-title">Key numbers</div>
                <div className="panel-meta">Fast read before the details.</div>
              </div>
            </div>
            <div className="readable-stat-grid">
              {report.stats.map((stat) => (
                <div className={`readable-stat ${stat.tone || ""}`} key={stat.label}>
                  <span>{stat.label}</span>
                  <strong>{stat.value}</strong>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="readable-sections">
          {report.sections.map((section) => (
            <section className="panel readable-panel" key={section.title}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">{section.title}</div>
                </div>
              </div>
              <ul className="readable-list">
                {section.items.map((item, index) => (
                  <li key={`${section.title}-${index}`}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <section className="panel readable-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Copy for ChatGPT or notes</div>
              <div className="panel-meta">This is the same readable brief in plain text.</div>
            </div>
          </div>
          <pre className="readable-copy-block">{report.copyText}</pre>
          <div className="readable-action-row">
            {report.rawJsonHref ? <a className="report-choice mini" href={report.rawJsonHref}><span>Open raw JSON</span><small>for ChatGPT/debugging</small></a> : null}
            {report.oldTextHref ? <a className="report-choice mini" href={report.oldTextHref}><span>Open old text report</span><small>legacy endpoint</small></a> : null}
          </div>
        </section>
      </section>
    </main>
  );
}
