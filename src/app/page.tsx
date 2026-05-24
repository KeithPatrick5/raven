import { getLatestScoredSignals } from "@/lib/scoring";
import { getLatestPaperDecisions, getLatestPaperTrades } from "@/lib/paper";
import { watchlist } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

const phases = [
  ["Dashboard/watchlist", "Private shell, dense UI, watchlist table."],
  ["SEC EDGAR scanner", "Pull submissions and store raw filings."],
  ["AI classifier", "Summarize filings into strict signal JSON."],
  ["Alpaca confirmation", "Add price, volume, liquidity, and relative volume checks."],
  ["Signal scoring", "Store scored events and readable verdicts in Postgres."],
  ["Telegram test route", "Bot status messages only. Signal spam disabled."],
  ["Paper trade engine", "Deterministic paper-trade decisions."],
  ["Paper trade lifecycle", "Current build. Track opens, rejects, stops, targets."],
  ["Dashboard cleanup", "Keep only important Raven outputs."]
];

const systemSignals = [
  {
    title: "Phase 7C decision log wired",
    source: "RAVEN_SYSTEM",
    score: 55,
    tone: "blue",
    copy: "Paper engine now exposes recent rejects and trade decisions so empty runs still show what Raven already decided."
  },
  {
    title: "SEC + AI storage online",
    source: "POSTGRES",
    score: 40,
    tone: "green",
    copy: "Raw SEC filings, AI classifications, market confirmations, and scored signals are stored."
  },
  {
    title: "Live trading disabled",
    source: "RISK_ENGINE",
    score: 100,
    tone: "green",
    copy: "Raven remains paper-trade only. AI analyzes. Deterministic rules decide whether a simulated trade is opened."
  }
];

