import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { upsertSignalEvent } from "@/lib/signalEvents";
import { watchlist } from "@/lib/watchlist";

type AlpacaNewsArticle = {
  id?: number | string;
  author?: string;
  headline?: string;
  summary?: string;
  content?: string;
  url?: string;
  images?: unknown[];
  symbols?: string[];
  created_at?: string;
  updated_at?: string;
  source?: string;
};

type RawNewsArticle = {
  provider: "alpaca";
  articleId: string;
  ticker: string;
  headline: string;
  summary: string;
  source: string | null;
  url: string | null;
  publishedAt: string | null;
  symbols: string[];
  rawPayload: Record<string, unknown>;
};

type NewsSignal = RawNewsArticle & {
  eventType: string;
  priority: "high" | "medium" | "low";
  materiality: "possibly_material" | "routine" | "unknown";
  direction: "bullish" | "bearish" | "neutral";
  action: "watch_only" | "ignore";
  status: "watch" | "ignored";
  confidence: number;
  reason: string;
};

type SuppressedNewsMatch = {
  articleId: string;
  ticker: string;
  reason: string;
  headline: string;
};

function apiKeyId() {
  return (process.env.ALPACA_API_KEY_ID || process.env.APCA_API_KEY_ID || "").trim();
}

function apiSecretKey() {
  return (process.env.ALPACA_API_SECRET_KEY || process.env.APCA_API_SECRET_KEY || "").trim();
}

function hasAlpacaProvider() {
  return Boolean(apiKeyId() && apiSecretKey());
}

function marketDataBaseUrl() {
  return (process.env.ALPACA_MARKET_DATA_BASE_URL || "https://data.alpaca.markets").replace(/\/$/, "");
}

function compact(value: unknown, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function isoDaysBack(daysBack: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysBack);
  return date.toISOString();
}

function normalizeSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compact(item).toUpperCase()).filter(Boolean);
}

function articleText(article: RawNewsArticle) {
  return `${article.headline} ${article.summary} ${article.symbols.join(" ")}`.toLowerCase();
}

const STRONG_BULLISH_TERMS = [
  "contract", "award", "government contract", "pentagon", "department of defense", "defense intelligence",
  "approval", "cleared", "merger", "acquisition", "strategic investment", "equity stake", "chips act",
  "$2b", "$2 billion", "funding", "raises guidance", "beats estimates", "record revenue"
];

const STRONG_BEARISH_TERMS = [
  "recall", "investigation", "probe", "sec charges", "lawsuit", "warning letter", "downgrade",
  "offering", "dilution", "cuts guidance", "halts", "bankruptcy", "delisting", "fraud"
];

const GENERIC_NOISE_TERMS = [
  "stock market today", "why shares are moving", "what's going on", "what is going on", "market update",
  "dow jumps", "nasdaq", "s&p 500", "watch these stocks", "most active", "premarket", "after-hours",
  "roundup", "meme stocks", "this week in", "top 10", "are the others in your portfolio", "opinion",
  "etf", "polymarket", "space x ipo vs", "spacex ipo vs", "same hype", "alien etf", "target selloff"
];

const COMPANY_TERMS: Record<string, string[]> = {
  IONQ: ["ionq", "quantum", "chips act", "commerce department", "government stake", "equity stake", "quantum companies"],
  PLTR: ["palantir", "pltr", "pentagon", "defense intelligence agency", "dia", "data analytics", "government contract", "defense contract"],
  SOFI: ["sofi", "student loan", "personal loan", "lending", "bank charter", "consumer finance"],
  TSLA: ["tesla", "tsla", "model y", "robotaxi", "nhtsa", "vehicle safety", "recall", "delivery", "ev credit"],
  DNA: ["ginkgo", "ginkgo bioworks", "synthetic biology", "biosecurity", "cell programming", "biofoundry"]
};

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function countMatches(text: string, terms: string[]) {
  return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
}

function isDirectCompanyMatch(article: RawNewsArticle, text: string) {
  const terms = COMPANY_TERMS[article.ticker] || [article.ticker.toLowerCase()];
  return article.symbols.includes(article.ticker) && includesAny(text, terms);
}

