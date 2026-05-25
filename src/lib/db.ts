import postgres from "postgres";

let client: ReturnType<typeof postgres> | undefined;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim() || process.env.STORAGE_URL?.trim());
}

export function db() {
  const databaseUrl = (process.env.DATABASE_URL || process.env.STORAGE_URL || "").trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL or STORAGE_URL is not configured.");
  }

  if (!client) {
    client = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10
    });
  }

  return client;
}

export async function ensureRavenTables() {
  const sql = db();

  await sql`
    create table if not exists raw_sec_filings (
      id bigserial primary key,
      ticker text not null,
      cik text not null,
      accession_number text not null unique,
      form text not null,
      filing_date date,
      report_date date,
      primary_document text,
      primary_document_url text,
      source_url text not null,
      raw_payload jsonb not null,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists raw_sec_filings_ticker_filing_date_idx
    on raw_sec_filings (ticker, filing_date desc)
  `;

  await sql`
    create table if not exists sec_filing_summaries (
      id bigserial primary key,
      raw_filing_id bigint not null references raw_sec_filings(id) on delete cascade,
      accession_number text not null unique,
      ticker text not null,
      form text not null,
      filing_date date,
      classifier_model text not null,
      direction text not null,
      category text not null,
      risk_level text not null,
      tradeability integer not null default 0,
      summary text not null,
      bull_case text not null,
      bear_case text not null,
      verdict text not null,
      confirmation_needed jsonb not null default '[]'::jsonb,
      avoid_if jsonb not null default '[]'::jsonb,
      raw_ai jsonb not null,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists sec_filing_summaries_ticker_created_idx
    on sec_filing_summaries (ticker, created_at desc)
  `;

  await sql`
    create index if not exists sec_filing_summaries_tradeability_idx
    on sec_filing_summaries (tradeability desc, created_at desc)
  `;

  await sql`
    create table if not exists alpaca_market_confirmations (
      id bigserial primary key,
      summary_id bigint not null references sec_filing_summaries(id) on delete cascade,
      accession_number text not null,
      ticker text not null,
      latest_close numeric,
      previous_close numeric,
      price_change_percent numeric,
      latest_volume bigint,
      avg_20d_volume bigint,
      relative_volume numeric,
      latest_bar_time timestamptz,
      liquidity_status text not null,
      price_status text not null,
      confirmation_status text not null,
      raw_payload jsonb not null,
      created_at timestamptz not null default now(),
      unique(summary_id)
    )
  `;

  await sql`
    create index if not exists alpaca_market_confirmations_ticker_created_idx
    on alpaca_market_confirmations (ticker, created_at desc)
  `;

  await sql`
    create table if not exists scored_signals (
      id bigserial primary key,
      summary_id bigint not null references sec_filing_summaries(id) on delete cascade,
      confirmation_id bigint references alpaca_market_confirmations(id) on delete set null,
      accession_number text not null,
      ticker text not null,
      form text not null,
      filing_date date,
      direction text not null,
      category text not null,
      risk_level text not null,
      ai_tradeability integer not null,
      market_confirmation text not null,
      final_score integer not null,
      action text not null,
      readable_summary text not null,
      reason_codes jsonb not null default '[]'::jsonb,
      risk_flags jsonb not null default '[]'::jsonb,
      raw_payload jsonb not null,
      created_at timestamptz not null default now(),
      unique(summary_id)
    )
  `;

  await sql`
    create index if not exists scored_signals_score_created_idx
    on scored_signals (final_score desc, created_at desc)
  `;

  await sql`
    create index if not exists scored_signals_ticker_created_idx
    on scored_signals (ticker, created_at desc)
  `;



  await sql`
    create table if not exists signal_events (
      id bigserial primary key,
      source text not null,
      source_event_id text not null,
      ticker text,
      event_type text not null,
      event_time timestamptz,
      headline text not null,
      summary text not null,
      source_url text,
      priority text not null default 'unknown',
      materiality text not null default 'unknown',
      direction text not null default 'neutral',
      confidence integer not null default 0,
      status text not null default 'new',
      action text not null default 'watch',
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(source, source_event_id)
    )
  `;

  await sql`
    create index if not exists signal_events_source_created_idx
    on signal_events (source, created_at desc)
  `;

  await sql`
    create index if not exists signal_events_ticker_created_idx
    on signal_events (ticker, created_at desc)
  `;

  await sql`
    create index if not exists signal_events_confidence_created_idx
    on signal_events (confidence desc, created_at desc)
  `;



  await sql`
    create table if not exists raw_finra_short_volume (
      id bigserial primary key,
      trade_date date not null,
      symbol text not null,
      short_volume bigint not null default 0,
      short_exempt_volume bigint not null default 0,
      total_volume bigint not null default 0,
      market text,
      source_url text not null,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(trade_date, symbol, market)
    )
  `;

  await sql`
    create index if not exists raw_finra_short_volume_symbol_date_idx
    on raw_finra_short_volume (symbol, trade_date desc)
  `;



  await sql`
    create table if not exists raw_federal_register_docs (
      id bigserial primary key,
      document_number text not null,
      ticker text not null,
      matched_term text not null,
      category text not null,
      document_type text,
      publication_date date,
      title text not null,
      summary text not null,
      source_url text,
      agencies jsonb not null default '[]'::jsonb,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(document_number, ticker, matched_term)
    )
  `;

  await sql`
    create index if not exists raw_federal_register_docs_ticker_date_idx
    on raw_federal_register_docs (ticker, publication_date desc)
  `;

  await sql`
    create index if not exists raw_federal_register_docs_category_date_idx
    on raw_federal_register_docs (category, publication_date desc)
  `;

  await sql`
    create table if not exists raw_federal_register_observations (
      id bigserial primary key,
      source_id text not null unique,
      document_number text not null,
      ticker text not null,
      matched_term text not null,
      category text not null,
      document_type text,
      publication_date date,
      title text not null,
      summary text not null,
      source_url text,
      agencies jsonb not null default '[]'::jsonb,
      visible_signal boolean not null default false,
      suppression_reason text,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists raw_federal_register_observations_ticker_date_idx
    on raw_federal_register_observations (ticker, publication_date desc)
  `;

  await sql`
    create index if not exists raw_federal_register_observations_visible_idx
    on raw_federal_register_observations (visible_signal, publication_date desc)
  `;



  await sql`
    create table if not exists raw_fda_observations (
      id bigserial primary key,
      source_id text not null unique,
      endpoint text not null,
      event_date date,
      title text not null,
      summary text not null,
      source_url text,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists raw_fda_observations_endpoint_date_idx
    on raw_fda_observations (endpoint, event_date desc)
  `;


  await sql`
    create table if not exists raw_fda_events (
      id bigserial primary key,
      source_id text not null,
      endpoint text not null,
      ticker text not null,
      matched_term text not null,
      category text not null,
      event_date date,
      title text not null,
      summary text not null,
      source_url text,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(source_id, ticker, matched_term)
    )
  `;

  await sql`
    create index if not exists raw_fda_events_ticker_date_idx
    on raw_fda_events (ticker, event_date desc)
  `;

  await sql`
    create index if not exists raw_fda_events_category_date_idx
    on raw_fda_events (category, event_date desc)
  `;



  await sql`
    create table if not exists raw_congress_trades (
      id bigserial primary key,
      source_id text not null unique,
      provider text not null,
      ticker text not null,
      politician text,
      chamber text,
      transaction_type text,
      amount_range text,
      transaction_date date,
      report_date date,
      reporting_delay_days integer,
      asset_description text,
      source_url text,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists raw_congress_trades_ticker_date_idx
    on raw_congress_trades (ticker, transaction_date desc)
  `;

  await sql`
    create index if not exists raw_congress_trades_report_date_idx
    on raw_congress_trades (report_date desc)
  `;



  await sql`
    create table if not exists raw_news_articles (
      id bigserial primary key,
      provider text not null,
      article_id text not null,
      ticker text not null,
      headline text not null,
      summary text not null,
      source text,
      url text,
      published_at timestamptz,
      symbols jsonb not null default '[]'::jsonb,
      raw_payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(provider, article_id)
    )
  `;

  await sql`
    create index if not exists raw_news_articles_ticker_published_idx
    on raw_news_articles (ticker, published_at desc)
  `;


  await sql`
    create table if not exists telegram_alerts (
      id bigserial primary key,
      scored_signal_id bigint references scored_signals(id) on delete cascade,
      accession_number text,
      ticker text,
      alert_type text not null default 'signal',
      telegram_chat_id text not null,
      message text not null,
      telegram_message_id bigint,
      created_at timestamptz not null default now(),
      unique(scored_signal_id, alert_type, telegram_chat_id)
    )
  `;

  await sql`
    create index if not exists telegram_alerts_created_idx
    on telegram_alerts (created_at desc)
  `;


  await sql`
    create table if not exists paper_trade_decisions (
      id bigserial primary key,
      scored_signal_id bigint not null references scored_signals(id) on delete cascade,
      accession_number text not null,
      ticker text not null,
      decision text not null,
      final_score integer not null,
      action text not null,
      reject_codes jsonb not null default '[]'::jsonb,
      reason_codes jsonb not null default '[]'::jsonb,
      raw_payload jsonb not null,
      created_at timestamptz not null default now(),
      unique(scored_signal_id)
    )
  `;

  await sql`
    create index if not exists paper_trade_decisions_created_idx
    on paper_trade_decisions (created_at desc)
  `;

  await sql`
    create index if not exists paper_trade_decisions_ticker_created_idx
    on paper_trade_decisions (ticker, created_at desc)
  `;

  await sql`
    create table if not exists paper_trades (
      id bigserial primary key,
      scored_signal_id bigint not null references scored_signals(id) on delete cascade,
      confirmation_id bigint references alpaca_market_confirmations(id) on delete set null,
      accession_number text not null,
      ticker text not null,
      side text not null,
      status text not null default 'open',
      entry_price numeric,
      stop_price numeric,
      target_price numeric,
      exit_price numeric,
      final_score integer not null,
      decision_reason text not null,
      raw_payload jsonb not null,
      opened_at timestamptz not null default now(),
      closed_at timestamptz,
      close_reason text,
      outcome text,
      pnl_percent numeric,
      unique(scored_signal_id)
    )
  `;

  await sql`alter table paper_trades add column if not exists close_reason text`;
  await sql`alter table paper_trades add column if not exists outcome text`;
  await sql`alter table paper_trades add column if not exists pnl_percent numeric`;

  await sql`
    create index if not exists paper_trades_status_opened_idx
    on paper_trades (status, opened_at desc)
  `;

  await sql`
    create index if not exists paper_trades_ticker_opened_idx
    on paper_trades (ticker, opened_at desc)
  `;


  await sql`
    create table if not exists pipeline_runs (
      id bigserial primary key,
      status text not null,
      started_at timestamptz not null,
      finished_at timestamptz not null,
      duration_ms integer not null default 0,
      steps_total integer not null default 0,
      steps_failed integer not null default 0,
      sec_filings_found integer not null default 0,
      sec_filings_saved integer not null default 0,
      ai_classified integer not null default 0,
      alpaca_confirmed integer not null default 0,
      signals_scored integer not null default 0,
      paper_trades_opened integer not null default 0,
      paper_trades_closed integer not null default 0,
      paper_trades_rejected integer not null default 0,
      summary jsonb not null default '{}'::jsonb,
      steps jsonb not null default '[]'::jsonb,
      errors jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists pipeline_runs_created_idx
    on pipeline_runs (created_at desc)
  `;

}
