import { db, ensureRavenTables, hasDatabase } from "@/lib/db";
import { upsertSignalEvent } from "@/lib/signalEvents";

type FederalRegisterDoc = {
  document_number: string;
  title: string;
  type?: string;
  abstract?: string;
  publication_date?: string;
  html_url?: string;
  agencies?: Array<{ name?: string; slug?: string }>;
};

type RegulatoryWatchTerm = {
  term: string;
  category: string;
  tickers: string[];
  priority: "high" | "medium" | "low";
  confidence: number;
};

type RegulatoryCandidate = {
  documentNumber: string;
  ticker: string;
  term: string;
  category: string;
  documentType: string;
  publicationDate: string | null;
  title: string;
  summary: string;
  sourceUrl: string | null;
  agencies: string[];
  priority: "high" | "medium" | "low";
  materiality: "possibly_material" | "routine" | "unknown";
  confidence: number;
  action: "watch_only" | "ignore";
  status: "watch" | "ignored";
  visibleSignal: boolean;
  suppressionReason: string | null;
  rawPayload: Record<string, unknown>;
};

type RegulatorySignal = RegulatoryCandidate & {
  visibleSignal: true;
  suppressionReason: null;
};

const FEDERAL_REGISTER_API = "https://www.federalregister.gov/api/v1/documents.json";

const REGULATORY_WATCH_TERMS: RegulatoryWatchTerm[] = [
  { term: "quantum", category: "quantum_regulation", tickers: ["IONQ"], priority: "high", confidence: 62 },
  { term: "semiconductor", category: "chip_policy", tickers: ["PLTR", "IONQ"], priority: "medium", confidence: 54 },
  { term: "artificial intelligence", category: "ai_policy", tickers: ["PLTR"], priority: "medium", confidence: 56 },
  { term: "defense procurement", category: "defense_policy", tickers: ["PLTR", "IONQ"], priority: "medium", confidence: 52 },
  { term: "electric vehicle", category: "ev_policy", tickers: ["TSLA"], priority: "medium", confidence: 54 },
  { term: "vehicle safety", category: "vehicle_safety", tickers: ["TSLA"], priority: "medium", confidence: 52 },
  { term: "autonomous vehicle", category: "autonomy_policy", tickers: ["TSLA"], priority: "medium", confidence: 55 },
  { term: "synthetic biology", category: "synbio_policy", tickers: ["DNA"], priority: "medium", confidence: 58 },
  { term: "biotechnology", category: "biotech_policy", tickers: ["DNA"], priority: "medium", confidence: 50 },
  { term: "student loan", category: "student_lending_policy", tickers: ["SOFI"], priority: "medium", confidence: 56 },
  { term: "consumer financial protection", category: "consumer_finance_policy", tickers: ["SOFI"], priority: "medium", confidence: 54 },
  { term: "banking regulation", category: "banking_policy", tickers: ["SOFI"], priority: "low", confidence: 44 }
];

