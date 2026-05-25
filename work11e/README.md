# Raven

Private AI trading scanner for public market signals.

Current phase: Phase 7A paper-trade decision engine.

Raven now scans SEC filings, stores raw filings, classifies filings with AI, confirms price/volume with Alpaca, scores signals, and can open simulated paper trades when deterministic rules pass.

Telegram is intentionally limited to test/status messages plus actual paper-trade openings. Raven does not send watchlist spam or "maybe trade this" alerts.

Live trading remains disabled.

## Phase 9 cron

Raven uses native Vercel Cron on Pro to call `/api/run` every 15 minutes on weekdays from 13:00 through 20:59 UTC.

Vercel automatically sends `Authorization: Bearer $CRON_SECRET` to cron endpoints when the project has a `CRON_SECRET` environment variable. Set `CRON_SECRET` to the same value as `RAVEN_CRON_SECRET`.
