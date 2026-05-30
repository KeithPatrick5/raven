export type RavenMarketStatus = {
  phase: "RAVEN_MARKET_STATUS";
  status: "open" | "closed";
  isOpen: boolean;
  timezone: "America/New_York";
  nowEt: string;
  nextOpenLabel: string;
  brokerOrderPolicy: "regular_hours_only" | "queued_allowed";
  brokerOrdersAllowedNow: boolean;
  note: string;
};

function boolEnv(name: string, defaultValue = false) {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value);
}

function getEtParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    month: "short",
    day: "numeric"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  return {
    weekday: value("weekday"),
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    label: `${value("weekday")} ${value("month")} ${value("day")} ${String(Number.isFinite(hour) ? hour : 0).padStart(2, "0")}:${String(Number.isFinite(minute) ? minute : 0).padStart(2, "0")} ET`
  };
}

function isWeekday(weekday: string) {
  return !["Sat", "Sun"].includes(weekday);
}

function isRegularMarketOpen(date = new Date()) {
  const parts = getEtParts(date);
  const minutes = parts.hour * 60 + parts.minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return isWeekday(parts.weekday) && minutes >= open && minutes < close;
}

function nextOpenLabel(date = new Date()) {
  const parts = getEtParts(date);
  const minutes = parts.hour * 60 + parts.minute;
  const dayMs = 24 * 60 * 60 * 1000;

  if (isWeekday(parts.weekday) && minutes < 9 * 60 + 30) return "Today 9:30 AM ET";
  const next = new Date(date);
  for (let i = 1; i <= 7; i += 1) {
    const candidate = new Date(next.getTime() + i * dayMs);
    const candidateParts = getEtParts(candidate);
    if (isWeekday(candidateParts.weekday)) {
      if (i === 1) return "Next market day 9:30 AM ET";
      return `${candidateParts.weekday} 9:30 AM ET`;
    }
  }
  return "Next market day 9:30 AM ET";
}

export function getRavenMarketStatus(): RavenMarketStatus {
  const queueOutsideHours = boolEnv("RAVEN_ALLOW_QUEUED_BROKER_ORDERS", false);
  const isOpen = isRegularMarketOpen();
  return {
    phase: "RAVEN_MARKET_STATUS",
    status: isOpen ? "open" : "closed",
    isOpen,
    timezone: "America/New_York",
    nowEt: getEtParts().label,
    nextOpenLabel: isOpen ? "Market is open now" : nextOpenLabel(),
    brokerOrderPolicy: queueOutsideHours ? "queued_allowed" : "regular_hours_only",
    brokerOrdersAllowedNow: isOpen || queueOutsideHours,
    note: queueOutsideHours
      ? "Raven may submit Alpaca paper orders outside regular hours and let Alpaca queue them."
      : "Raven sim trades can run anytime. Alpaca paper broker orders are blocked outside regular market hours unless RAVEN_ALLOW_QUEUED_BROKER_ORDERS=true."
  };
}
