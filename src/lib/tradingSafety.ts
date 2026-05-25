export type TradingMode = "paper" | "live";

export type TradingSafetyStatus = {
  ok: boolean;
  phase: "TRADING_MODE_SAFETY_SWITCH";
  mode: TradingMode;
  requestedMode: string;
  paperExecutionEnabled: boolean;
  liveExecutionEnabled: boolean;
  killSwitch: boolean;
  liveConfirmationRequired: string;
  liveConfirmationProvided: boolean;
  paperBaseUrl: string;
  liveBaseUrl: string;
  paperKeysConfigured: boolean;
  liveKeysConfigured: boolean;
  currentExecutionTarget: "paper" | "blocked";
  liveOrderSubmission: "disabled" | "blocked";
  paperOrderSubmission: "disabled" | "enabled" | "blocked";
  safetyStatus: "safe_paper_mode" | "paper_execution_enabled" | "kill_switch_on" | "live_blocked" | "misconfigured";
  blocks: string[];
  warnings: string[];
};

const LIVE_CONFIRMATION_PHRASE = "I_UNDERSTAND_REAL_MONEY";

function boolEnv(name: string, defaultValue = false) {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value);
}

function env(name: string) {
  return (process.env[name] || "").trim();
}

export function getRequestedTradingMode(): string {
  return (process.env.RAVEN_TRADING_MODE || "paper").trim().toLowerCase();
}

export function getTradingMode(): TradingMode {
  return getRequestedTradingMode() === "live" ? "live" : "paper";
}

export function getPaperTradingBaseUrl() {
  return (process.env.ALPACA_PAPER_BASE_URL || "https://paper-api.alpaca.markets").replace(/\/$/, "");
}

export function getLiveTradingBaseUrl() {
  return (process.env.ALPACA_LIVE_BASE_URL || "https://api.alpaca.markets").replace(/\/$/, "");
}

export function paperKeysConfigured() {
  return Boolean(env("ALPACA_API_KEY_ID") || env("APCA_API_KEY_ID")) && Boolean(env("ALPACA_API_SECRET_KEY") || env("APCA_API_SECRET_KEY"));
}

export function liveKeysConfigured() {
  return Boolean(env("ALPACA_LIVE_API_KEY_ID")) && Boolean(env("ALPACA_LIVE_API_SECRET_KEY"));
}

export function getTradingSafetyStatus(): TradingSafetyStatus {
  const requestedMode = getRequestedTradingMode();
  const mode = getTradingMode();
  const paperExecutionEnabled = boolEnv("RAVEN_PAPER_TRADING_ENABLED", false);
  const liveExecutionEnabled = boolEnv("RAVEN_LIVE_TRADING_ENABLED", false);
  const killSwitch = boolEnv("RAVEN_KILL_SWITCH", false);
  const liveConfirmationProvided = env("RAVEN_LIVE_TRADING_CONFIRM") === LIVE_CONFIRMATION_PHRASE;
  const hasPaperKeys = paperKeysConfigured();
  const hasLiveKeys = liveKeysConfigured();
  const blocks: string[] = [];
  const warnings: string[] = [];

  if (requestedMode !== "paper" && requestedMode !== "live") {
    warnings.push(`Unknown RAVEN_TRADING_MODE=${requestedMode || "blank"}; Raven defaults to paper mode.`);
  }

  if (killSwitch) blocks.push("Kill switch is on. No new orders are allowed.");
  if (!hasPaperKeys) warnings.push("Paper Alpaca keys are not configured.");

  if (mode === "live") {
    blocks.push("Live mode is not enabled for execution in Phase 13F.");
    if (!liveExecutionEnabled) blocks.push("RAVEN_LIVE_TRADING_ENABLED is false.");
    if (!liveConfirmationProvided) blocks.push(`RAVEN_LIVE_TRADING_CONFIRM must equal ${LIVE_CONFIRMATION_PHRASE}.`);
    if (!hasLiveKeys) blocks.push("Live Alpaca keys are not configured.");
  }

  if (liveExecutionEnabled && mode !== "live") {
    blocks.push("RAVEN_LIVE_TRADING_ENABLED is true while RAVEN_TRADING_MODE is not live. Refusing execution.");
  }

  let safetyStatus: TradingSafetyStatus["safetyStatus"] = "safe_paper_mode";
  if (killSwitch) safetyStatus = "kill_switch_on";
  else if (mode === "live" || liveExecutionEnabled) safetyStatus = "live_blocked";
  else if (paperExecutionEnabled) safetyStatus = "paper_execution_enabled";
  else if (!hasPaperKeys) safetyStatus = "misconfigured";

  const paperOrderSubmission = killSwitch || mode !== "paper" || liveExecutionEnabled
    ? "blocked"
    : paperExecutionEnabled
      ? "enabled"
      : "disabled";

  return {
    ok: blocks.length === 0,
    phase: "TRADING_MODE_SAFETY_SWITCH",
    mode,
    requestedMode,
    paperExecutionEnabled,
    liveExecutionEnabled,
    killSwitch,
    liveConfirmationRequired: LIVE_CONFIRMATION_PHRASE,
    liveConfirmationProvided,
    paperBaseUrl: getPaperTradingBaseUrl(),
    liveBaseUrl: getLiveTradingBaseUrl(),
    paperKeysConfigured: hasPaperKeys,
    liveKeysConfigured: hasLiveKeys,
    currentExecutionTarget: mode === "paper" && !killSwitch && !liveExecutionEnabled ? "paper" : "blocked",
    liveOrderSubmission: "disabled",
    paperOrderSubmission,
    safetyStatus,
    blocks,
    warnings
  };
}