function isBasketArticle(article: RawNewsArticle) {
  return article.symbols.length >= 5;
}

function classifyNews(article: RawNewsArticle): NewsSignal | null {
  const text = articleText(article);
  const directCompanyMatch = isDirectCompanyMatch(article, text);
  const strongBullishCount = countMatches(text, STRONG_BULLISH_TERMS);
  const strongBearishCount = countMatches(text, STRONG_BEARISH_TERMS);
  const strongCatalystCount = strongBullishCount + strongBearishCount;
  const genericNoise = includesAny(text, GENERIC_NOISE_TERMS);
  const basketArticle = isBasketArticle(article);

  if (!directCompanyMatch) return null;
  if (genericNoise && strongCatalystCount < 2) return null;
  if (basketArticle && strongCatalystCount < 2) return null;
  if (strongCatalystCount === 0) return null;

  const direction: NewsSignal["direction"] = strongBearishCount > strongBullishCount ? "bearish" : strongBullishCount > strongBearishCount ? "bullish" : "neutral";
  const base = 38 + strongCatalystCount * 10 + (directCompanyMatch ? 8 : 0) - (basketArticle ? 8 : 0) - (genericNoise ? 8 : 0);
  const confidence = Math.max(20, Math.min(100, base));
  const materiality: NewsSignal["materiality"] = confidence >= 62 ? "possibly_material" : "routine";
  const priority: NewsSignal["priority"] = confidence >= 72 ? "high" : confidence >= 55 ? "medium" : "low";
  const action: NewsSignal["action"] = confidence >= 55 ? "watch_only" : "ignore";
  const eventType = strongBearishCount > 0 ? "news_risk" : strongBullishCount > 0 ? "news_confirmation" : "news_context";

  return {
    ...article,
    eventType,
    priority,
    materiality,
    direction,
    action,
    status: action === "watch_only" ? "watch" : "ignored",
    confidence,
    reason: `Strict news match: direct company/sector match with ${strongBullishCount} bullish catalyst terms and ${strongBearishCount} bearish catalyst terms.`
  };
}

async function fetchAlpacaNews(symbols: string[]) {
  const url = new URL(`${marketDataBaseUrl()}/v1beta1/news`);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("start", isoDaysBack(14));
  url.searchParams.set("limit", "50");
  url.searchParams.set("sort", "desc");

  const response = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": apiKeyId(),
      "APCA-API-SECRET-KEY": apiSecretKey(),
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    return { articles: [] as AlpacaNewsArticle[], error: `Alpaca news returned ${response.status}: ${body.slice(0, 180)}` };
  }

  const payload = await response.json() as { news?: AlpacaNewsArticle[] };
  return { articles: payload.news || [], error: null };
}

function normalizeArticle(article: AlpacaNewsArticle, ticker: string): RawNewsArticle | null {
  const id = compact(article.id || article.url || article.headline);
  const headline = compact(article.headline);
  if (!id || !headline) return null;

  return {
    provider: "alpaca",
    articleId: `alpaca:${id}:${ticker}`,
    ticker,
    headline: headline.slice(0, 260),
    summary: compact(article.summary || article.content || headline).slice(0, 900),
    source: compact(article.source || article.author) || null,
    url: compact(article.url) || null,
    publishedAt: compact(article.created_at || article.updated_at) || null,
    symbols: normalizeSymbols(article.symbols),
    rawPayload: article as Record<string, unknown>
  };
}

function normalizeArticles(articles: AlpacaNewsArticle[]) {
  const symbols = watchlist.map((item) => item.symbol.toUpperCase());
  const raw: RawNewsArticle[] = [];
  const seen = new Set<string>();

  for (const article of articles) {
    const articleSymbols = normalizeSymbols(article.symbols);
    const matchedSymbols = articleSymbols.length ? articleSymbols.filter((symbol) => symbols.includes(symbol)) : symbols.filter((symbol) => {
      const text = `${article.headline || ""} ${article.summary || ""}`.toUpperCase();
      return text.includes(symbol);
    });

    for (const ticker of matchedSymbols) {
      const normalized = normalizeArticle(article, ticker);
      if (!normalized) continue;
      if (seen.has(normalized.articleId)) continue;
      seen.add(normalized.articleId);
      raw.push(normalized);
    }
  }

  return raw;
}

