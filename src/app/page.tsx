import { getLatestPaperDecisions, getLatestPaperTrades } from "@/lib/paper";
import { getLatestPipelineRuns } from "@/lib/pipelineRuns";
import { getLatestScoredSignals } from "@/lib/scoring";
import { watchlist } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

type Jsonish = string[] | string | null | undefined;

function scoreTone(score: number) {
  if (score >= 70) return "green";
  if (score >= 40) return "blue";
  if (score >= 20) return "amber";
  return "red";
}

function statusTone(status: string) {
  if (status === "completed") return "green";
  if (status === "needs_attention") return "amber";
  return "blue";
}

function parseList(value: Jsonish): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function shortDate(value: string | null | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function safeSignals() {
  try {
    return await getLatestScoredSignals(8);
  } catch {
    return [];
  }
}

async function safePaperTrades() {
  try {
    return await getLatestPaperTrades(8);
  } catch {
    return [];
  }
}

async function safePaperDecisions() {
  try {
    return await getLatestPaperDecisions(8);
  } catch {
    return [];
  }
}

async function safePipelineRuns() {
  try {
    return await getLatestPipelineRuns(5);
  } catch {
    return [];
  }
}

export default async function Home() {
  const [signals, paperTrades, paperDecisions, pipelineRuns] = await Promise.all([
    safeSignals(),
    safePaperTrades(),
    safePaperDecisions(),
    safePipelineRuns()
  ]);

  const latestRun = pipelineRuns[0];
  const openTrades = paperTrades.filter((trade) => trade.status === "open");
  const closedTrades = paperTrades.filter((trade) => trade.status === "closed");
  const rejectedDecisions = paperDecisions.filter((decision) => decision.decision === "reject");

  return (
    <main className="raven-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">R</div>
          <div>
            <div className="brand-title">RAVEN</div>
            <div className="brand-subtitle">signal engine</div>
          </div>
        </div>

        <nav className="nav" aria-label="Raven navigation">
          <a className="nav-item active" href="#overview">Overview <span className="nav-pill">live</span></a>
          <a className="nav-item" href="#signals">Signals <span className="nav-pill">{signals.length}</span></a>
          <a className="nav-item" href="#paper">Paper Trades <span className="nav-pill">{openTrades.length}</span></a>
          <a className="nav-item" href="#decisions">Decisions <span className="nav-pill">{paperDecisions.length}</span></a>
          <a className="nav-item" href="#watchlist">Watchlist <span className="nav-pill">{watchlist.length}</span></a>
          <a className="nav-item" href="#runs">Runs <span className="nav-pill">{pipelineRuns.length}</span></a>
        </nav>

        <div className="sidebar-footer">
          <strong>Live trading:</strong> disabled<br />
          <strong>Mode:</strong> paper only<br />
          <strong>Alerts:</strong> trade events only
        </div>
      </aside>

      <section className="main">
        <div className="topbar" id="overview">
          <div>
            <div className="eyebrow">Raven command</div>
            <h1>Private signal board</h1>
          </div>
          <div className="top-actions">
            <a className="badge green" href="/api/run/pipeline">Run pipeline</a>
            <a className="badge blue" href="/api/run/logs">Run logs</a>
            <a className="badge amber" href="/api/alert/telegram?mode=test">Test Telegram</a>
            <form action="/api/logout" method="post">
              <button className="ghost-button" type="submit">Lock</button>
            </form>
          </div>
        </div>

        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-label">Last run</div>
            <div className="kpi-value">{latestRun ? latestRun.status : "none"}</div>
            <div className="kpi-note">{latestRun ? `${shortDate(latestRun.created_at)} · ${seconds(latestRun.duration_ms)}` : "No pipeline runs logged"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Open trades</div>
            <div className="kpi-value">{openTrades.length}</div>
            <div className="kpi-note">{closedTrades.length} closed in recent log</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Latest score</div>
            <div className="kpi-value">{signals[0] ? signals[0].final_score : "--"}</div>
            <div className="kpi-note">{signals[0] ? `${signals[0].ticker} · ${signals[0].action}` : "No scored signals"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Live trading</div>
            <div className="kpi-value">OFF</div>
            <div className="kpi-note">Paper engine only</div>
          </div>
        </div>

        <div className="grid">
          <div className="left-stack">
            <section className="panel" id="signals">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Scored signals</div>
                  <div className="panel-meta">Latest Raven scores</div>
                </div>
                <a className="badge green" href="/api/score/signals">Score</a>
              </div>

              {signals.length > 0 ? (
                <div className="signal-list">
                  {signals.map((signal) => {
                    const reasons = parseList(signal.reason_codes as Jsonish);
                    const risks = parseList(signal.risk_flags as Jsonish);
                    return (
                      <article className="signal-card" key={signal.accession_number}>
                        <div className="signal-head">
                          <div>
                            <div className="signal-title">{signal.ticker} · {signal.category}</div>
                            <div className="panel-meta">{signal.direction} · {signal.market_confirmation} · {signal.action}</div>
                          </div>
                          <div className={`score ${scoreTone(signal.final_score)}`}>{signal.final_score}</div>
                        </div>
                        <p className="signal-copy">{signal.readable_summary}</p>
                        <div className="market-strip">
                          <span>{signal.form}</span>
                          <span>AI {signal.ai_tradeability}/100</span>
                          <span>{signal.risk_level} risk</span>
                        </div>
                        {reasons.length ? (
                          <ul className="compact-list">
                            {reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
                          </ul>
                        ) : null}
                        {risks[0] ? <p className="signal-copy"><strong>Risk:</strong> {risks[0]}</p> : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="console">No scored signals yet.</div>
              )}
            </section>

            <section className="panel" id="paper" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Paper trades</div>
                  <div className="panel-meta">Trades Raven actually opened</div>
                </div>
                <div className="top-actions">
                  <a className="badge green" href="/api/paper/trades">Evaluate</a>
                  <a className="badge blue" href="/api/paper/trades/review">Review</a>
                </div>
              </div>
              {paperTrades.length > 0 ? (
                <div className="signal-list">
                  {paperTrades.map((trade) => (
                    <article className="signal-card" key={trade.accession_number}>
                      <div className="signal-head">
                        <div>
                          <div className="signal-title">{trade.ticker} · {trade.side.toUpperCase()} · {trade.status}</div>
                          <div className="panel-meta">{shortDate(trade.opened_at)}</div>
                        </div>
                        <div className={`score ${scoreTone(trade.final_score)}`}>{trade.final_score}</div>
                      </div>
                      <div className="market-strip">
                        <span>entry {trade.entry_price}</span>
                        <span>stop {trade.stop_price}</span>
                        <span>target {trade.target_price}</span>
                        {trade.exit_price ? <span>exit {trade.exit_price}</span> : null}
                        {trade.pnl_percent ? <span>p/l {trade.pnl_percent}%</span> : null}
                      </div>
                      <p className="signal-copy">{trade.status === "closed" ? `${trade.outcome || "closed"}: ${trade.close_reason || "reviewed"}` : trade.decision_reason}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="console">No paper trades opened.</div>
              )}
            </section>
          </div>

          <div className="right-stack">
            <section className="panel" id="runs">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Pipeline status</div>
                  <div className="panel-meta">Latest run summary</div>
                </div>
                {latestRun ? <span className={`badge ${statusTone(latestRun.status)}`}>{latestRun.status}</span> : <span className="badge amber">no run</span>}
              </div>
              {latestRun ? (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      <tr><td>Duration</td><td>{seconds(latestRun.duration_ms)}</td></tr>
                      <tr><td>SEC filings</td><td>{latestRun.sec_filings_found} found · {latestRun.sec_filings_saved} new</td></tr>
                      <tr><td>AI classified</td><td>{latestRun.ai_classified}</td></tr>
                      <tr><td>Alpaca confirmed</td><td>{latestRun.alpaca_confirmed}</td></tr>
                      <tr><td>Signals scored</td><td>{latestRun.signals_scored}</td></tr>
                      <tr><td>Trades opened</td><td>{latestRun.paper_trades_opened}</td></tr>
                      <tr><td>Trades closed</td><td>{latestRun.paper_trades_closed}</td></tr>
                      <tr><td>Rejected</td><td>{latestRun.paper_trades_rejected}</td></tr>
                      <tr><td>Errors</td><td>{latestRun.steps_failed}</td></tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="console">Run the pipeline to create a status log.</div>
              )}
            </section>

            <section className="panel" id="decisions" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Recent decisions</div>
                  <div className="panel-meta">Trade and no-trade calls</div>
                </div>
                <a className="badge blue" href="/api/paper/decisions">View JSON</a>
              </div>
              {paperDecisions.length > 0 ? (
                <div className="signal-list">
                  {paperDecisions.map((decision) => {
                    const rejects = parseList(decision.reject_codes as Jsonish);
                    const reasons = parseList(decision.reason_codes as Jsonish);
                    return (
                      <article className="signal-card" key={decision.accession_number}>
                        <div className="signal-head">
                          <div>
                            <div className="signal-title">{decision.ticker} · {decision.decision}</div>
                            <div className="panel-meta">{decision.action} · {shortDate(decision.created_at)}</div>
                          </div>
                          <div className={`score ${scoreTone(decision.final_score)}`}>{decision.final_score}</div>
                        </div>
                        {rejects.length ? (
                          <div className="market-strip">
                            {rejects.slice(0, 3).map((reject) => <span key={reject}>{reject.split("_").join(" ")}</span>)}
                          </div>
                        ) : null}
                        {reasons[0] ? <p className="signal-copy">{reasons[0]}</p> : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="console">No trade decisions logged.</div>
              )}
            </section>

            <section className="panel" id="watchlist" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Watchlist</div>
                  <div className="panel-meta">Active scanner tickers</div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Focus</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchlist.map((item) => (
                      <tr key={item.symbol}>
                        <td className="symbol">{item.symbol}</td>
                        <td>{item.focus}</td>
                        <td><span className="badge">{item.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}