export function isPaperExecutionAllowedBySafety() {
  const status = getTradingSafetyStatus();
  return status.mode === "paper" && status.paperOrderSubmission === "enabled" && status.blocks.length === 0;
}

export function getTradingSafetyTextReport() {
  const status = getTradingSafetyStatus();
  const lines: string[] = [];

  lines.push("RAVEN TRADING SAFETY SWITCH");
  lines.push("===========================");
  lines.push(`Status: ${status.ok ? "ok" : "blocked"}`);
  lines.push(`Trading mode: ${status.mode}`);
  lines.push(`Requested mode: ${status.requestedMode || "paper"}`);
  lines.push(`Safety status: ${status.safetyStatus.split("_").join(" ")}`);
  lines.push("");
  lines.push("EXECUTION SWITCHES");
  lines.push("------------------");
  lines.push(`Paper execution enabled: ${status.paperExecutionEnabled ? "yes" : "no"}`);
  lines.push(`Paper order submission: ${status.paperOrderSubmission}`);
  lines.push(`Live execution enabled: ${status.liveExecutionEnabled ? "yes" : "no"}`);
  lines.push(`Live order submission: ${status.liveOrderSubmission}`);
  lines.push(`Kill switch: ${status.killSwitch ? "on" : "off"}`);
  lines.push("");
  lines.push("ALPACA TARGETS");
  lines.push("--------------");
  lines.push(`Paper base URL: ${status.paperBaseUrl}`);
  lines.push(`Paper keys configured: ${status.paperKeysConfigured ? "yes" : "no"}`);
  lines.push(`Live base URL: ${status.liveBaseUrl}`);
  lines.push(`Live keys configured: ${status.liveKeysConfigured ? "yes" : "no"}`);
  lines.push("");
  lines.push("LIVE SAFETY");
  lines.push("-----------");
  lines.push("Live trading remains disabled by default in Phase 13F.");
  lines.push(`To even arm live mode later, Raven requires RAVEN_TRADING_MODE=live, RAVEN_LIVE_TRADING_ENABLED=true, live keys, and RAVEN_LIVE_TRADING_CONFIRM=${status.liveConfirmationRequired}.`);
  lines.push("Current live order capability: disabled.");
  lines.push("");
  lines.push("BLOCKS");
  lines.push("------");
  if (!status.blocks.length) lines.push("None");
  for (const block of status.blocks) lines.push(`- ${block}`);
  lines.push("");
  lines.push("WARNINGS");
  lines.push("--------");
  if (!status.warnings.length) lines.push("None");
  for (const warning of status.warnings) lines.push(`- ${warning}`);
  lines.push("");
  lines.push("COPY NOTE");
  lines.push("---------");
  lines.push("Paste this report into ChatGPT when you want Raven trading safety help.");

  return lines.join("\n");
}
