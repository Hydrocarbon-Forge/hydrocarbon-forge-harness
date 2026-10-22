// The Engine view: the run's journal (events.jsonl) as readable log lines, with the progress wording the CLI uses
// (`[task T1] merged`, `plan ready: 3 tasks`). Unknown events show their type and their data.

import { el, fmtClock, fmtCost, truncate } from "./util.js";

function list(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(", ") : "none";
}

function firstLine(text) {
  return String(text ?? "").split("\n")[0];
}

/** The text and tone of one event. Tone is one of: "", "ok", "warn", "err", "dim". */
export function describe(event) {
  const d = event.data ?? {};
  const tk = d.task_id ? `[task ${d.task_id}] ` : "";
  switch (event.type) {
    case "run.created":
      return ["", `run created: ${truncate(firstLine(d.prompt), 140)}`];
    case "plan.produced": {
      const count = Array.isArray(d.tasks) ? d.tasks.length : 0;
      const warnings = d.warning_count ? `, ${d.warning_count} warning(s)` : "";
      return [d.warning_count ? "warn" : "ok", `plan ready: ${count} task(s)${warnings}`];
    }
    case "plan.approved":
      return ["ok", "plan approved"];
    case "plan.rejected":
      return ["warn", `plan rejected: ${truncate(d.reason ?? d.message ?? "", 160)}`];
    case "setup.done":
      return ["", "setup done"];
    case "task.ready":
      return ["", `${tk}ready`];
    case "task.session.started":
      return ["", `${tk}worker started (session ${d.session_id ?? "?"})`];
    case "task.scope.checked":
      return ["dim", `${tk}changes checked against the write set`];
    case "task.verify.started":
      return ["", `${tk}verifying`];
    case "task.verify.finished":
      return [d.passed ? "ok" : "err", `${tk}${d.passed ? "verify passed" : "verify failed"}`];
    case "task.setup.failed":
      return ["warn", `${tk}setup failed (a warning): ${truncate(d.detail ?? d.message ?? "", 160)}`];
    case "task.healing":
      return ["warn", `${tk}retrying the attempt`];
    case "task.passed":
      return ["ok", `${tk}passed`];
    case "task.merged":
      return ["ok", `${tk}merged into the run branch`];
    case "task.failed":
      return ["err", `${tk}failed: ${d.failure_class ?? "unknown"}${d.detail ? ` - ${truncate(d.detail, 200)}` : ""}`];
    case "task.blocked":
      return ["warn", `${tk}blocked${d.reason ? `: ${d.reason}` : ""}`];
    case "task.skipped":
      return ["warn", `${tk}skipped${d.reason ? `: ${d.reason}` : ""}`];
    case "replan.started":
      return ["warn", `${tk}replan started (generation ${d.generation ?? "?"}${d.target_tier ? `, ${d.target_tier}` : ""}): ${truncate(d.reason ?? "", 160)}`];
    case "replan.l2":
      return ["warn", `${tk}replan at the plan level (generation ${d.generation ?? "?"})`];
    case "replan.finished":
      return ["", `${tk}replan finished (generation ${d.generation ?? "?"})`];
    case "integration.started":
      return ["", "integration verify started"];
    case "integration.finished":
      return [d.passed === true ? "ok" : "err", `integration verify ${d.passed === true ? "passed" : "failed"}`];
    case "integration.failed":
      return ["err", "integration verify failed"];
    case "integration.could_not_run":
      return ["warn", `integration verify could not run${d.reason ? `: ${truncate(d.reason, 160)}` : ""}`];
    case "integration.skipped":
      return ["dim", `integration verify skipped${d.reason ? ` (${d.reason})` : ""}`];
    case "integration.repair.started":
      return ["warn", `integration repair attempt ${d.attempt ?? "?"} started`];
    case "integration.repair.finished":
      return [d.passed === true ? "ok" : "err", `integration repair attempt ${d.attempt ?? "?"}: ${d.passed === true ? "passed" : "failed"}`];
    case "bisect.culprit":
      return ["err", `culprit: ${d.task_id ?? d.culprit ?? "unknown"}`];
    case "run.paused":
      return ["warn", `run paused${d.reason ? ` (${d.reason})` : ""}`];
    case "run.resumed":
      return ["", "run resumed"];
    case "run.stopped":
      return ["warn", "run stopped"];
    case "run.finished": {
      const code = d.exit_code !== undefined ? ` (exit ${d.exit_code})` : "";
      return [d.status === "failed" || d.exit_code ? "err" : "ok", `run finished: ${d.status ?? "done"}${code}`];
    }
    case "run.message":
      return ["", `planner message ${d.chat_id ?? ""} received`];
    case "run.amended": {
      const reason = d.reason ? `; ${truncate(d.reason, 160)}` : "";
      return [
        d.outcome === "rejected" ? "err" : "ok",
        `amendment ${d.outcome ?? ""} (${d.applied_at ?? "?"}): added ${list(d.added)}, changed ${list(d.changed)}, dropped ${list(d.dropped)}, kept ${list(d.kept_started)}${reason}`,
      ];
    }
    case "usage.recorded":
      return ["dim", `${d.role ?? "usage"}${d.task_id ? ` ${d.task_id}` : ""}: ${d.record ? fmtCost(d.record) : "-"}`];
    default:
      return ["dim", `${event.type} ${truncate(JSON.stringify(d), 160)}`];
  }
}

/** One engine event as a log line. */
export function renderEvent(event) {
  const [tone, text] = describe(event);
  return el(
    "div",
    { class: `log-line ${tone}`, data: { seq: event.seq } },
    el("time", { datetime: event.ts, text: fmtClock(event.ts) }),
    el("span", { class: "log-type", text: event.type }),
    el("span", { class: "log-text", text }),
  );
}
