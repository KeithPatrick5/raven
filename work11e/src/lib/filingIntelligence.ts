export type FilingPriority = "critical" | "high" | "medium" | "low" | "noise";

export type FilingIntelligence = {
  priority: FilingPriority;
  priorityScore: number;
  materiality: "material" | "possibly_material" | "routine" | "unknown";
  formFamily: string;
  isRoutineForm4: boolean;
  shouldClassify: boolean;
  reasons: string[];
};

const CRITICAL_FORMS = new Set(["424B5", "NT 10-Q", "NT 10-K"]);
const HIGH_FORMS = new Set(["8-K", "S-1", "S-3", "SC 13D", "SC 13D/A", "13D"]);
const MEDIUM_FORMS = new Set(["10-Q", "10-K", "SC 13G", "SC 13G/A", "13G", "DEF 14A"]);
const LOW_FORMS = new Set(["4"]);

function normalizeForm(form: string): string {
  return form.trim().toUpperCase();
}

function textIncludesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function rawText(rawPayload: Record<string, unknown> | null | undefined): string {
  if (!rawPayload) return "";
  return [
    rawPayload.primaryDocDescription,
    rawPayload.items,
    rawPayload.primaryDocument,
    rawPayload.fileNumber
  ]
    .filter(Boolean)
    .map(String)
    .join(" ");
}

export function analyzeFilingPriority(input: {
  form: string;
  primaryDocument?: string | null;
  primaryDocDescription?: string | null;
  items?: string | null;
  rawPayload?: Record<string, unknown> | null;
}): FilingIntelligence {
  const form = normalizeForm(input.form);
  const text = [
    input.primaryDocument,
    input.primaryDocDescription,
    input.items,
    rawText(input.rawPayload)
  ]
    .filter(Boolean)
    .map(String)
    .join(" ");

  const reasons: string[] = [];
  let priority: FilingPriority = "noise";
  let priorityScore = 5;
  let materiality: FilingIntelligence["materiality"] = "unknown";
  let formFamily = "other";
  let isRoutineForm4 = false;

  if (CRITICAL_FORMS.has(form)) {
    priority = "critical";
    priorityScore = 95;
    materiality = "material";
    formFamily = form.includes("424") ? "offering_pricing" : "late_filing";
    reasons.push(`${form} is high-risk market-moving paperwork.`);
  } else if (HIGH_FORMS.has(form)) {
    priority = "high";
    priorityScore = 82;
    materiality = "material";
    formFamily = form.includes("13D") ? "activist_or_ownership" : form.includes("S-") ? "registration_or_shelf" : "material_event";
    reasons.push(`${form} is a priority SEC filing.`);
  } else if (MEDIUM_FORMS.has(form)) {
    priority = "medium";
    priorityScore = 55;
    materiality = "possibly_material";
    formFamily = form.includes("13G") ? "passive_ownership" : "periodic_report";
    reasons.push(`${form} is useful context but usually needs a specific red flag.`);
  } else if (LOW_FORMS.has(form)) {
    priority = "low";
    priorityScore = 25;
    materiality = "routine";
    formFamily = "insider_transaction";
    reasons.push("Form 4 is usually routine unless it is a real open-market buy or insider cluster.");
  }

  if (form === "4") {
    const routineTerms = [
      "tax withholding",
      "tax obligation",
      "withholding obligation",
      "restricted stock unit",
      "rsu",
      "rule 10b5-1",
      "10b5-1 trading plan",
      "automatic sale",
      "sell to cover",
      "shares were withheld"
    ];
    const buyTerms = ["open market purchase", "purchase of common stock", "acquired shares in the open market"];

    if (textIncludesAny(text, buyTerms)) {
      priority = "high";
      priorityScore = 76;
      materiality = "possibly_material";
      isRoutineForm4 = false;
      reasons.push("Form 4 appears to include open-market buying language.");
    } else if (textIncludesAny(text, routineTerms)) {
      priority = "noise";
      priorityScore = 8;
      materiality = "routine";
      isRoutineForm4 = true;
      reasons.push("Form 4 appears routine, tax-related, RSU-related, or 10b5-1 planned-sale noise.");
    }
  }

  if (form === "8-K" && textIncludesAny(text, ["entry into a material definitive agreement", "item 1.01"])) {
    priority = "high";
    priorityScore = Math.max(priorityScore, 84);
    materiality = "material";
    reasons.push("8-K may include a material agreement item.");
  }

  const shouldClassify = priority !== "noise" || form === "4";

  return {
    priority,
    priorityScore,
    materiality,
    formFamily,
    isRoutineForm4,
    shouldClassify,
    reasons
  };
}

export function priorityRank(priority: FilingPriority): number {
  switch (priority) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "noise":
      return 1;
    default:
      return 0;
  }
}