async function saveRawNewsArticles(articles: RawNewsArticle[]) {
  if (!hasDatabase()) return { saved: 0, skipped: articles.length, database: "not_configured" as const, errors: [] as Array<{ articleId?: string; error: string }> };
  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  let skipped = 0;
  const errors: Array<{ articleId?: string; error: string }> = [];

  for (const article of articles) {
    try {
      const rows = await sql<Array<{ inserted: boolean }>>`
        insert into raw_news_articles (
          provider,
          article_id,
          ticker,
          headline,
          summary,
          source,
          url,
          published_at,
          symbols,
          raw_payload
        ) values (
          ${article.provider},
          ${article.articleId},
          ${article.ticker},
          ${article.headline},
          ${article.summary},
          ${article.source},
          ${article.url},
          ${article.publishedAt},
          ${JSON.stringify(article.symbols)}::jsonb,
          ${JSON.stringify(article.rawPayload)}::jsonb
        )
        on conflict (provider, article_id) do update set
          headline = excluded.headline,
          summary = excluded.summary,
          source = excluded.source,
          url = excluded.url,
          published_at = excluded.published_at,
          symbols = excluded.symbols,
          raw_payload = excluded.raw_payload,
          updated_at = now()
        returning (xmax = 0) as inserted
      `;

      if (rows[0]?.inserted) saved += 1;
      else skipped += 1;
    } catch (error) {
      errors.push({ articleId: article.articleId, error: error instanceof Error ? error.message : "Unknown news storage error" });
    }
  }

  return { saved, skipped, database: "configured" as const, errors };
}

async function saveNewsSignalEvents(signals: NewsSignal[]) {
  if (!hasDatabase()) return { saved: 0, skipped: signals.length, database: "not_configured" as const, errors: [] as Array<{ articleId?: string; error: string }> };
  let saved = 0;
  let skipped = 0;
  const errors: Array<{ articleId?: string; error: string }> = [];

  for (const signal of signals) {
    try {
      const result = await upsertSignalEvent({
        source: "NEWS",
        sourceEventId: signal.articleId,
        ticker: signal.ticker,
        eventType: signal.eventType,
        eventTime: signal.publishedAt,
        headline: `${signal.ticker} news: ${signal.eventType.replaceAll("_", " ")}`,
        summary: `${signal.headline}. ${signal.summary}`.slice(0, 1000),
        sourceUrl: signal.url,
        priority: signal.priority,
        materiality: signal.materiality,
        direction: signal.direction,
        confidence: signal.confidence,
        status: signal.status,
        action: signal.action,
        metadata: {
          provider: signal.provider,
          source: signal.source,
          symbols: signal.symbols,
          reason: signal.reason,
          note: "News is confirmation/context only. Raven does not trade from news alone."
        }
      });

      if (result?.id) saved += 1;
      else skipped += 1;
    } catch (error) {
      errors.push({ articleId: signal.articleId, error: error instanceof Error ? error.message : "Unknown news signal upsert error" });
    }
  }

  return { saved, skipped, database: "configured" as const, errors };
}


