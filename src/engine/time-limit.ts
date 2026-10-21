import type { Settings } from "../contracts/index.js";

/** The longest delay a timer accepts (about 24.8 days); a longer limit is clamped to it. */
const MAX_TIMER_MS = 2147483647;

/**
 * The run's wall-clock limit in seconds (R11.2, known issue 60): `budgets.run.max_wall_min` in minutes,
 * which `--timeout` and the request's `budget.max_wall_min` replace. Undefined when no limit is set; a
 * value of zero or less also means no limit.
 */
export function timeLimitSecondsOf(settings: Settings): number | undefined {
  const minutes = settings.budgets?.run?.max_wall_min;
  if (typeof minutes !== "number" || !(minutes > 0)) return undefined;
  return Math.round(minutes * 60000) / 1000;
}

/** A started run clock: `signal` aborts when the limit is reached; `clear` stops the timer when the run returns. */
export interface TimeLimit {
  signal: AbortSignal;
  clear(): void;
}

/**
 * Starts the clock of one `run` or `resume` process (R11.2). The timer is cleared by the caller when the
 * run returns, so it never keeps the process alive. Undefined when there is no limit.
 */
export function startTimeLimit(limitS: number | undefined): TimeLimit | undefined {
  if (limitS === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(limitS * 1000, MAX_TIMER_MS));
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
