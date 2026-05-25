import { getAlpacaPaperSnapshot, type PaperAccountSnapshot } from "@/lib/alpacaTrading";
import { getLatestPaperDecisions, getLatestPaperTrades } from "@/lib/paper";
import { getPaperTradePlan } from "@/lib/paperPlanner";
import { runPaperOrderExecution } from "@/lib/paperExecution";
import { getPaperPositionLifecycle } from "@/lib/paperLifecycle";
import { getLatestPipelineRuns } from "@/lib/pipelineRuns";
import { getActiveRadarTickers } from "@/lib/radar";
import { getLatestScoredSignals } from "@/lib/scoring";
import { getLatestSignalEvents, getSignalSourceHealth } from "@/lib/signalEvents";
import { watchlist } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

type Jsonish = string[] | string | null | undefined;


function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${money(value)}`;
}

function paperAccountTone(snapshot: PaperAccountSnapshot | null) {
  if (!snapshot || !snapshot.configured) return "amber";
  if (!snapshot.ok || snapshot.summary.tradingBlocked) return "red";
  return "green";
}

function scoreTone(score: number) {
  if (score >= 70) return "green";
  if (score >= 40) return "blue";
  if (score >= 20) return "amber";
  return "red";
}

function statusTone(status: string) {
  if (status === "completed") return "green";
  if (status === "needs_attention") return "amber";
  if (status === "active") return "green";
  if (status === "queued") return "blue";
  if (status === "failed") return "red";
  return "blue";
}

function sourceTone(source: string) {
  if (source === "SEC" || source === "SEC_DISCOVERY") return "green";
  if (source === "FINRA") return "amber";
  if (source === "FED_REG" || source === "FDA") return "blue";
  if (source === "CONGRESS" || source === "NEWS") return "blue";
  return "blue";
}

function sourceLabel(source: string) {
  if (source === "FED_REG") return "FED REG";
  if (source === "SEC_DISCOVERY") return "SEC DISC";
  return source;
}

function actionTone(action: string) {
  if (action === "paper_trade_candidate") return "green";
  if (action === "high_watch" || action === "watch_only" || action === "material_event_watch" || action === "activist_watch" || action === "ownership_watch" || action === "registration_watch") return "blue";
  if (action === "danger_watch" || action === "dilution_watch" || action === "shelf_watch" || action === "late_filing_risk") return "amber";
  if (action === "avoid") return "red";
  return "red";
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
  if (!Number.isFinite(ms)) return "--";
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

function cleanLabel(value: string | null | undefined) {
  if (!value) return "--";
  return value.split("_").join(" ");
}

function runOutcome(run: { steps_failed: number; paper_trades_opened: number; paper_trades_closed: number; paper_trades_rejected: number }) {
  if (run.steps_failed > 0) return "failed";
  if (run.paper_trades_opened > 0) return "opened";
  if (run.paper_trades_closed > 0) return "closed";
  if (run.paper_trades_rejected > 0) return "rejected";
  return "clean";
}

function runToneFromOutcome(outcome: string) {
  if (outcome === "opened" || outcome === "closed" || outcome === "clean") return "green";
  if (outcome === "rejected") return "amber";
  return "red";
}

function runLine(run: { sec_filings_found: number; sec_filings_saved: number; ai_classified: number; alpaca_confirmed: number; signals_scored: number; paper_trades_opened: number; paper_trades_closed: number; paper_trades_rejected: number; steps_failed: number }) {
  if (run.steps_failed > 0) return `${run.steps_failed} error${run.steps_failed === 1 ? "" : "s"}`;
  if (run.paper_trades_opened > 0) return `${run.paper_trades_opened} opened`;
  if (run.paper_trades_closed > 0) return `${run.paper_trades_closed} closed`;
  if (run.paper_trades_rejected > 0) return `${run.paper_trades_rejected} rejected`;
  return "no trade";
}

function primaryReason(reasons: string[]) {
  if (!reasons.length) return "No reason logged.";
  const useful = reasons.find((reason) => !reason.toLowerCase().startsWith("ai tradeability starts"));
  return useful || reasons[0];
}

async function safeAlpacaPaperAccount() {
  try {
    return await getAlpacaPaperSnapshot(12);
  } catch {
    return null;
  }
}

async function safeSignals() {
  try {
    return await getLatestScoredSignals(6);
  } catch {
    return [];
  }
}

async function safeSignalEvents() {
  try {
    return await getLatestSignalEvents(8);
  } catch {
    return [];
  }
}

async function safeSourceHealth() {
  try {
    return await getSignalSourceHealth();
  } catch {
    return [];
  }
}

async function safePaperTrades() {
  try {
    return await getLatestPaperTrades(6);
  } catch {
    return [];
  }
}

async function safePaperDecisions() {
  try {
    return await getLatestPaperDecisions(6);
  } catch {
    return [];
  }
}

async function safePaperPlan() {
  try {
    return await getPaperTradePlan(5);
  } catch {
    return null;
  }
}

async function safePaperExecution() {
  try {
    return await runPaperOrderExecution({ submit: false });
  } catch {
    return null;
  }
}

async function safePaperLifecycle() {
  try {
    return await getPaperPositionLifecycle();
  } catch {
    return null;
  }
}

async function safePipelineRuns() {
  try {
    return await getLatestPipelineRuns(6);
  } catch {
    return [];
  }
}

async function safeRadarTickers() {
  try {
    return await getActiveRadarTickers(8);
  } catch {
    return [];
  }
}

export default async function Home() {
  const [paperAccount, paperPlan, paperExecution, paperLifecycle, signals, signalEvents, sourceHealth, paperTrades, paperDecisions, pipelineRuns, radarTickers] = await Promise.all([
    safeAlpacaPaperAccount(),
    safePaperPlan(),
    safePaperExecution(),
    safePaperLifecycle(),
    safeSignals(),
    safeSignalEvents(),
    safeSourceHealth(),
    safePaperTrades(),
    safePaperDecisions(),
    safePipelineRuns(),
    safeRadarTickers()
  ]);

  const latestRun = pipelineRuns[0];
  const openTrades = paperTrades.filter((trade) => trade.status === "open");
  const closedTrades = paperTrades.filter((trade) => trade.status === "closed");
  const latestSignal = signals[0];
  const latestSignalEvent = signalEvents[0];
  const activeSources = sourceHealth.filter((source) => source.status === "active").length;
  const latestDecision = paperDecisions[0];
  const latestErrors = latestRun?.steps_failed || 0;
  const lastRunOutcome = latestRun ? runOutcome(latestRun) : "none";

  return (
    <main className="raven-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">R</div>
          <div>
            <div className="brand-title">RAVEN</div>
            <div className="brand-subtitle">signals</div>
          </div>
        </div>

        <nav className="nav" aria-label="Raven navigation">
          <a className="nav-item active" href="#overview">Overview <span className="nav-pill">live</span></a>
          <a className="nav-item" href="#account">Paper account <span className="nav-pill">read</span></a>
          <a className="nav-item" href="#plan">Trade plan <span className="nav-pill">{paperPlan?.eligible || 0}</span></a>
          <a className="nav-item" href="#lifecycle">Lifecycle <span className="nav-pill">{paperLifecycle?.pendingExits || paperLifecycle?.openPositions || 0}</span></a>
          <a className="nav-item" href="#trades">Trades <span className="nav-pill">{openTrades.length}</span></a>
          <a className="nav-item" href="#signals">Signals <span className="nav-pill">{signalEvents.length || signals.length}</span></a>
          <a className="nav-item" href="#radar">Radar <span className="nav-pill">{radarTickers.length}</span></a>
          <a className="nav-item" href="#decisions">Decisions <span className="nav-pill">{paperDecisions.length}</span></a>
          <a className="nav-item" href="#sources">Sources <span className="nav-pill">{activeSources}</span></a>
          <a className="nav-item" href="#runs">Runs <span className="nav-pill">{pipelineRuns.length}</span></a>
          <a className="nav-item" href="#watchlist">Watchlist <span className="nav-pill">{watchlist.length}</span></a>
        </nav>

        <div className="sidebar-footer compact-status">
          <div><span>Live</span><strong>OFF</strong></div>
          <div><span>Mode</span><strong>Paper</strong></div>
          <div><span>Alerts</span><strong>Trades</strong></div>
        </div>
      </aside>

      <section className="main">
        <div className="topbar" id="overview">
          <div>
            <div className="eyebrow">Raven command</div>
            <h1>Trading engine</h1>
          </div>
          <div className="top-actions">
            <a className="badge green" href="/api/run/pipeline">Run now</a>
            <form action="/api/logout" method="post">
              <button className="ghost-button" type="submit">Lock</button>
            </form>
          </div>
        </div>

        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-label">Last run</div>
            <div className={`kpi-value ${latestErrors ? "text-red" : "text-green"}`}>{latestRun ? lastRunOutcome : "none"}</div>
            <div className="kpi-note">{latestRun ? `${shortDate(latestRun.created_at)} · ${seconds(latestRun.duration_ms)}` : "No runs yet"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Paper equity</div>
            <div className={`kpi-value text-${paperAccountTone(paperAccount)}`}>{paperAccount ? money(paperAccount.summary.equity) : "--"}</div>
            <div className="kpi-note">cash {paperAccount ? money(paperAccount.summary.cash) : "--"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Open trades</div>
            <div className="kpi-value">{paperAccount ? paperAccount.summary.openPositionCount : openTrades.length}</div>
            <div className="kpi-note">orders {paperAccount ? paperAccount.summary.openOrderCount : 0} · exits {paperLifecycle?.pendingExits || 0}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Latest decision</div>
            <div className="kpi-value">{latestDecision ? latestDecision.decision : "--"}</div>
            <div className="kpi-note">{latestDecision ? `${latestDecision.ticker} · ${latestDecision.final_score}/100` : "No decisions"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Sources</div>
            <div className="kpi-value">{activeSources}/{sourceHealth.length || 6}</div>
            <div className="kpi-note">{latestErrors ? `${latestErrors} errors` : "healthy"}</div>
          </div>
        </div>

        <div className="grid">
          <div className="left-stack">
            <section className="panel" id="account">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Alpaca paper account</div>
                  <div className="panel-meta">Read-only. No orders are submitted in 13A.</div>
                </div>
                <span className={`badge ${paperAccountTone(paperAccount)}`}>{paperAccount?.configured ? "connected" : "not configured"}</span>
              </div>
              {paperAccount ? (
                <>
                  <div className="run-summary run-summary-tight">
                    <div><span>Equity</span><strong>{money(paperAccount.summary.equity)}</strong></div>
                    <div><span>Cash</span><strong>{money(paperAccount.summary.cash)}</strong></div>
                    <div><span>Buying power</span><strong>{money(paperAccount.summary.buyingPower)}</strong></div>
                    <div><span>Portfolio</span><strong>{money(paperAccount.summary.portfolioValue)}</strong></div>
                    <div><span>Open positions</span><strong>{paperAccount.summary.openPositionCount}</strong></div>
                    <div><span>Open orders</span><strong>{paperAccount.summary.openOrderCount}</strong></div>
                    <div><span>Unrealized P/L</span><strong className={paperAccount.summary.unrealizedPl && paperAccount.summary.unrealizedPl < 0 ? "text-red" : "text-green"}>{signedMoney(paperAccount.summary.unrealizedPl)}</strong></div>
                    <div><span>Live trading</span><strong className="text-red">disabled</strong></div>
                  </div>
                  {paperAccount.positions.length > 0 ? (
                    <div className="signal-list">
                      {paperAccount.positions.slice(0, 6).map((position) => (
                        <article className="signal-card" key={position.symbol}>
                          <div className="signal-head">
                            <div>
                              <div className="signal-title">{position.symbol} · {position.side || "position"}</div>
                              <div className="panel-meta">qty {position.qty} · avg {money(Number(position.avg_entry_price))}</div>
                            </div>
                            <div className={`score ${Number(position.unrealized_pl || 0) >= 0 ? "green" : "red"}`}>{money(Number(position.market_value || 0))}</div>
                          </div>
                          <div className="market-strip">
                            <span>current {money(Number(position.current_price || 0))}</span>
                            <span>p/l {signedMoney(Number(position.unrealized_pl || 0))}</span>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : <div className="empty-state">No open Alpaca paper positions.</div>}
                  <div className="market-strip" style={{ padding: "0 13px 12px" }}>
                    <a className="badge blue" href="/api/paper/account">Account JSON</a>
                    <a className="badge blue" href="/api/paper/report">Paper report</a>
                  </div>
                </>
              ) : (
                <div className="empty-state">Alpaca paper account unavailable.</div>
              )}
            </section>

            <section className="panel" id="plan" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Paper trade planner</div>
                  <div className="panel-meta">Plan only. No orders submitted.</div>
                </div>
                {paperPlan ? <span className={`badge ${paperPlan.eligible > 0 ? "green" : "amber"}`}>{paperPlan.eligible} eligible</span> : <span className="badge amber">offline</span>}
              </div>
              {paperPlan ? (
                <>
                  <div className="run-summary run-summary-tight">
                    <div><span>Mode</span><strong>plan only</strong></div>
                    <div><span>Reviewed</span><strong>{paperPlan.candidatesReviewed}</strong></div>
                    <div><span>Eligible</span><strong className={paperPlan.eligible > 0 ? "text-green" : "text-amber"}>{paperPlan.eligible}</strong></div>
                    <div><span>Rejected</span><strong>{paperPlan.rejected}</strong></div>
                    <div><span>Max size</span><strong>{money(paperPlan.riskLimits.maxNotionalPerTrade)}</strong></div>
                    <div><span>Per trade</span><strong>{paperPlan.riskLimits.maxPositionPct}% equity</strong></div>
                    <div><span>Risk status</span><strong className={paperPlan.riskState.riskStatus === "ok" ? "text-green" : "text-red"}>{paperPlan.riskState.riskStatus}</strong></div>
                    <div><span>Daily trades</span><strong>{paperPlan.riskState.dailyTradesUsed}/{paperPlan.riskLimits.maxDailyTrades}</strong></div>
                  </div>
                  {paperPlan.plans.length > 0 ? (
                    <div className="signal-list">
                      {paperPlan.plans.slice(0, 4).map((plan) => (
                        <article className="signal-card" key={`${plan.ticker}-${plan.accessionNumber}`}>
                          <div className="signal-head">
                            <div>
                              <div className="signal-title">{plan.ticker} · {plan.wouldTrade ? "eligible" : "reject"}</div>
                              <div className="panel-meta">{cleanLabel(plan.action)} · {plan.form}</div>
                            </div>
                            <div className={`score ${scoreTone(plan.score)}`}>{plan.score}</div>
                          </div>
                          <p className="signal-copy">{plan.summary}</p>
                          {plan.wouldTrade ? (
                            <div className="market-strip">
                              <span>buy {money(plan.suggestedNotional)}</span>
                              <span>{plan.estimatedShares ?? "--"} shares</span>
                              <span>stop {money(plan.stopPrice)}</span>
                              <span>target {money(plan.targetPrice)}</span>
                            </div>
                          ) : (
                            <div className="market-strip">
                              {plan.rejectCodes.slice(0, 4).map((reject) => <span key={reject}>{cleanLabel(reject)}</span>)}
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : <div className="empty-state">No scored candidates available for planning.</div>}
                  <div className="market-strip" style={{ padding: "0 13px 12px" }}>
                    <a className="badge blue" href="/api/paper/plan">Plan JSON</a>
                    <a className="badge blue" href="/api/paper/plan/report">Plan report</a>
                    <a className="badge blue" href="/api/paper/risk/report">Risk report</a>
                  </div>
                </>
              ) : (
                <div className="empty-state">Paper planner unavailable.</div>
              )}
            </section>

            <section className="panel" id="execute" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Paper execution switch</div>
                  <div className="panel-meta">13D. Risk-gated. Disabled by default. POST only when explicitly enabled.</div>
                </div>
                {paperExecution ? <span className={`badge ${paperExecution.paperTradingEnabled ? "green" : "amber"}`}>{paperExecution.paperTradingEnabled ? "enabled" : "disabled"}</span> : <span className="badge amber">offline</span>}
              </div>
              {paperExecution ? (
                <>
                  <div className="run-summary run-summary-tight">
                    <div><span>Order submit</span><strong className={paperExecution.orderSubmission === "submitted" ? "text-green" : "text-amber"}>{cleanLabel(paperExecution.orderSubmission)}</strong></div>
                    <div><span>Eligible</span><strong>{paperExecution.eligible}</strong></div>
                    <div><span>Reviewed</span><strong>{paperExecution.candidatesReviewed}</strong></div>
                    <div><span>Live trading</span><strong className="text-red">disabled</strong></div>
                    <div><span>Paper switch</span><strong>{paperExecution.paperTradingEnabled ? "on" : "off"}</strong></div>
                    <div><span>Duplicate safe</span><strong>{paperExecution.duplicate ? "blocked" : "ready"}</strong></div>
                  </div>
                  {paperExecution.selectedPlan ? (
                    <article className="signal-card">
                      <div className="signal-head">
                        <div>
                          <div className="signal-title">{paperExecution.selectedPlan.ticker} · selected plan</div>
                          <div className="panel-meta">{cleanLabel(paperExecution.selectedPlan.action)} · score {paperExecution.selectedPlan.score}</div>
                        </div>
                        <div className={`score ${scoreTone(paperExecution.selectedPlan.score)}`}>{paperExecution.selectedPlan.score}</div>
                      </div>
                      <p className="signal-copy">{paperExecution.selectedPlan.summary}</p>
                      <div className="market-strip">
                        <span>notional {money(paperExecution.selectedPlan.suggestedNotional)}</span>
                        <span>shares {paperExecution.selectedPlan.estimatedShares ?? "--"}</span>
                        <span>stop {money(paperExecution.selectedPlan.stopPrice)}</span>
                        <span>target {money(paperExecution.selectedPlan.targetPrice)}</span>
                      </div>
                    </article>
                  ) : <div className="empty-state">No eligible candidate for execution.</div>}
                  <div className="market-strip" style={{ padding: "0 13px 12px" }}>
                    <a className="badge blue" href="/api/paper/execute">Execution preview</a>
                    <a className="badge blue" href="/api/paper/execute/report">Execution report</a>
                  </div>
                </>
              ) : (
                <div className="empty-state">Paper execution switch unavailable.</div>
              )}
            </section>

            <section className="panel" id="lifecycle" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Position lifecycle</div>
                  <div className="panel-meta">13E. Tracks submitted, filled, open, exit-watch, and closed paper positions. No exit orders submitted yet.</div>
                </div>
                {paperLifecycle ? <span className={`badge ${paperLifecycle.pendingExits > 0 ? "amber" : "green"}`}>{paperLifecycle.pendingExits} exit watch</span> : <span className="badge amber">offline</span>}
              </div>
              {paperLifecycle ? (
                <>
                  <div className="run-summary run-summary-tight">
                    <div><span>Open positions</span><strong>{paperLifecycle.openPositions}</strong></div>
                    <div><span>Open orders</span><strong>{paperLifecycle.openOrders}</strong></div>
                    <div><span>Submissions</span><strong>{paperLifecycle.syncedSubmissions}</strong></div>
                    <div><span>Pending entries</span><strong>{paperLifecycle.pendingEntries}</strong></div>
                    <div><span>Pending exits</span><strong className={paperLifecycle.pendingExits > 0 ? "text-amber" : "text-green"}>{paperLifecycle.pendingExits}</strong></div>
                    <div><span>Closed/cancelled</span><strong>{paperLifecycle.closed}</strong></div>
                  </div>
                  {paperLifecycle.lifecycle.length > 0 ? (
                    <div className="signal-list">
                      {paperLifecycle.lifecycle.slice(0, 5).map((row) => (
                        <article className="signal-card" key={`${row.ticker}-${row.client_order_id || row.id}`}>
                          <div className="signal-head">
                            <div>
                              <div className="signal-title">{row.ticker} · {cleanLabel(row.status)}</div>
                              <div className="panel-meta">{row.exit_signal ? cleanLabel(row.exit_signal) : "lifecycle tracked"}</div>
                            </div>
                            <div className={`score ${Number(row.unrealized_pl || 0) >= 0 ? "green" : "red"}`}>{signedMoney(Number(row.unrealized_pl || 0))}</div>
                          </div>
                          <div className="market-strip">
                            <span>entry {money(Number(row.entry_price || 0))}</span>
                            <span>current {money(Number(row.current_price || 0))}</span>
                            <span>stop {money(Number(row.stop_price || 0))}</span>
                            <span>target {money(Number(row.target_price || 0))}</span>
                          </div>
                          {row.exit_reason ? <p className="signal-copy">{row.exit_reason}</p> : null}
                        </article>
                      ))}
                    </div>
                  ) : <div className="empty-state">No paper lifecycle rows yet.</div>}
                  <div className="market-strip" style={{ padding: "0 13px 12px" }}>
                    <a className="badge blue" href="/api/paper/lifecycle">Lifecycle JSON</a>
                    <a className="badge blue" href="/api/paper/lifecycle/report">Lifecycle report</a>
                  </div>
                </>
              ) : (
                <div className="empty-state">Paper lifecycle unavailable.</div>
              )}
            </section>

            <section className="panel" id="trades" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Paper trades</div>
                  <div className="panel-meta">Open and closed</div>
                </div>
                <span className="badge green">{openTrades.length} open</span>
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
                <div className="empty-state">No paper trades opened.</div>
              )}
            </section>

            <section className="panel" id="signals" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Signals</div>
                  <div className="panel-meta">Unified public signals</div>
                </div>
                {latestSignalEvent ? <span className={`badge ${sourceTone(latestSignalEvent.source)}`}>{sourceLabel(latestSignalEvent.source)}</span> : latestSignal ? <span className={`badge ${actionTone(latestSignal.action)}`}>{cleanLabel(latestSignal.action)}</span> : <span className="badge">none</span>}
              </div>

              {signalEvents.length > 0 ? (
                <div className="signal-list">
                  {signalEvents.map((event) => {
                    const metadata = event.metadata || {};
                    const marketConfirmation = typeof metadata.marketConfirmation === "string" ? metadata.marketConfirmation : "--";
                    const riskLevel = typeof metadata.riskLevel === "string" ? metadata.riskLevel : "--";
                    return (
                      <article className="signal-card" key={`${event.source}-${event.source_event_id}`}>
                        <div className="signal-head">
                          <div>
                            <div className="signal-title">{event.ticker || "--"} · {event.headline}</div>
                            <div className="panel-meta">{cleanLabel(event.direction)} · {cleanLabel(event.action)} · {shortDate(event.created_at)}</div>
                          </div>
                          <div className={`score ${scoreTone(event.confidence)}`}>{event.confidence}</div>
                        </div>
                        <div className="source-row">
                          <span className={`source-chip ${sourceTone(event.source)}`}>{sourceLabel(event.source)}</span>
                          <span>{event.event_type}</span>
                          <span>{cleanLabel(event.priority)}</span>
                          <span>{cleanLabel(event.materiality)}</span>
                          <span>{cleanLabel(event.status)}</span>
                        </div>
                        <p className="signal-copy">{event.summary}</p>
                        <div className="market-strip">
                          <span>market {cleanLabel(marketConfirmation)}</span>
                          <span>{cleanLabel(riskLevel)} risk</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : signals.length > 0 ? (
                <div className="signal-list">
                  {signals.map((signal) => {
                    const reasons = parseList(signal.reason_codes as Jsonish);
                    const risks = parseList(signal.risk_flags as Jsonish);
                    return (
                      <article className="signal-card" key={signal.accession_number}>
                        <div className="signal-head">
                          <div>
                            <div className="signal-title">{signal.ticker} · {cleanLabel(signal.category)}</div>
                            <div className="panel-meta">{signal.direction} · {signal.market_confirmation} · {cleanLabel(signal.action)}</div>
                          </div>
                          <div className={`score ${scoreTone(signal.final_score)}`}>{signal.final_score}</div>
                        </div>
                        <p className="signal-copy">{signal.readable_summary}</p>
                        <div className="market-strip">
                          <span>SEC</span>
                          <span>{signal.form}</span>
                          <span>AI {signal.ai_tradeability}/100</span>
                          <span>{signal.risk_level} risk</span>
                        </div>
                        <p className="signal-copy"><strong>Why:</strong> {primaryReason(reasons)}</p>
                        {risks[0] ? <p className="signal-copy"><strong>Risk:</strong> {risks[0]}</p> : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">No scored signals.</div>
              )}
            </section>
          </div>

          <div className="right-stack">
            <section className="panel" id="runs">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Cron heartbeat</div>
                  <div className="panel-meta">{latestRun ? shortDate(latestRun.created_at) : "No run"}</div>
                </div>
                {latestRun ? <span className={`badge ${runToneFromOutcome(runOutcome(latestRun))}`}>{runLine(latestRun)}</span> : <span className="badge amber">none</span>}
              </div>
              {latestRun ? (
                <>
                  <div className="run-summary run-summary-tight">
                    <div>
                      <span>Outcome</span>
                      <strong className={latestRun.steps_failed ? "text-red" : runToneFromOutcome(runOutcome(latestRun)) === "green" ? "text-green" : "text-amber"}>{runLine(latestRun)}</strong>
                    </div>
                    <div>
                      <span>Runtime</span>
                      <strong>{seconds(latestRun.duration_ms)}</strong>
                    </div>
                    <div>
                      <span>SEC</span>
                      <strong>{latestRun.sec_filings_found} found · {latestRun.sec_filings_saved} new</strong>
                    </div>
                    <div>
                      <span>AI</span>
                      <strong>{latestRun.ai_classified} classified</strong>
                    </div>
                    <div>
                      <span>Market</span>
                      <strong>{latestRun.alpaca_confirmed} confirmed</strong>
                    </div>
                    <div>
                      <span>Signals</span>
                      <strong>{latestRun.signals_scored} scored · {latestRun.paper_trades_rejected} rejected</strong>
                    </div>
                    <div>
                      <span>Trades</span>
                      <strong>{latestRun.paper_trades_opened} opened · {latestRun.paper_trades_closed} closed</strong>
                    </div>
                    <div>
                      <span>Errors</span>
                      <strong className={latestRun.steps_failed ? "text-red" : "text-green"}>{latestRun.steps_failed}</strong>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-state">No run history.</div>
              )}
            </section>

            <section className="panel" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Run history</div>
                  <div className="panel-meta">Recent automatic and manual runs</div>
                </div>
              </div>
              {pipelineRuns.length > 0 ? (
                <div className="run-list">
                  {pipelineRuns.map((run) => {
                    const outcome = runOutcome(run);
                    return (
                      <div className="run-row" key={run.id}>
                        <div>
                          <div className="run-time">{shortDate(run.created_at)}</div>
                          <div className="run-metrics">SEC {run.sec_filings_found}/{run.sec_filings_saved} · AI {run.ai_classified} · MKT {run.alpaca_confirmed} · Score {run.signals_scored} · Reject {run.paper_trades_rejected}</div>
                        </div>
                        <div className="run-right">
                          <span className={`badge ${runToneFromOutcome(outcome)}`}>{runLine(run)}</span>
                          <span>{seconds(run.duration_ms)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">No runs logged.</div>
              )}
            </section>

            <section className="panel" id="radar" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Raven radar</div>
                  <div className="panel-meta">Core watchlist plus discovered tickers</div>
                </div>
                <span className="badge blue">{radarTickers.length} active</span>
              </div>
              {radarTickers.length > 0 ? (
                <div className="radar-list">
                  {radarTickers.map((item) => {
                    const evidence = item.evidence || {};
                    const sources = Array.isArray(evidence.sources) ? evidence.sources.map(String) : String(item.source || "").split(",").filter(Boolean);
                    const core = Boolean(evidence.coreWatchlist) || item.status === "core_radar";
                    return (
                      <article className="radar-card" key={item.ticker}>
                        <div className="signal-head">
                          <div>
                            <div className="signal-title">{item.ticker} · {core ? "core watchlist" : "radar"}</div>
                            <div className="panel-meta">Last seen {shortDate(item.last_seen)} · expires {shortDate(item.expires_at)}</div>
                          </div>
                          <div className={`score ${scoreTone(item.score)}`} title="Attention score, not trade score">{item.score}</div>
                        </div>
                        <div className="source-row">
                          {sources.slice(0, 5).map((source) => (
                            <span className={`source-chip ${sourceTone(source)}`} key={source}>{sourceLabel(source)}</span>
                          ))}
                          <span>{cleanLabel(item.status)}</span>
                        </div>
                        <p className="signal-copy">{item.reason}</p>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">No radar tickers yet.</div>
              )}
            </section>

            <section className="panel" id="sources" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Source health</div>
                  <div className="panel-meta">Public signal feeds</div>
                </div>
              </div>
              <div className="source-health-list">
                {sourceHealth.map((source) => (
                  <div className="source-health-row" key={source.source}>
                    <div>
                      <span className={`source-chip ${sourceTone(source.source)}`}>{sourceLabel(source.source)}</span>
                      <div className="panel-meta">{source.latest ? shortDate(source.latest) : "no events"}</div>
                    </div>
                    <div className="source-health-right">
                      <strong>{source.count}</strong>
                      <span className={`badge ${statusTone(source.status)}`}>{source.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel" id="decisions" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Recent decisions</div>
                  <div className="panel-meta">Latest calls</div>
                </div>
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
                            <div className="panel-meta">{cleanLabel(decision.action)} · {shortDate(decision.created_at)}</div>
                          </div>
                          <div className={`score ${scoreTone(decision.final_score)}`}>{decision.final_score}</div>
                        </div>
                        {rejects.length ? (
                          <div className="market-strip">
                            {rejects.slice(0, 3).map((reject) => <span key={reject}>{cleanLabel(reject)}</span>)}
                          </div>
                        ) : null}
                        <p className="signal-copy">{primaryReason(reasons)}</p>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">No decisions logged.</div>
              )}
            </section>

            <section className="panel" id="watchlist" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Watchlist</div>
                  <div className="panel-meta">Active tickers</div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
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
