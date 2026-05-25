import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { upsertSignalEvent } from "@/lib/signalEvents";

type FdaEndpoint = "drug_enforcement" | "device_enforcement" | "food_enforcement";

type FdaWatchTerm = {
  term: string;
  ticker: string;
  category: string;
  priority: "high" | "medium" | "low";
  confidence: number;
  strength: "strong" | "medium" | "weak";
};

type FdaRawEvent = {
  endpoint: FdaEndpoint;
  sourceId: string;
  eventDate: string | null;
  title: string;
  summary: string;
  sourceUrl: string;
  rawPayload: Record<string, unknown>;
};

type FdaSignal = FdaRawEvent & {
  ticker: string;
  matchedTerm: string;
  category: string;
  priority: "high" | "medium" | "low";
  materiality: "possibly_material" | "routine" | "unknown";
  action: "watch_only" | "ignore";
  status: "watch" | "ignored";
  confidence: number;
  matchStrength: "strong" | "medium" | "weak";
  severity: "high" | "medium" | "low";
};

type SuppressedFdaMatch = {
  sourceId: string;
  ticker: string;
  matchedTerm: string;
  endpoint: FdaEndpoint;
  reason: string;
  title: string;
};

const OPENFDA_ENDPOINTS: Array<{ endpoint: FdaEndpoint; url: string; label: string }> = [
  { endpoint: "drug_enforcement", url: "https://api.fda.gov/drug/enforcement.json?sort=report_date:desc&limit=100", label: "Drug enforcement" },
  { endpoint: "device_enforcement", url: "https://api.fda.gov/device/enforcement.json?sort=event_date_initiated:desc&limit=100", label: "Device enforcement" },
  { endpoint: "food_enforcement", url: "https://api.fda.gov/food/enforcement.json?sort=report_date:desc&limit=100", label: "Food enforcement" }
];

const FDA_WATCH_TERMS: FdaWatchTerm[] = [
  { term: "ginkgo bioworks", ticker: "DNA", category: "company_direct_fda", priority: "high", confidence: 82, strength: "strong" },
  { term: "ginkgo", ticker: "DNA", category: "company_direct_fda", priority: "high", confidence: 78, strength: "strong" },
  { term: "biofoundry", ticker: "DNA", category: "synthetic_biology_fda", priority: "high", confidence: 72, strength: "strong" },
  { term: "cell programming", ticker: "DNA", category: "synthetic_biology_fda", priority: "high", confidence: 70, strength: "strong" },
  { term: "synthetic biology", ticker: "DNA", category: "synthetic_biology_fda", priority: "medium", confidence: 64, strength: "medium" },
  { term: "laboratory developed test", ticker: "DNA", category: "diagnostics_policy", priority: "medium", confidence: 58, strength: "medium" },
  { term: "gene therapy", ticker: "DNA", category: "biotech_regulatory", priority: "medium", confidence: 56, strength: "medium" },
  { term: "cell therapy", ticker: "DNA", category: "biotech_regulatory", priority: "medium", confidence: 56, strength: "medium" },
  { term: "biotechnology", ticker: "DNA", category: "biotech_regulatory", priority: "low", confidence: 38, strength: "weak" },
  { term: "diagnostic", ticker: "DNA", category: "diagnostics_policy", priority: "low", confidence: 34, strength: "weak" },
  { term: "genetic", ticker: "DNA", category: "biotech_regulatory", priority: "low", confidence: 34, strength: "weak" }
];

const LOW_VALUE_CONSUMER_TERMS = [
  "cough drop",
  "cough drops",
  "menthol",
  "oral anesthetic",
  "throat soothing",
  "food market",
  "honey lemon",
  "cherry flavor",
  "vanilla honey",
  "demulcent"
];

