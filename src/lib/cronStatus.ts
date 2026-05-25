import { getLatestPipelineRuns } from "@/lib/pipelineRuns";

export type CronStatusSnapshot = {
  ok: boolean;
  phase: "CRON_STATUS";
  route: string;
  aliasRoute: string;
  schedule: string;
  scheduleLabel: string;
  timezone: "UTC";
  enabledInVercel: boolean;
  now: string;
  expected: {
    inWindow: boolean;
    lastExpectedRun: string | null;
    nextExpectedRun: string | null;
    nextExpectedRunInMinutes: number | null;
  };
  latestRun: null | {
    id: number;
    status: string;
    startedAt: string;
    finishedAt: string;
    createdAt: string;
    ageMinutes: number;
    durationMs: number;
    stepsFailed: number;
    secFilingsFound: number;
    secFilingsSaved: number;
    aiClassified: number;
    alpacaConfirmed: number;
    signalsScored: number;
    paperTradesOpened: number;
    paperTradesRejected: number;
    paperTradesClosed: number;
  };
  recentRuns: Array<{
    id: number;
    status: string;
    createdAt: string;
    ageMinutes: number;
    aiClassified: number;
    signalsScored: number;
    paperTradesOpened: number;
    paperTradesRejected: number;
  }>;
  diagnosis: string[];
};

export const CRON_ROUTE = "/api/run";
export const CRON_ALIAS_ROUTE = "/api/cron/run";
export const CRON_SCHEDULE = "*/15 13-20 * * 1-5";
export const CRON_SCHEDULE_LABEL = "Every 15 minutes on weekdays, 13:00-20:59 UTC";

function minutesBetween(a: Date, b: Date) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

