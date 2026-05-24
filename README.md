# Raven

Private Vercel-first AI trading scanner for public market signals.

## Current phase

Phase 3 is wired:

- Private dashboard/watchlist shell
- SEC EDGAR scanner at `/api/scan/sec`
- Raw SEC filing storage in Postgres
- AI filing classifier at `/api/classify/sec`
- Classified filing summaries stored in `sec_filing_summaries`

## Required env vars

```txt
RAVEN_ACCESS_KEY=
RAVEN_SESSION_SALT=
DATABASE_URL=        # or STORAGE_URL from Vercel/Neon
SEC_USER_AGENT=
GROQ_API_KEY=
```

Optional:

```txt
RAVEN_CRON_SECRET=
RAVEN_AI_MODEL=llama-3.3-70b-versatile
```

## Phase order

1. Dashboard/watchlist
2. SEC EDGAR scanner and raw storage
3. AI classifier/summarizer
4. Alpaca price/volume confirmation
5. Signal scoring
6. Telegram alerts
7. Dashboard signals
8. Paper trades

Live trading stays disabled by default.