function compact(value: unknown, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function yyyymmddToIso(value: unknown) {
  const text = compact(value);
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}

function textBlob(event: FdaRawEvent) {
  return `${event.title} ${event.summary} ${JSON.stringify(event.rawPayload)}`.toLowerCase();
}

function eventSeverity(haystack: string): "high" | "medium" | "low" {
  if (
    haystack.includes("class i") ||
    haystack.includes("death") ||
    haystack.includes("life-threatening") ||
    haystack.includes("serious adverse") ||
    haystack.includes("serious injury") ||
    haystack.includes("contamination") ||
    haystack.includes("sterility") ||
    haystack.includes("warning letter")
  ) {
    return "high";
  }

  if (
    haystack.includes("class ii") ||
    haystack.includes("manufacturing violation") ||
    haystack.includes("device malfunction") ||
    haystack.includes("labeling issue") ||
    haystack.includes("recall") ||
    haystack.includes("quality")
  ) {
    return "medium";
  }

  return "low";
}

function isLowValueConsumerEvent(haystack: string) {
  return LOW_VALUE_CONSUMER_TERMS.some((term) => haystack.includes(term));
}

function shouldSurfaceFdaSignal(term: FdaWatchTerm, haystack: string, severity: "high" | "medium" | "low") {
  const consumerNoise = isLowValueConsumerEvent(haystack);

  if (term.strength === "strong") return { surface: true, reason: "direct_company_or_high_specificity_match" };

  if (term.strength === "medium" && severity !== "low" && !consumerNoise) {
    return { surface: true, reason: "specific_sector_match_with_meaningful_severity" };
  }

  if (term.strength === "weak" && severity === "high" && !consumerNoise) {
    return { surface: true, reason: "weak_sector_match_but_high_severity_event" };
  }

  return { surface: false, reason: consumerNoise ? "suppressed_consumer_product_noise" : "suppressed_broad_industry_match" };
}

function buildRawEvent(endpoint: FdaEndpoint, payload: Record<string, unknown>, index: number): FdaRawEvent {
  const recallNumber = compact(payload.recall_number) || compact(payload.event_id) || compact(payload.product_ndc) || `${endpoint}-${index}`;
  const reportDate = yyyymmddToIso(payload.report_date || payload.event_date_initiated || payload.recall_initiation_date);
  const product = compact(payload.product_description || payload.product_code_info || payload.product_quantity || payload.brand_name || "FDA event");
  const reason = compact(payload.reason_for_recall || payload.voluntary_mandated || payload.classification || payload.status || "FDA regulatory event");
  const firm = compact(payload.recalling_firm || payload.firm_name || payload.openfda || "FDA");
  const title = `${firm}: ${product}`.slice(0, 220);
  const summary = `${reason}${product ? ` Product: ${product}` : ""}`.slice(0, 700);

  return {
    endpoint,
    sourceId: `${endpoint}:${recallNumber}`,
    eventDate: reportDate,
    title,
    summary,
    sourceUrl: `https://open.fda.gov/apis/${endpoint.split("_")[0]}/enforcement/`,
    rawPayload: payload
  };
}

function findSignals(rawEvents: FdaRawEvent[]) {
  const signals: FdaSignal[] = [];
  const suppressed: SuppressedFdaMatch[] = [];
  const seen = new Set<string>();

  for (const event of rawEvents) {
    const haystack = textBlob(event);
    const severity = eventSeverity(haystack);

    for (const term of FDA_WATCH_TERMS) {
      if (!haystack.includes(term.term.toLowerCase())) continue;
      const key = `${event.sourceId}:${term.ticker}:${term.term}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const surfaceDecision = shouldSurfaceFdaSignal(term, haystack, severity);
      if (!surfaceDecision.surface) {
        suppressed.push({
          sourceId: event.sourceId,
          ticker: term.ticker,
          matchedTerm: term.term,
          endpoint: event.endpoint,
          reason: surfaceDecision.reason,
          title: event.title
        });
        continue;
      }

      const severityBoost = severity === "high" ? 12 : severity === "medium" ? 5 : 0;
      const confidence = Math.max(0, Math.min(100, term.confidence + severityBoost));
      const priority = severity === "high" ? "high" : term.priority;
      const materiality = confidence >= 50 ? "possibly_material" : "routine";
      const action = materiality === "possibly_material" && confidence >= 50 ? "watch_only" : "ignore";

      signals.push({
        ...event,
        ticker: term.ticker,
        matchedTerm: term.term,
        category: term.category,
        priority,
        materiality,
        action,
        status: action === "watch_only" ? "watch" : "ignored",
        confidence,
        matchStrength: term.strength,
        severity
      });
    }
  }

  return { signals: signals.slice(0, 50), suppressed };
}

async function fetchOpenFdaEndpoint(endpoint: { endpoint: FdaEndpoint; url: string }) {
  const response = await fetch(endpoint.url, { cache: "no-store" });
  if (response.status === 404) return { rawEvents: [] as FdaRawEvent[], error: null };
  if (!response.ok) return { rawEvents: [] as FdaRawEvent[], error: `openFDA ${endpoint.endpoint} returned ${response.status}` };
  const payload = await response.json() as { results?: Array<Record<string, unknown>> };
  const rawEvents = (payload.results || []).map((result, index) => buildRawEvent(endpoint.endpoint, result, index));
  return { rawEvents, error: null };
}

async function saveRawFdaObservations(rawEvents: FdaRawEvent[]) {
  if (!hasDatabase()) return { saved: 0, skipped: rawEvents.length, database: "not_configured" as const, errors: [] as Array<{ sourceId: string; error: string }> };

  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  const errors: Array<{ sourceId: string; error: string }> = [];

  for (const event of rawEvents) {
    try {
      const result = await sql<Array<{ inserted: boolean }>>`
        insert into raw_fda_observations (
          source_id,
          endpoint,
          event_date,
          title,
          summary,
          source_url,
          raw_payload
        ) values (
          ${event.sourceId},
          ${event.endpoint},
          ${event.eventDate},
          ${event.title},
          ${event.summary},
          ${event.sourceUrl},
          ${JSON.stringify(event.rawPayload)}::jsonb
        )
        on conflict (source_id) do update set
          endpoint = excluded.endpoint,
          event_date = excluded.event_date,
          title = excluded.title,
          summary = excluded.summary,
          source_url = excluded.source_url,
          raw_payload = excluded.raw_payload,
          updated_at = now()
        returning (xmax = 0) as inserted
      `;
      if (result[0]?.inserted) saved += 1;
    } catch (error) {
      errors.push({ sourceId: event.sourceId, error: error instanceof Error ? error.message : "Unknown raw FDA observation storage failure" });
    }
  }

  return { saved, skipped: rawEvents.length - saved, database: "configured" as const, errors };
}

async function saveRawFdaSignals(signals: FdaSignal[]) {
  if (!hasDatabase()) return { saved: 0, skipped: signals.length, database: "not_configured" as const, errors: [] as Array<{ sourceId: string; error: string }> };

  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  const errors: Array<{ sourceId: string; error: string }> = [];

  for (const signal of signals) {
    try {
      const result = await sql<Array<{ inserted: boolean }>>`
        insert into raw_fda_events (
          source_id,
          endpoint,
          ticker,
          matched_term,
          category,
          event_date,
          title,
          summary,
          source_url,
          raw_payload
        ) values (
          ${signal.sourceId},
          ${signal.endpoint},
          ${signal.ticker},
          ${signal.matchedTerm},
          ${signal.category},
          ${signal.eventDate},
          ${signal.title},
          ${signal.summary},
          ${signal.sourceUrl},
          ${JSON.stringify(signal.rawPayload)}::jsonb
        )
        on conflict (source_id, ticker, matched_term) do update set
          category = excluded.category,
          event_date = excluded.event_date,
          title = excluded.title,
          summary = excluded.summary,
          source_url = excluded.source_url,
          raw_payload = excluded.raw_payload,
          updated_at = now()
        returning (xmax = 0) as inserted
      `;
      if (result[0]?.inserted) saved += 1;
    } catch (error) {
      errors.push({ sourceId: signal.sourceId, error: error instanceof Error ? error.message : "Unknown FDA signal storage failure" });
    }
  }

  return { saved, skipped: signals.length - saved, database: "configured" as const, errors };
}

async function upsertFdaSignalEvents(signals: FdaSignal[]) {
  let eventsCreatedOrUpdated = 0;
  const errors: Array<{ sourceId: string; error: string }> = [];

  for (const signal of signals) {
    try {
      await upsertSignalEvent({
        source: "FDA",
        sourceEventId: `${signal.sourceId}:${signal.ticker}:${signal.matchedTerm}`,
        ticker: signal.ticker,
        eventType: signal.category,
        eventTime: signal.eventDate,
        headline: `${signal.ticker} FDA watch: ${signal.category}`,
        summary: `${signal.ticker} matched FDA/openFDA ${signal.endpoint} data for ${signal.matchedTerm}. ${signal.summary}`,
        sourceUrl: signal.sourceUrl,
        priority: signal.priority,
        materiality: signal.materiality,
        direction: "neutral",
        confidence: signal.confidence,
        status: signal.status,
        action: signal.action,
        metadata: {
          endpoint: signal.endpoint,
          matchedTerm: signal.matchedTerm,
          matchStrength: signal.matchStrength,
          severity: signal.severity,
          note: "FDA/openFDA raw data is archived broadly. Raven only surfaces FDA signals for strong company/product/facility matches or severe regulatory events."
        }
      });
      eventsCreatedOrUpdated += 1;
    } catch (error) {
      errors.push({ sourceId: signal.sourceId, error: error instanceof Error ? error.message : "Unknown FDA signal event failure" });
    }
  }

  return { eventsCreatedOrUpdated, errors };
}

export async function scanFdaSignals() {
  const startedAt = new Date().toISOString();
  const fetchErrors: Array<{ endpoint: string; error: string }> = [];
  const rawEvents: FdaRawEvent[] = [];

  for (const endpoint of OPENFDA_ENDPOINTS) {
    const result = await fetchOpenFdaEndpoint(endpoint);
    rawEvents.push(...result.rawEvents);
    if (result.error) fetchErrors.push({ endpoint: endpoint.endpoint, error: result.error });
  }

  const { signals, suppressed } = findSignals(rawEvents);
  const rawStorage = await saveRawFdaObservations(rawEvents);
  const signalStorage = await saveRawFdaSignals(signals);
  const events = await upsertFdaSignalEvents(signals);
  const hardErrors = [...rawStorage.errors, ...signalStorage.errors, ...events.errors];
  const partialErrors = fetchErrors;

  return {
    phase: "FDA_SCANNER",
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: hardErrors.length === 0,
    partial: partialErrors.length > 0,
    endpointCount: OPENFDA_ENDPOINTS.length,
    rawEventCount: rawEvents.length,
    rawStorage,
    watchTermCount: FDA_WATCH_TERMS.length,
    signalCount: signals.length,
    weakMatchesSuppressed: suppressed.length,
    signalStorage,
    eventsCreatedOrUpdated: events.eventsCreatedOrUpdated,
    signals: signals.slice(0, 25).map((signal) => ({
      ticker: signal.ticker,
      endpoint: signal.endpoint,
      eventDate: signal.eventDate,
      matchedTerm: signal.matchedTerm,
      matchStrength: signal.matchStrength,
      severity: signal.severity,
      category: signal.category,
      priority: signal.priority,
      materiality: signal.materiality,
      action: signal.action,
      confidence: signal.confidence,
      title: signal.title
    })),
    suppressedSample: suppressed.slice(0, 10),
    partialErrors,
    errors: hardErrors
  };
}
