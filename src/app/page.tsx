import { getLatestScoredSignals } from "@/lib/scoring";
import { watchlist } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

const phases = [
  ["Dashboard/watchlist", "Private shell, dense UI, watchlist table."],
  ["SEC EDGAR scanner", "Pull submissions and store raw filings."],
  ["AI classifier", "Summarize filings into strict signal JSON."],
  ["Alpaca confirmation", "Add price, volume, liquidity, and relative volume checks."],
  ["Signal scoring", "Current build. Store scored events and readable verdicts in Postgres."],
  ["Telegram alerts", "Send high-score alerts and morning reports."],
  ["Dashboard signals", "Show real saved signals and filtering."],
  ["Paper trades", "Log simulated entries, exits, and results only."]
];

const systemSignals = [
  {
    title: "Phase 5 scoring engine wired",
    source: "RAVEN_SYSTEM",
    score: 55,
    tone: "blue",
    copy: "Scoring route is ready at /api/score/signals. It turns AI analysis and market confirmation into readable Raven verdicts."
  },
  {
    title: "SEC + AI storage online",
    source: "POSTGRES",
    score: 40,
    tone: "green",
    copy: "Raw SEC filings and AI classification summaries are stored. Duplicate filings and summaries are skipped."
  },
  {
    title: "Live trading disabled",
    source: "RISK_ENGINE",
    score: 100,
    tone: "green",
    copy: "Raven remains alerts and paper-trade logging only. AI analyzes. The deterministic engine decides eligibility later."
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

export default async function Home() {
  const signals = await safeSignals();

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
          <a className="nav-item" href="#paper">Paper Trades <span className="nav-pill">locked</span></a>
          <a className="nav-item" href="#settings">Settings <span className="nav-pill">soon</span></a>
        </nav>

        <div className="sidebar-footer">
          <strong>Rule:</strong> AI is the analyst, not the trader. Alerts first. Paper trades second. Live execution later, disabled by default.
        </div>
      </aside>

      <section className="main">
        <div className="topbar" id="overview">
          <div>
            <div className="eyebrow">Phase 5 / signal scoring</div>
            <h1>Private Raven signal board</h1>
          </div>
          <div className="top-actions">
            <span className="badge green">Vercel-ready</span>
            <span className="badge green">SEC stored</span>
            <span className="badge blue">AI route wired</span>
            <span className="badge green">Scoring route wired</span>
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
            <div className="kpi-value">70%</div>
            <div className="kpi-note">Readable scoring route added</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Signals visible</div>
            <div className="kpi-value">{signals.length}</div>
            <div className="kpi-note">Scored rows</div>
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
                    <span className={`badge ${index <= 4 ? "green" : ""}`}>{index < 4 ? "done" : index === 4 ? "now" : "later"}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel" id="paper" style={{ marginTop: 14 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Morning report preview</div>
                  <div className="panel-meta">Telegram format placeholder</div>
                </div>
              </div>
              <div className="console">
                RAVEN MORNING<br />
                1. Weird signals: scored SEC events<br />
                2. Insider activity: AI classified + market checked<br />
                3. Dilution traps: score penalties applied<br />
                4. Watchlist breakouts: next Telegram module<br />
                5. Live trades: disabled
              </div>
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
                TELEGRAM_ALERTS: queued<br />
                LIVE_EXECUTION: disabled
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}
