export type SecFilingClassification = {
  direction: "bullish" | "bearish" | "neutral" | "mixed";
  category: string;
  risk_level: "low" | "medium" | "high" | "extreme";
  tradeability: number;
  summary: string;
  bull_case: string;
  bear_case: string;
  verdict: "ignore" | "watch" | "paper_trade_candidate" | "avoid";
  confirmation_needed: string[];
  avoid_if: string[];
};

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

function cleanJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function normalizeClassification(payload: Record<string, unknown>): SecFilingClassification {
  const tradeability = Number(payload.tradeability ?? 0);
  const direction = String(payload.direction ?? "neutral").toLowerCase();
  const risk = String(payload.risk_level ?? "high").toLowerCase();
  const verdict = String(payload.verdict ?? "watch").toLowerCase();

  return {
    direction: ["bullish", "bearish", "neutral", "mixed"].includes(direction)
      ? (direction as SecFilingClassification["direction"])
      : "neutral",
    category: String(payload.category ?? "uncategorized").slice(0, 80),
    risk_level: ["low", "medium", "high", "extreme"].includes(risk)
      ? (risk as SecFilingClassification["risk_level"])
      : "high",
    tradeability: Number.isFinite(tradeability) ? Math.max(0, Math.min(100, Math.round(tradeability))) : 0,
    summary: String(payload.summary ?? "No summary returned.").slice(0, 1200),
    bull_case: String(payload.bull_case ?? "No bull case returned.").slice(0, 1200),
    bear_case: String(payload.bear_case ?? "No bear case returned.").slice(0, 1200),
    verdict: ["ignore", "watch", "paper_trade_candidate", "avoid"].includes(verdict)
      ? (verdict as SecFilingClassification["verdict"])
      : "watch",
    confirmation_needed: Array.isArray(payload.confirmation_needed)
      ? payload.confirmation_needed.map(String).slice(0, 8)
      : [],
    avoid_if: Array.isArray(payload.avoid_if)
      ? payload.avoid_if.map(String).slice(0, 8)
      : []
  };
}

export function hasAiProvider(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

export function aiModel(): string {
  return process.env.RAVEN_AI_MODEL?.trim() || DEFAULT_MODEL;
}

export async function classifySecFilingWithAi(input: {
  ticker: string;
  companyName?: string;
  form: string;
  filingDate: string | null;
  reportDate: string | null;
  accessionNumber: string;
  primaryDocumentUrl: string | null;
  filingText: string;
}): Promise<{ classification: SecFilingClassification; raw: Record<string, unknown>; model: string }> {
  const apiKey = process.env.GROQ_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  const model = aiModel();
  const filingText = input.filingText.slice(0, 6500);

  const prompt = `You are Raven, a cynical market filing analyst. Classify this public SEC filing for a private signal scanner. Do not hype trades. Separate useful public signal from noise. Return JSON only.\n\nRequired JSON shape:\n{\n  "direction": "bullish | bearish | neutral | mixed",\n  "category": "short category like insider_buy, dilution_risk, earnings, material_agreement, ownership, routine",\n  "risk_level": "low | medium | high | extreme",\n  "tradeability": 0-100,\n  "summary": "plain English filing summary in 1-2 short sentences",\n  "bull_case": "short bull case",\n  "bear_case": "short bear case",\n  "verdict": "ignore | watch | paper_trade_candidate | avoid",\n  "confirmation_needed": ["price/volume or filing confirmations needed"],\n  "avoid_if": ["conditions that invalidate or make it dangerous"]\n}\n\nFiling metadata:\nTicker: ${input.ticker}\nCompany: ${input.companyName || "unknown"}\nForm: ${input.form}\nFiling date: ${input.filingDate || "unknown"}\nReport date: ${input.reportDate || "unknown"}\nAccession: ${input.accessionNumber}\nDocument URL: ${input.primaryDocumentUrl || "none"}\n\nFiling text excerpt:\n${filingText}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 550,
      messages: [
        {
          role: "system",
          content:
            "You return strict JSON only. You are skeptical, concise, and focused on public-market signal quality. You never claim certainty."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq classification failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Groq returned no classification content.");
  }

  const parsed = JSON.parse(cleanJson(content)) as Record<string, unknown>;
  const classification = normalizeClassification(parsed);

  return { classification, raw: parsed, model };
}
