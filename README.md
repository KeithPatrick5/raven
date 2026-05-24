# Raven

Private AI trading scanner/bot for personal use only.

## Phase 1 included

- Vercel-ready Next.js app
- Dark dense Raven dashboard shell
- Watchlist table with seed tickers
- Mock signal feed placeholders
- Locked build-phase panel
- Optional private passcode gate using `RAVEN_ACCESS_KEY`
- No scanner, no Alpaca, no SEC logic yet

## Bible

Use Vercel for everything now. Do not require a VPS. Migrate scanner/workers to a VPS later only when one is available.

Raven starts as a scheduled public-signal scanner. AI is the analyst, not the trader. Live trading is disabled by default and comes later only after paper trading proves useful.

## Optional Vercel environment variables

Set these in Vercel if you want the dashboard protected by a passcode:

```bash
RAVEN_ACCESS_KEY=your-private-passcode
RAVEN_SESSION_SALT=a-long-random-string
```

If `RAVEN_ACCESS_KEY` is not set, the dashboard is open. That is useful for local testing but not recommended once deployed.

## Later env variables

```bash
DATABASE_URL=
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
AI_PROVIDER_API_KEY=
```

## Local commands

```bash
npm install
npm run dev
```

## Deploy path

Create a GitHub repo, push this project, then import the repo into Vercel.
