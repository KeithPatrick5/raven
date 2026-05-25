import { db, ensureRavenTables, hasDatabase } from "@/lib/db";

type WindowKey = "1h" | "6h" | "12h" | "24h" | "7d";

const WINDOWS: Record<WindowKey, { label: string; hours: number }> = {
  "1h": { label: "Last 1 hour", hours: 1 },
  "6h": { label: "Last 6 hours", hours: 6 },
  "12h": { label: "Last 12 hours", hours: 12 },
  "24h": { label: "Last 24 hours", hours: 24 },
  "7d": { label: "Last 7 days", hours: 168 }
};

const GROQ_INPUT_COST_PER_MILLION = 0.59;
const GROQ_OUTPUT_COST_PER_MILLION = 0.79;

export function aiUsageWindow(input?: string | null): WindowKey {
  if (input === "1h" || input === "6h" || input === "12h" || input === "24h" || input === "7d") return input;
  return "24h";
}

export function estimateTokensFromText(text: string) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export async function ensureAiUsageTable() {
  await ensureRavenTables();
  const sql = db();

  await sql`
    create table if not exists ai_usage_events (
      id bigserial primary key,
      provider text not null default 'groq',
      model text not null,
      route text not null,
      purpose text not null,
      success boolean not null default false,
      status_code integer,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      total_tokens integer not null default 0,
      estimated_input_tokens integer not null default 0,
      estimated_output_tokens integer not null default 0,
      estimated_cost numeric not null default 0,
      duration_ms integer not null default 0,
      error_message text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists ai_usage_events_created_idx
    on ai_usage_events (created_at desc)
  `;

  await sql`
    create index if not exists ai_usage_events_provider_model_created_idx
    on ai_usage_events (provider, model, created_at desc)
  `;
}

