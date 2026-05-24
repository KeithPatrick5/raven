# Raven

Private AI trading scanner for public market signals.

## Current phase

Phase 2 is wired:

- Private dashboard/watchlist shell
- SEC EDGAR scanner API route
- Optional Postgres raw filing storage
- Vercel-first architecture
- Live trading disabled

## Scanner route

After logging in, visit:

```text
/api/scan/sec
```

The route scans the seed watchlist, fetches recent SEC submissions, and returns normalized filings.

When `DATABASE_URL` is configured, Raven creates `raw_sec_filings` and inserts filings by accession number.

## Required env vars

```text
RAVEN_ACCESS_KEY=
RAVEN_SESSION_SALT=
```

## Optional env vars

```text
RAVEN_CRON_SECRET=
DATABASE_URL=
SEC_USER_AGENT=
```

Use `RAVEN_CRON_SECRET` later for external cron pings:

```text
/api/scan/sec?secret=YOUR_SECRET
```

## Locked Raven rules

- Vercel first
- No VPS dependency now
- SEC EDGAR first
- Alpaca confirmation later
- AI is the analyst, not the trader
- Alerts and paper trades before live trading
- Live trading disabled by default