function scoreTone(score: number) {
  if (score >= 70) return "green";
  if (score >= 35) return "blue";
  return "amber";
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

export default async function Home() {
  const signals = await safeSignals();
  const paperTrades = await safePaperTrades();
  const paperDecisions = await safePaperDecisions();

  return (
    <main className="raven-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">R</div>
          <div>
            <div className="brand-title">RAVEN</div>
            <div className="brand-subtitle">public signal scanner</div>
          </div>
        </div>

        <nav className="nav" aria-label="Raven navigation">
          <a className="nav-item active" href="#overview">Overview <span className="nav-pill">live</span></a>
          <a className="nav-item" href="#watchlist">Watchlist <span className="nav-pill">v1</span></a>
          <a className="nav-item" href="#signals">Signals <span className="nav-pill">AI</span></a>
          <a className="nav-item" href="#sources">Sources <span className="nav-pill">SEC</span></a>
          <a className="nav-item" href="#paper">Paper Trades <span className="nav-pill">engine</span></a>
          <a className="nav-item" href="#settings">Settings <span className="nav-pill">soon</span></a>
        </nav>

        <div className="sidebar-footer">
          <strong>Rule:</strong> AI is the analyst, not the trader. Alerts first. Paper trades second. Live execution later, disabled by default.
        </div>
      </aside>

      <section className="main">
        <div className="topbar" id="overview">
          <div>
            <div className="eyebrow">Phase 7C / Paper decision log</div>
            <h1>Private Raven signal board</h1>
          </div>
          <div className="top-actions">
            <span className="badge green">Vercel-ready</span>
            <span className="badge green">SEC stored</span>
            <span className="badge blue">AI route wired</span>
            <span className="badge green">Scoring route wired</span>
            <span className="badge green">Paper engine wired</span>
            <form action="/api/logout" method="post">
              <button className="ghost-button" type="submit">Lock</button>
            </form>
          </div>
        </div>

        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-label">Watchlist</div>
            <div className="kpi-value">5</div>
            <div className="kpi-note">Seed tickers only</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Signal engine</div>
            <div className="kpi-value">90%</div>
            <div className="kpi-note">Decision log added</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Paper trades</div>
            <div className="kpi-value">{paperTrades.length}</div>
            <div className="kpi-note">Opened rows</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Live trading</div>
            <div className="kpi-value">OFF</div>
            <div className="kpi-note">Hard rule</div>
          </div>
        </div>

        <div className="grid">
          <div className="left-stack">
            <section className="panel" id="watchlist">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Watchlist</div>
                  <div className="panel-meta">Manual seed list for scanner phase</div>
                </div>
                <span className="badge blue">editable later</span>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Focus</th>
                      <th>Last signal</th>
                      <th>Status</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchlist.map((item) => (
                      <tr key={item.symbol}>
                        <td className="symbol">{item.symbol}</td>
                        <td>{item.focus}</td>
                        <td>{item.lastSignal}</td>
                        <td><span className="badge">{item.status}</span></td>
                        <td>{item.score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel" id="signals" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Scored Raven signals</div>
                  <div className="panel-meta">Readable scores from SEC, AI, and Alpaca confirmation</div>
                </div>
                <div className="top-actions">
                  <a className="badge blue" href="/api/scan/sec">run scan</a>
                  <a className="badge green" href="/api/classify/sec">classify</a>
                  <a className="badge amber" href="/api/confirm/alpaca">confirm</a>
                  <a className="badge green" href="/api/score/signals">score</a>
                  <a className="badge green" href="/api/paper/trades">paper</a>
                  <a className="badge blue" href="/api/paper/trades/review">review</a>
                </div>
              </div>

              {signals.length > 0 ? (
                <div className="signal-list">
                  {signals.map((signal) => (
                    <article className="signal-card" key={signal.accession_number}>
                      <div className="signal-head">
                        <div>
                          <div className="signal-title">{signal.ticker} · {signal.form} · {signal.category}</div>
                          <div className="panel-meta">{signal.direction} / {signal.risk_level} risk / {signal.action}</div>
                        </div>
                        <div className={`score ${scoreTone(signal.final_score)}`}>{signal.final_score}</div>
                      </div>
                      <p className="signal-copy">{signal.readable_summary}</p>
                      <div className="market-strip">
                        <span>AI {signal.ai_tradeability}/100</span>
                        <span>market {signal.market_confirmation}</span>
                        <span>action {signal.action}</span>
                      </div>
                      {Array.isArray(signal.reason_codes) && signal.reason_codes.length > 0 ? (
                        <ul className="compact-list">
                          {signal.reason_codes.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}
                        </ul>
                      ) : null}
                      {Array.isArray(signal.risk_flags) && signal.risk_flags.length > 0 ? (
                        <p className="signal-copy"><strong>Risk:</strong> {signal.risk_flags[0]}</p>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="signal-list">
                  {systemSignals.map((signal) => (
                    <article className="signal-card" key={signal.title}>
                      <div className="signal-head">
                        <div>
                          <div className="signal-title">{signal.title}</div>
                          <div className="panel-meta">{signal.source}</div>
                        </div>
                        <div className={`score ${signal.tone}`}>{signal.score}</div>
                      </div>
                      <p className="signal-copy">{signal.copy}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="right-stack">
            <section className="panel" id="sources">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Build phases</div>
                  <div className="panel-meta">Do not veer unless blocked</div>
                </div>
              </div>
              <div className="phase-list">
                {phases.map(([name, note], index) => (
                  <div className="phase" key={name}>
                    <div className="phase-number">{index + 1}</div>
                    <div>
                      <div className="phase-name">{name}</div>
                      <div className="phase-note">{note}</div>
                    </div>
                    <span className={`badge ${index <= 6 ? "green" : ""}`}>{index < 6 ? "done" : index === 6 ? "now" : "later"}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel" id="paper" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Paper trades</div>
                  <div className="panel-meta">Simulated trades Raven actually opened</div>
                </div>
                <div className="top-actions"><a className="badge green" href="/api/paper/trades">run engine</a><a className="badge blue" href="/api/paper/trades/review">review exits</a></div>
              </div>
              {paperTrades.length > 0 ? (
                <div className="signal-list">
                  {paperTrades.map((trade) => (
                    <article className="signal-card" key={trade.accession_number}>
                      <div className="signal-head">
                        <div>
                          <div className="signal-title">{trade.ticker} · {trade.side.toUpperCase()} · {trade.status}</div>
                          <div className="panel-meta">Paper only / live trading disabled</div>
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
                <div className="console">
                  PAPER_ENGINE: ready<br />
                  OPEN_ROUTE: /api/paper/trades<br />
                  REVIEW_ROUTE: /api/paper/trades/review<br />
                  TELEGRAM: sends only if a paper trade opens or closes<br />
                  LIVE_EXECUTION: disabled
                </div>
              )}
            </section>

            <section className="panel" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Paper decisions</div>
                  <div className="panel-meta">Recent trade / no-trade calls</div>
                </div>
              </div>
              {paperDecisions.length > 0 ? (
                <div className="signal-list">
                  {paperDecisions.map((decision) => (
                    <article className="signal-card" key={decision.accession_number}>
                      <div className="signal-head">
                        <div>
                          <div className="signal-title">{decision.ticker} · {decision.decision}</div>
                          <div className="panel-meta">{decision.action}</div>
                        </div>
                        <div className={`score ${scoreTone(decision.final_score)}`}>{decision.final_score}</div>
                      </div>
                      {Array.isArray(decision.reject_codes) && decision.reject_codes.length > 0 ? (
                        <ul className="compact-list">
                          {decision.reject_codes.slice(0, 4).map((reject) => <li key={reject}>{reject}</li>)}
                        </ul>
                      ) : (
                        <p className="signal-copy">Trade decision passed.</p>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="console">
                  No paper decisions logged yet.<br />
                  Run /api/paper/trades after scoring signals.
                </div>
              )}
            </section>

            <section className="panel" id="settings" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Source status</div>
                  <div className="panel-meta">Phase order locked</div>
                </div>
              </div>
              <div className="console">
                SEC_EDGAR: wired<br />
                POSTGRES: configured<br />
                AI_CLASSIFIER: /api/classify/sec<br />
                ALPACA_MARKET_DATA: /api/confirm/alpaca<br />
                SIGNAL_SCORING: /api/score/signals<br />
                TELEGRAM_TEST: /api/alert/telegram?mode=test<br />
                PAPER_ENGINE: /api/paper/trades<br />
                PAPER_REVIEW: /api/paper/trades/review<br />
                LIVE_EXECUTION: disabled
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}