function round(value: number, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function estimateGroqCost(inputTokens: number, outputTokens: number) {
  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * GROQ_INPUT_COST_PER_MILLION;
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * GROQ_OUTPUT_COST_PER_MILLION;
  return round(inputCost + outputCost, 6);
}

export async function logAiUsageEvent(input: {
  model: string;
  route: string;
  purpose: string;
  success: boolean;
  statusCode?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  estimatedInputTokens?: number | null;
  estimatedOutputTokens?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  if (!hasDatabase()) return { ok: false, database: "not_configured" as const };

  await ensureAiUsageTable();
  const sql = db();
  const inputTokens = Math.max(0, Math.round(input.inputTokens || 0));
  const outputTokens = Math.max(0, Math.round(input.outputTokens || 0));
  const totalTokens = Math.max(0, Math.round(input.totalTokens || inputTokens + outputTokens));
  const estimatedInputTokens = Math.max(0, Math.round(input.estimatedInputTokens || inputTokens || 0));
  const estimatedOutputTokens = Math.max(0, Math.round(input.estimatedOutputTokens || outputTokens || 0));
  const costInput = inputTokens || estimatedInputTokens;
  const costOutput = outputTokens || estimatedOutputTokens;

  await sql`
    insert into ai_usage_events (
      provider,
      model,
      route,
      purpose,
      success,
      status_code,
      input_tokens,
      output_tokens,
      total_tokens,
      estimated_input_tokens,
      estimated_output_tokens,
      estimated_cost,
      duration_ms,
      error_message,
      metadata
    ) values (
      'groq',
      ${input.model},
      ${input.route},
      ${input.purpose},
      ${input.success},
      ${input.statusCode ?? null},
      ${inputTokens},
      ${outputTokens},
      ${totalTokens},
      ${estimatedInputTokens},
      ${estimatedOutputTokens},
      ${estimateGroqCost(costInput, costOutput)},
      ${Math.max(0, Math.round(input.durationMs || 0))},
      ${input.errorMessage?.slice(0, 1000) || null},
      ${JSON.stringify(input.metadata || {})}::jsonb
    )
  `;

  return { ok: true, database: "configured" as const };
}

function money(value: number) {
  return `$${value.toFixed(4)}`;
}

function pctChange(value: number) {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(0);
}

export async function getAiUsageSnapshot(windowInput?: string | null) {
  const window = aiUsageWindow(windowInput);
  const config = WINDOWS[window];

  if (!hasDatabase()) {
    return {
      ok: false,
      phase: "AI_USAGE_METER",
      window,
      label: config.label,
      database: "not_configured" as const,
      calls: { total: 0, successful: 0, failed: 0 },
      tokens: { input: 0, output: 0, total: 0, estimatedInput: 0, estimatedOutput: 0 },
      cost: { estimated: 0 },
      models: [],
      routes: [],
      recent: [],
      errors: [{ error: "DATABASE_URL or STORAGE_URL is not configured." }]
    };
  }

  await ensureAiUsageTable();
  const sql = db();
  const rows = await sql<Array<{
    id: string;
    provider: string;
    model: string;
    route: string;
    purpose: string;
    success: boolean;
    status_code: number | null;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    estimated_input_tokens: number;
    estimated_output_tokens: number;
    estimated_cost: string;
    duration_ms: number;
    error_message: string | null;
    created_at: string;
  }>>`
    select
      id::text,
      provider,
      model,
      route,
      purpose,
      success,
      status_code,
      input_tokens,
      output_tokens,
      total_tokens,
      estimated_input_tokens,
      estimated_output_tokens,
      estimated_cost::text,
      duration_ms,
      error_message,
      created_at::text
    from ai_usage_events
    where created_at >= now() - (${config.hours}::text || ' hours')::interval
    order by created_at desc
  `;

  const total = rows.length;
  const successful = rows.filter((row) => row.success).length;
  const failed = total - successful;
  const inputTokens = rows.reduce((sum, row) => sum + Number(row.input_tokens || 0), 0);
  const outputTokens = rows.reduce((sum, row) => sum + Number(row.output_tokens || 0), 0);
  const totalTokens = rows.reduce((sum, row) => sum + Number(row.total_tokens || 0), 0);
  const estimatedInputTokens = rows.reduce((sum, row) => sum + Number(row.estimated_input_tokens || 0), 0);
  const estimatedOutputTokens = rows.reduce((sum, row) => sum + Number(row.estimated_output_tokens || 0), 0);
  const estimatedCost = rows.reduce((sum, row) => sum + Number(row.estimated_cost || 0), 0);

  const modelMap = new Map<string, { model: string; calls: number; totalTokens: number; estimatedCost: number }>();
  const routeMap = new Map<string, { route: string; calls: number; totalTokens: number; failed: number }>();

  for (const row of rows) {
    const model = modelMap.get(row.model) || { model: row.model, calls: 0, totalTokens: 0, estimatedCost: 0 };
    model.calls += 1;
    model.totalTokens += Number(row.total_tokens || 0);
    model.estimatedCost += Number(row.estimated_cost || 0);
    modelMap.set(row.model, model);

    const route = routeMap.get(row.route) || { route: row.route, calls: 0, totalTokens: 0, failed: 0 };
    route.calls += 1;
    route.totalTokens += Number(row.total_tokens || 0);
    if (!row.success) route.failed += 1;
    routeMap.set(row.route, route);
  }

  return {
    ok: true,
    phase: "AI_USAGE_METER",
    window,
    label: config.label,
    database: "configured" as const,
    generatedAt: new Date().toISOString(),
    calls: {
      total,
      successful,
      failed,
      successRate: total ? Number(((successful / total) * 100).toFixed(1)) : 0
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
      estimatedInput: estimatedInputTokens,
      estimatedOutput: estimatedOutputTokens,
      avgTotalPerCall: total ? Math.round(totalTokens / total) : 0
    },
    cost: {
      estimated: Number(estimatedCost.toFixed(6)),
      display: money(estimatedCost)
    },
    models: Array.from(modelMap.values()).sort((a, b) => b.calls - a.calls),
    routes: Array.from(routeMap.values()).sort((a, b) => b.calls - a.calls),
    recent: rows.slice(0, 10).map((row) => ({
      model: row.model,
      route: row.route,
      purpose: row.purpose,
      success: row.success,
      statusCode: row.status_code,
      totalTokens: row.total_tokens,
      estimatedTokens: row.estimated_input_tokens + row.estimated_output_tokens,
      durationMs: row.duration_ms,
      error: row.error_message,
      createdAt: row.created_at
    })),
    errors: []
  };
}

export async function getAiUsageReport(windowInput?: string | null) {
  const snapshot = await getAiUsageSnapshot(windowInput);
  const lines: string[] = [];
  lines.push("RAVEN GROQ USAGE REPORT");
  lines.push("========================");
  lines.push(`Status: ${snapshot.ok ? "ok" : "needs_attention"}`);
  lines.push(`Window: ${snapshot.label}`);
  lines.push(`Generated: ${"generatedAt" in snapshot ? snapshot.generatedAt : new Date().toISOString()}`);
  lines.push("");
  lines.push("OPERATOR READ");
  lines.push("-------------");
  if (!snapshot.ok) {
    lines.push("AI usage tracking is not available because the database is not configured.");
  } else if (snapshot.calls.total === 0) {
    lines.push("No Groq calls logged in this window yet. Usage tracking starts from this build going forward.");
  } else if (snapshot.calls.failed > 0) {
    lines.push(`Groq is being used, but ${snapshot.calls.failed} call(s) failed in this window. Check recent errors before increasing cadence.`);
  } else {
    lines.push(`Groq usage is clean in this window: ${snapshot.calls.total} call(s), ${snapshot.tokens.total.toLocaleString()} actual token(s), estimated cost ${snapshot.cost.display}.`);
  }
  lines.push("");
  lines.push("CALLS");
  lines.push("-----");
  lines.push(`Total calls: ${snapshot.calls.total}`);
  lines.push(`Successful: ${snapshot.calls.successful}`);
  lines.push(`Failed: ${snapshot.calls.failed}`);
  lines.push(`Success rate: ${snapshot.calls.successRate}%`);
  lines.push("");
  lines.push("TOKENS");
  lines.push("------");
  lines.push(`Input tokens: ${snapshot.tokens.input.toLocaleString()}`);
  lines.push(`Output tokens: ${snapshot.tokens.output.toLocaleString()}`);
  lines.push(`Total tokens: ${snapshot.tokens.total.toLocaleString()}`);
  lines.push(`Estimated prompt tokens logged: ${snapshot.tokens.estimatedInput.toLocaleString()}`);
  lines.push(`Average actual tokens / call: ${(snapshot.tokens.avgTotalPerCall || 0).toLocaleString()}`);
  lines.push("");
  lines.push("COST ESTIMATE");
  lines.push("-------------");
  lines.push(`Estimated Groq cost: ${snapshot.cost.display}`);
  lines.push("Pricing estimate only. No hard usage limits are enforced by Raven in this phase.");
  lines.push("");
  lines.push("MODELS");
  lines.push("------");
  if (snapshot.models.length) {
    for (const model of snapshot.models.slice(0, 6)) {
      lines.push(`- ${model.model}: ${model.calls} call(s), ${model.totalTokens.toLocaleString()} tokens, ${money(model.estimatedCost)}`);
    }
  } else {
    lines.push("None");
  }
  lines.push("");
  lines.push("ROUTES");
  lines.push("------");
  if (snapshot.routes.length) {
    for (const route of snapshot.routes.slice(0, 6)) {
      lines.push(`- ${route.route}: ${route.calls} call(s), ${route.totalTokens.toLocaleString()} tokens, failed ${route.failed}`);
    }
  } else {
    lines.push("None");
  }
  lines.push("");
  lines.push("RECENT CALLS");
  lines.push("------------");
  if (snapshot.recent.length) {
    for (const row of snapshot.recent.slice(0, 8)) {
      lines.push(`- ${row.createdAt} | ${row.route} | ${row.success ? "ok" : "failed"} | ${row.totalTokens.toLocaleString()} tokens | ${pctChange(row.durationMs)}ms`);
    }
  } else {
    lines.push("None");
  }
  lines.push("");
  lines.push("COPY NOTE");
  lines.push("---------");
  lines.push("Paste this report into ChatGPT when you want Groq usage/cadence help.");
  return lines.join("\n");
}