function isWeekdayUtc(date: Date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

function isScheduledMinute(date: Date) {
  return date.getUTCMinutes() % 15 === 0;
}

function isInCronWindow(date: Date) {
  const hour = date.getUTCHours();
  return isWeekdayUtc(date) && hour >= 13 && hour <= 20;
}

function cloneDate(date: Date) {
  return new Date(date.getTime());
}

function floorToMinute(date: Date) {
  const copy = cloneDate(date);
  copy.setUTCSeconds(0, 0);
  return copy;
}

function findPreviousExpectedRun(now: Date) {
  const cursor = floorToMinute(now);
  for (let i = 0; i < 14 * 24 * 60; i += 1) {
    if (isInCronWindow(cursor) && isScheduledMinute(cursor) && cursor.getTime() <= now.getTime()) {
      return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
  }
  return null;
}

function findNextExpectedRun(now: Date) {
  const cursor = floorToMinute(now);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < 14 * 24 * 60; i += 1) {
    if (isInCronWindow(cursor) && isScheduledMinute(cursor)) {
      return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function toRunAge(now: Date, value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, minutesBetween(now, date));
}

export async function getCronStatusSnapshot(): Promise<CronStatusSnapshot> {
  const now = new Date();
  const runs = await getLatestPipelineRuns(8);
  const latest = runs[0] || null;
  const lastExpected = findPreviousExpectedRun(now);
  const nextExpected = findNextExpectedRun(now);
  const diagnosis: string[] = [];

  if (!latest) {
    diagnosis.push("No pipeline runs are stored yet. Either cron has not fired, the database is unavailable, or /api/run has not been called manually.");
  } else {
    diagnosis.push("Cron route is /api/run. The /api/cron/run route is only an alias for humans and debugging.");

    if (latest.ai_classified === 0 && latest.sec_filings_found > 0 && latest.sec_filings_saved === 0) {
      diagnosis.push("AI classified 0 because watchlist SEC saved 0 new rows. SEC Discovery fallback is now enabled, so Raven should promote one high-priority discovery candidate when available.");
    }

    if (latest.steps_failed === 0) {
      diagnosis.push("Latest stored run completed without failed steps.");
    } else {
      diagnosis.push(`Latest stored run needs attention: ${latest.steps_failed} step(s) failed.`);
    }

    if (lastExpected) {
      const latestCreated = new Date(latest.created_at);
      const lag = Number.isNaN(latestCreated.getTime()) ? null : minutesBetween(now, latestCreated);
      if (lag !== null && lag <= 35) {
        diagnosis.push("Recent run timing looks healthy for a 15-minute cron cadence.");
      } else if (lag !== null) {
        diagnosis.push(`Latest run is about ${lag} minute(s) old. Check Vercel Cron Jobs if this is during the scheduled UTC window.`);
      }
    }
  }

  return {
    ok: true,
    phase: "CRON_STATUS",
    route: CRON_ROUTE,
    aliasRoute: CRON_ALIAS_ROUTE,
    schedule: CRON_SCHEDULE,
    scheduleLabel: CRON_SCHEDULE_LABEL,
    timezone: "UTC",
    enabledInVercel: true,
    now: now.toISOString(),
    expected: {
      inWindow: isInCronWindow(now),
      lastExpectedRun: lastExpected ? lastExpected.toISOString() : null,
      nextExpectedRun: nextExpected ? nextExpected.toISOString() : null,
      nextExpectedRunInMinutes: nextExpected ? Math.max(0, minutesBetween(nextExpected, now)) : null
    },
    latestRun: latest ? {
      id: latest.id,
      status: latest.status,
      startedAt: latest.started_at,
      finishedAt: latest.finished_at,
      createdAt: latest.created_at,
      ageMinutes: toRunAge(now, latest.created_at),
      durationMs: latest.duration_ms,
      stepsFailed: latest.steps_failed,
      secFilingsFound: latest.sec_filings_found,
      secFilingsSaved: latest.sec_filings_saved,
      aiClassified: latest.ai_classified,
      alpacaConfirmed: latest.alpaca_confirmed,
      signalsScored: latest.signals_scored,
      paperTradesOpened: latest.paper_trades_opened,
      paperTradesRejected: latest.paper_trades_rejected,
      paperTradesClosed: latest.paper_trades_closed
    } : null,
    recentRuns: runs.map((run) => ({
      id: run.id,
      status: run.status,
      createdAt: run.created_at,
      ageMinutes: toRunAge(now, run.created_at),
      aiClassified: run.ai_classified,
      signalsScored: run.signals_scored,
      paperTradesOpened: run.paper_trades_opened,
      paperTradesRejected: run.paper_trades_rejected
    })),
    diagnosis
  };
}

export function buildCronStatusReport(snapshot: CronStatusSnapshot) {
  const latest = snapshot.latestRun;
  const lines = [
    "RAVEN CRON STATUS",
    "=================",
    `Status: ${snapshot.ok ? "ok" : "needs attention"}`,
    `Now: ${snapshot.now}`,
    `Route: ${snapshot.route}`,
    `Manual alias: ${snapshot.aliasRoute}`,
    `Schedule: ${snapshot.schedule}`,
    `Readable: ${snapshot.scheduleLabel}`,
    `Timezone: ${snapshot.timezone}`,
    `Currently in cron window: ${snapshot.expected.inWindow ? "yes" : "no"}`,
    `Last expected run: ${snapshot.expected.lastExpectedRun || "unknown"}`,
    `Next expected run: ${snapshot.expected.nextExpectedRun || "unknown"}`,
    "",
    "LATEST STORED RUN",
    "-----------------"
  ];

  if (latest) {
    lines.push(
      `#${latest.id} | ${latest.status} | age ${latest.ageMinutes}m | duration ${(latest.durationMs / 1000).toFixed(1)}s`,
      `Steps failed: ${latest.stepsFailed}`,
      `SEC: ${latest.secFilingsFound} found / ${latest.secFilingsSaved} new`,
      `AI classified: ${latest.aiClassified}`,
      `Alpaca confirmed: ${latest.alpacaConfirmed}`,
      `Signals scored: ${latest.signalsScored}`,
      `Paper opened/rejected/closed: ${latest.paperTradesOpened}/${latest.paperTradesRejected}/${latest.paperTradesClosed}`
    );
  } else {
    lines.push("No stored runs found.");
  }

  lines.push("", "DIAGNOSIS", "---------");
  if (snapshot.diagnosis.length) {
    for (const item of snapshot.diagnosis) lines.push(`- ${item}`);
  } else {
    lines.push("- No diagnosis messages.");
  }

  lines.push("", "RECENT RUNS", "-----------");
  if (snapshot.recentRuns.length) {
    for (const run of snapshot.recentRuns.slice(0, 8)) {
      lines.push(`#${run.id} | ${run.status} | age ${run.ageMinutes}m | AI ${run.aiClassified} | scored ${run.signalsScored} | opened ${run.paperTradesOpened} | rejected ${run.paperTradesRejected}`);
    }
  } else {
    lines.push("None");
  }

  lines.push("", "COPY NOTE", "---------", "Paste this report into ChatGPT when you want Raven cron help.");
  return `${lines.join("\n")}\n`;
}
