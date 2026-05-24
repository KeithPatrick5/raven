import { watchlist } from "@/lib/watchlist";

const signals = [
  {
    title: "Phase 2 SEC scanner wired",
    source: "RAVEN_SYSTEM",
    score: 12,
    tone: "blue",
    copy: "SEC EDGAR route is ready at /api/scan/sec. It can fetch recent watched-ticker filings and store them when DATABASE_URL is configured."
  },
  {
    title: "Raw filing storage ready",
    source: "NEXT_PHASE",
    score: 0,
    tone: "amber",
    copy: "Scanner creates the raw_sec_filings table automatically when a Postgres DATABASE_URL is added."
  },
  {
    title: "Live trading disabled",
    source: "RISK_ENGINE",
    score: 100,
    tone: "green",
    copy: "Raven starts with alerts and paper-trade logging only. AI is the analyst. The deterministic engine decides eligibility."
  }
];

const phases = [
  ["Dashboard/watchlist", "Private shell, dense UI, watchlist table."],
  ["SEC EDGAR scanner", "Current build. Pull submissions and store raw filings."],
  ["AI classifier", "Summarize filings into strict signal JSON."],
  ["Alpaca confirmation", "Add price, volume, liquidity, and relative volume checks."],
  ["Signal scoring", "Store scored events and risk flags in Postgres."],
  ["Telegram alerts", "Send high-score alerts and morning reports."],
  ["Dashboard signals", "Show real saved signals and filtering."],
  ["Paper trades", "Log simulated entries, exits, and results only."]
];

export default function Home() {
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
          <a className="nav-item" href="#signals">Signals <span className="nav-pill">system</span></a>
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
            <div className="eyebrow">Phase 2 / SEC EDGAR scanner</div>
            <h1>Private Raven signal board</h1>
          </div>
          <div className="top-actions">
            <span className="badge green">Vercel-ready</span>
            <span className="badge green">SEC scanner wired</span>
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
            <div className="kpi-value">25%</div>
            <div className="kpi-note">SEC route online</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Live trading</div>
            <div className="kpi-value">OFF</div>
            <div className="kpi-note">Hard rule</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">VPS dependency</div>
            <div className="kpi-value">NONE</div>
            <div className="kpi-note">Move later only</div>
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
                  <div className="panel-title">Signal feed</div>
                  <div className="panel-meta">System feed until saved signals land</div>
                </div>
                <a className="badge blue" href="/api/scan/sec">run scan</a>
              </div>
              <div className="signal-list">
                {signals.map((signal) => (
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
                    <span className={`badge ${index <= 1 ? "green" : ""}`}>{index === 0 ? "done" : index === 1 ? "now" : "later"}</span>
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
                1. Weird signals: SEC scanner ready<br />
                2. Insider buys: later module<br />
                3. Dilution traps: later module<br />
                4. Watchlist breakouts: pending Alpaca<br />
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
                ALPACA_MARKET_DATA: queued<br />
                POSTGRES: optional DATABASE_URL<br />
                TELEGRAM_ALERTS: queued<br />
                FINRA_SHORT_VOLUME: later<br />
                FEDERAL_REGISTER: later<br />
                LIVE_EXECUTION: disabled
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}
