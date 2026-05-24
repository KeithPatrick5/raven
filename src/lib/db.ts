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
}