async function pruneStaleNewsSignalEvents(currentSignalIds: string[]) {
  if (!hasDatabase()) return { updated: 0, database: "not_configured" as const, errors: [] as Array<{ error: string }> };
  await ensureRavenTables();
  const sql = db();
  try {
    if (currentSignalIds.length === 0) {
      const rows = await sql<Array<{ updated: number }>>`
        with updated as (
          update signal_events
          set
            status = 'ignored',
            action = 'ignore',
            priority = case when priority = 'high' then 'medium' else priority end,
            confidence = least(confidence, 35),
            metadata = metadata || ${JSON.stringify({ suppressionReason: "news_relevance_tightened", note: "Old broad news event suppressed by stricter Raven news filter." })}::jsonb,
            updated_at = now()
          where source = 'NEWS'
          returning 1
        )
        select count(*)::integer as updated from updated
      `;
      return { updated: rows[0]?.updated || 0, database: "configured" as const, errors: [] };
    }

    const rows = await sql<Array<{ updated: number }>>`
      with keepers as (
        select unnest(${currentSignalIds}::text[]) as source_event_id
      ), updated as (
        update signal_events
        set
          status = 'ignored',
          action = 'ignore',
          priority = case when priority = 'high' then 'medium' else priority end,
          confidence = least(confidence, 35),
          metadata = metadata || ${JSON.stringify({ suppressionReason: "news_relevance_tightened", note: "Old broad news event suppressed by stricter Raven news filter." })}::jsonb,
          updated_at = now()
        where source = 'NEWS'
          and source_event_id not in (select source_event_id from keepers)
        returning 1
      )
      select count(*)::integer as updated from updated
    `;
    return { updated: rows[0]?.updated || 0, database: "configured" as const, errors: [] };
  } catch (error) {
    return { updated: 0, database: "configured" as const, errors: [{ error: error instanceof Error ? error.message : "Unknown news pruning error" }] };
  }
}

function buildSignals(rawArticles: RawNewsArticle[]) {
  const signals: NewsSignal[] = [];
  const suppressed: SuppressedNewsMatch[] = [];

  for (const article of rawArticles) {
    const signal = classifyNews(article);
    if (signal) {
      signals.push(signal);
    } else {
      suppressed.push({
        articleId: article.articleId,
        ticker: article.ticker,
        reason: "suppressed_general_or_unrelated_news",
        headline: article.headline
      });
    }
  }

  return { signals: signals.slice(0, 25), suppressed };
}

export async function scanNewsSignals() {
  const startedAt = new Date().toISOString();
  const symbols = watchlist.map((item) => item.symbol.toUpperCase());

  if (!hasAlpacaProvider()) {
    return {
      phase: "NEWS_SCANNER",
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      configured: false,
      provider: "alpaca",
      setupRequired: "Add ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY, and ALPACA_DATA_FEED=iex.",
      rawArticleCount: 0,
      signalCount: 0,
      errors: [{ error: "Alpaca market data/news credentials are not configured." }]
    };
  }

  const fetched = await fetchAlpacaNews(symbols);
  const rawArticles = normalizeArticles(fetched.articles);
  const rawStorage = await saveRawNewsArticles(rawArticles);
  const { signals, suppressed } = buildSignals(rawArticles);
  const signalStorage = await saveNewsSignalEvents(signals);
  const prunedSignalEvents = await pruneStaleNewsSignalEvents(signals.map((signal) => signal.articleId));
  const errors = [
    ...(fetched.error ? [{ provider: "alpaca", error: fetched.error }] : []),
    ...rawStorage.errors,
    ...signalStorage.errors,
    ...prunedSignalEvents.errors
  ];

  return {
    phase: "NEWS_SCANNER",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !fetched.error && errors.length === 0,
    partial: Boolean(fetched.error) || errors.length > 0,
    provider: "alpaca",
    configured: true,
    watchlistCount: symbols.length,
    rawProviderArticleCount: fetched.articles.length,
    rawArticleCount: rawArticles.length,
    rawStorage,
    signalCount: signals.length,
    weakMatchesSuppressed: suppressed.length,
    signalStorage,
    prunedSignalEvents,
    eventsCreatedOrUpdated: signalStorage.saved + signalStorage.skipped,
    signals: signals.map((signal) => ({
      ticker: signal.ticker,
      articleId: signal.articleId,
      publishedAt: signal.publishedAt,
      eventType: signal.eventType,
      priority: signal.priority,
      materiality: signal.materiality,
      action: signal.action,
      confidence: signal.confidence,
      direction: signal.direction,
      headline: signal.headline,
      url: signal.url
    })),
    suppressedSample: suppressed.slice(0, 10),
    errors
  };
}