function daysAgoIso(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function compact(value: string | null | undefined, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function lower(value: string | null | undefined) {
  return compact(value).toLowerCase();
}

function agencyNames(doc: FederalRegisterDoc) {
  return (doc.agencies || [])
    .map((agency) => compact(agency.name))
    .filter(Boolean)
    .slice(0, 5);
}

function docText(doc: FederalRegisterDoc) {
  return `${doc.title || ""} ${doc.abstract || ""} ${agencyNames(doc).join(" ")}`.toLowerCase();
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function materialityFor(term: RegulatoryWatchTerm, doc: FederalRegisterDoc): RegulatoryCandidate["materiality"] {
  const type = lower(doc.type);
  const text = docText(doc);

  if (term.priority === "high") return "possibly_material";
  if (type.includes("rule") || type.includes("notice")) return "possibly_material";
  if (hasAny(text, [/proposed rule/, /final rule/, /sanction/, /tariff/, /export control/, /procurement/])) return "possibly_material";
  return "routine";
}

function actionFor(materiality: RegulatoryCandidate["materiality"], confidence: number): Pick<RegulatoryCandidate, "action" | "status"> {
  if (materiality === "possibly_material" && confidence >= 50) return { action: "watch_only", status: "watch" };
  return { action: "ignore", status: "ignored" };
}

function summarizeDoc(doc: FederalRegisterDoc, term: RegulatoryWatchTerm, ticker: string) {
  const agency = agencyNames(doc)[0] || "Federal Register";
  const abstract = compact(doc.abstract);
  const base = abstract || compact(doc.title);
  return `${ticker} matched ${term.category} through ${agency}. ${base.slice(0, 420)}${base.length > 420 ? "..." : ""}`;
}

function relevanceFor(term: RegulatoryWatchTerm, ticker: string, doc: FederalRegisterDoc) {
  const text = docText(doc);
  const title = lower(doc.title);
  const agencies = agencyNames(doc).join(" ").toLowerCase();

  if (ticker === "IONQ") {
    if (term.term === "quantum" && hasAny(text, [/quantum/, /qubit/, /quantum computing/, /quantum information/, /cryptograph/, /post-quantum/, /national quantum/])) return { visible: true, reason: null };
    if (hasAny(text, [/strategic command/, /defense/, /darpa/, /national lab/, /export control/, /advanced computing/]) && hasAny(text, [/quantum/, /computing/, /semiconductor/])) return { visible: true, reason: null };
    return { visible: false, reason: "suppressed_weak_quantum_policy_match" };
  }

  if (ticker === "PLTR") {
    if (hasAny(text, [/palantir/, /defense procurement/, /federal data/, /data platform/, /government software/, /federal it/, /dhs/, /intelligence/, /surveillance/, /cybersecurity/, /dod/, /department of defense/, /defense department/])) return { visible: true, reason: null };
    if (term.term === "artificial intelligence" && hasAny(text, [/artificial intelligence/, / ai /, /machine learning/]) && hasAny(text, [/procurement/, /defense/, /federal agency/, /cybersecurity/, /national security/, /data/])) return { visible: true, reason: null };
    return { visible: false, reason: "suppressed_weak_ai_policy_match" };
  }

  if (ticker === "SOFI") {
    if (hasAny(text, [/sofi/, /student loan/, /student lending/, /loan repayment/, /borrower defense/, /federal perkins loan/, /consumer financial protection/, /cfpb/, /credit reporting/, /banking regulation/, /lending/, /consumer credit/])) return { visible: true, reason: null };
    if (agencies.includes("education department") && hasAny(title, [/loan/, /borrower/, /pell/, /student/])) return { visible: true, reason: null };
    return { visible: false, reason: "suppressed_weak_student_or_finance_policy_match" };
  }

  if (ticker === "TSLA") {
    if (hasAny(text, [/tesla/, /electric vehicle/, /ev credit/, /clean vehicle/, /vehicle safety/, /nhtsa/, /autonomous vehicle/, /battery/, /emissions/, /tariff/, /import duty/, /charging infrastructure/])) return { visible: true, reason: null };
    return { visible: false, reason: "suppressed_weak_ev_policy_match" };
  }

  if (ticker === "DNA") {
    if (hasAny(text, [/ginkgo/, /ginkgo bioworks/, /synthetic biology/, /biosecurity/, /genetic engineering/, /genetically engineered/, /biomanufacturing/, /bio-manufacturing/, /biofoundry/, /cell programming/, /dna synthesis/])) return { visible: true, reason: null };
    return { visible: false, reason: "suppressed_weak_biotech_policy_match" };
  }

  return { visible: false, reason: "suppressed_unknown_ticker_policy_match" };
}

async function fetchFederalRegisterDocs(term: RegulatoryWatchTerm) {
  const params = new URLSearchParams();
  params.set("per_page", "10");
  params.set("order", "newest");
  params.set("conditions[term]", term.term);
  params.set("conditions[publication_date][gte]", daysAgoIso(45));
  params.set("fields[]", "document_number");
  params.append("fields[]", "title");
  params.append("fields[]", "type");
  params.append("fields[]", "abstract");
  params.append("fields[]", "publication_date");
  params.append("fields[]", "html_url");
  params.append("fields[]", "agencies");

  const url = `${FEDERAL_REGISTER_API}?${params.toString()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Federal Register returned ${response.status} for ${term.term}`);
  const payload = await response.json() as { results?: FederalRegisterDoc[] };
  return { url, docs: payload.results || [] };
}

function buildCandidates(term: RegulatoryWatchTerm, docs: FederalRegisterDoc[]) {
  const candidates: RegulatoryCandidate[] = [];

  for (const doc of docs) {
    if (!doc.document_number || !doc.title) continue;
    const materiality = materialityFor(term, doc);
    const baseConfidence = Math.max(0, Math.min(100, term.confidence + (materiality === "possibly_material" ? 6 : 0)));

    for (const ticker of term.tickers) {
      const relevance = relevanceFor(term, ticker, doc);
      const visibleSignal = relevance.visible;
      const confidence = visibleSignal ? baseConfidence : Math.max(10, Math.min(baseConfidence, 35));
      const actionStatus = visibleSignal ? actionFor(materiality, confidence) : { action: "ignore" as const, status: "ignored" as const };

      candidates.push({
        documentNumber: doc.document_number,
        ticker,
        term: term.term,
        category: term.category,
        documentType: compact(doc.type, "regulatory_document"),
        publicationDate: doc.publication_date || null,
        title: compact(doc.title),
        summary: summarizeDoc(doc, term, ticker),
        sourceUrl: doc.html_url || null,
        agencies: agencyNames(doc),
        priority: visibleSignal ? term.priority : "low",
        materiality: visibleSignal ? materiality : "routine",
        confidence,
        action: actionStatus.action,
        status: actionStatus.status,
        visibleSignal,
        suppressionReason: relevance.reason,
        rawPayload: { ...doc, matchedTerm: term.term, matchedCategory: term.category, ticker, visibleSignal, suppressionReason: relevance.reason }
      });
    }
  }

  return candidates;
}

async function saveFederalRegisterObservations(candidates: RegulatoryCandidate[]) {
  if (!hasDatabase()) return { saved: 0, skipped: candidates.length, database: "not_configured" as const, errors: [] as Array<{ documentNumber: string; error: string }> };

  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  const errors: Array<{ documentNumber: string; error: string }> = [];

  for (const candidate of candidates) {
    try {
      const sourceId = `${candidate.documentNumber}:${candidate.ticker}:${candidate.term}`;
      const result = await sql<Array<{ inserted: boolean }>>`
        insert into raw_federal_register_observations (
          source_id,
          document_number,
          ticker,
          matched_term,
          category,
          document_type,
          publication_date,
          title,
          summary,
          source_url,
          agencies,
          visible_signal,
          suppression_reason,
          raw_payload
        ) values (
          ${sourceId},
          ${candidate.documentNumber},
          ${candidate.ticker},
          ${candidate.term},
          ${candidate.category},
          ${candidate.documentType},
          ${candidate.publicationDate},
          ${candidate.title},
          ${candidate.summary},
          ${candidate.sourceUrl},
          ${JSON.stringify(candidate.agencies)}::jsonb,
          ${candidate.visibleSignal},
          ${candidate.suppressionReason},
          ${JSON.stringify(candidate.rawPayload)}::jsonb
        )
        on conflict (source_id) do update set
          category = excluded.category,
          document_type = excluded.document_type,
          publication_date = excluded.publication_date,
          title = excluded.title,
          summary = excluded.summary,
          source_url = excluded.source_url,
          agencies = excluded.agencies,
          visible_signal = excluded.visible_signal,
          suppression_reason = excluded.suppression_reason,
          raw_payload = excluded.raw_payload,
          updated_at = now()
        returning (xmax = 0) as inserted
      `;
      if (result[0]?.inserted) saved += 1;
    } catch (error) {
      errors.push({ documentNumber: candidate.documentNumber, error: error instanceof Error ? error.message : "Unknown Federal Register observation storage failure" });
    }
  }

  return { saved, skipped: candidates.length - saved, database: "configured" as const, errors };
}

async function saveRawFederalRegisterSignals(signals: RegulatorySignal[]) {
  if (!hasDatabase()) return { saved: 0, skipped: signals.length, database: "not_configured" as const, errors: [] as Array<{ documentNumber: string; error: string }> };

  await ensureRavenTables();
  const sql = db();
  let saved = 0;
  const errors: Array<{ documentNumber: string; error: string }> = [];

  for (const signal of signals) {
    try {
      const result = await sql<Array<{ inserted: boolean }>>`
        insert into raw_federal_register_docs (
          document_number,
          ticker,
          matched_term,
          category,
          document_type,
          publication_date,
          title,
          summary,
          source_url,
          agencies,
          raw_payload
        ) values (
          ${signal.documentNumber},
          ${signal.ticker},
          ${signal.term},
          ${signal.category},
          ${signal.documentType},
          ${signal.publicationDate},
          ${signal.title},
          ${signal.summary},
          ${signal.sourceUrl},
          ${JSON.stringify(signal.agencies)}::jsonb,
          ${JSON.stringify(signal.rawPayload)}::jsonb
        )
        on conflict (document_number, ticker, matched_term) do update set
          category = excluded.category,
          document_type = excluded.document_type,
          publication_date = excluded.publication_date,
          title = excluded.title,
          summary = excluded.summary,
          source_url = excluded.source_url,
          agencies = excluded.agencies,
          raw_payload = excluded.raw_payload,
          updated_at = now()
        returning (xmax = 0) as inserted
      `;
      if (result[0]?.inserted) saved += 1;
    } catch (error) {
      errors.push({ documentNumber: signal.documentNumber, error: error instanceof Error ? error.message : "Unknown Federal Register storage failure" });
    }
  }

  return { saved, skipped: signals.length - saved, database: "configured" as const, errors };
}

async function upsertFederalRegisterEvents(signals: RegulatorySignal[]) {
  let eventsCreatedOrUpdated = 0;
  const errors: Array<{ documentNumber: string; error: string }> = [];

  for (const signal of signals) {
    try {
      await upsertSignalEvent({
        source: "FED_REG",
        sourceEventId: `${signal.documentNumber}:${signal.ticker}:${signal.term}`,
        ticker: signal.ticker,
        eventType: signal.category,
        eventTime: signal.publicationDate,
        headline: `${signal.ticker} regulatory watch: ${signal.category}`,
        summary: signal.summary,
        sourceUrl: signal.sourceUrl,
        priority: signal.priority,
        materiality: signal.materiality,
        direction: "neutral",
        confidence: signal.confidence,
        status: signal.status,
        action: signal.action,
        metadata: {
          documentNumber: signal.documentNumber,
          term: signal.term,
          documentType: signal.documentType,
          agencies: signal.agencies,
          note: "Federal Register matches are strict regulatory context. Raven keeps weak matches raw-only and surfaces visible signals only when ticker relevance is strong."
        }
      });
      eventsCreatedOrUpdated += 1;
    } catch (error) {
      errors.push({ documentNumber: signal.documentNumber, error: error instanceof Error ? error.message : "Unknown Federal Register signal event failure" });
    }
  }

  return { eventsCreatedOrUpdated, errors };
}

export async function scanFederalRegisterSignals() {
  const errors: Array<{ term?: string; error: string }> = [];
  const candidatesByKey = new Map<string, RegulatoryCandidate>();

  for (const term of REGULATORY_WATCH_TERMS) {
    try {
      const fetched = await fetchFederalRegisterDocs(term);
      for (const candidate of buildCandidates(term, fetched.docs)) {
        const key = `${candidate.documentNumber}:${candidate.ticker}:${candidate.term}`;
        if (!candidatesByKey.has(key)) candidatesByKey.set(key, candidate);
      }
    } catch (error) {
      errors.push({ term: term.term, error: error instanceof Error ? error.message : "Unknown Federal Register fetch failure" });
    }
  }

  const candidates = [...candidatesByKey.values()];
  const rawStorage = await saveFederalRegisterObservations(candidates);

  const suppressed = candidates.filter((candidate) => !candidate.visibleSignal);
  const signals = candidates
    .filter((candidate): candidate is RegulatorySignal => candidate.visibleSignal)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 25);

  const storage = await saveRawFederalRegisterSignals(signals);
  const eventResult = await upsertFederalRegisterEvents(signals);
  const allErrors = [...errors, ...rawStorage.errors, ...storage.errors, ...eventResult.errors];

  return {
    ok: allErrors.length === 0 || candidates.length > 0,
    partial: allErrors.length > 0,
    watchTermCount: REGULATORY_WATCH_TERMS.length,
    rawCandidateCount: candidates.length,
    rawStorage,
    signalCount: signals.length,
    weakMatchesSuppressed: suppressed.length,
    storage,
    eventsCreatedOrUpdated: eventResult.eventsCreatedOrUpdated,
    signals: signals.map((signal) => ({
      ticker: signal.ticker,
      documentNumber: signal.documentNumber,
      publicationDate: signal.publicationDate,
      category: signal.category,
      priority: signal.priority,
      materiality: signal.materiality,
      action: signal.action,
      confidence: signal.confidence,
      title: signal.title
    })),
    suppressedSample: suppressed.slice(0, 10).map((candidate) => ({
      ticker: candidate.ticker,
      documentNumber: candidate.documentNumber,
      matchedTerm: candidate.term,
      category: candidate.category,
      reason: candidate.suppressionReason,
      title: candidate.title
    })),
    errors: allErrors
  };
}
