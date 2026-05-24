import postgres from "postgres";

let client: ReturnType<typeof postgres> | undefined;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function db() {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
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
}
