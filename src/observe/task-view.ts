import fs from "node:fs";
import path from "node:path";

import type { VerifyResult, WorkerReport } from "../contracts/index.js";
import { attemptReportsOf } from "./attempts.js";
import { artifactIndexOf, keyOfPath, type ArtifactRef } from "./artifacts.js";
import { taskRowsApiOf, type ProjectRun, type TaskRowApi } from "./runs-view.js";
import { sessionsOf, type SessionRef } from "./transcripts.js";

// The task detail of the web API (docs/design/web-ui.md, 5.2 GET /api/runs/:ref/tasks/:task): the task row, its spec,
// and every attempt with its report, verify results (each with the key of its saved full output) and patch.

export interface VerifyApi extends VerifyResult {
  full_output: ArtifactRef | null;
}

export interface AttemptDetail {
  generation: number;
  attempt: number;
  session_id: string | null;
  report: WorkerReport | null;
  verify: VerifyApi[];
  patch: ArtifactRef | null;
  packet: ArtifactRef | null;
}

export interface TaskDetail {
  task: TaskRowApi;
  spec_markdown: string | null;
  attempts: AttemptDetail[];
  integration_verify_for_task: VerifyApi[];
}

/** The task id as the run names it: a plain identifier, so it can be joined into a file name. */
export const TASK_ID = /^[A-Za-z0-9_.-]+$/;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Undefined when the run has no such task (the caller answers 404). */
export function taskDetailOf(run: ProjectRun, taskId: string, now: number): TaskDetail | undefined {
  if (!TASK_ID.test(taskId)) return undefined;
  const { record } = run;
  const runDir = record.runDir;
  const sessions: SessionRef[] = sessionsOf(runDir);
  const task = taskRowsApiOf(record, sessions, now).find((t) => t.id === taskId);
  if (task === undefined) return undefined;

  const index = artifactIndexOf(runDir);
  const withFullOutput = (verify: VerifyResult[]): VerifyApi[] =>
    verify.map((v) => ({ ...v, full_output: keyOfPath(index, v.full_output_path) }));

  const reports = attemptReportsOf(runDir).filter((r) => r.task_id === taskId);
  const attempts: AttemptDetail[] = reports.map((r) => {
    const passed = r.report.status === "passed";
    const patchPath = passed
      ? path.join("packets", "merged", `${taskId}-g${r.generation}.patch`)
      : path.join("packets", `${taskId}-g${r.generation}.patch`);
    const session = sessions.find((s) => s.session_id === r.report.session_id);
    return {
      generation: r.generation,
      attempt: r.attempt,
      session_id: session?.session_id ?? r.report.session_id ?? null,
      report: r.report,
      verify: withFullOutput(Array.isArray(r.report.verify) ? r.report.verify : []),
      patch: keyOfPath(index, patchPath),
      packet: keyOfPath(index, r.file),
    };
  });

  // A single-task plan skips the integration check; its own verify is shown under the task (design 5.2).
  const skipped = record.events.some(
    (e) => e.type === "integration.skipped" && (e.data as { reason?: unknown } | undefined)?.reason === "single_task",
  );
  const onlyTask = skipped && Object.keys(record.state.tasks).length === 1;
  const latest = attempts.at(-1);
  return {
    task,
    spec_markdown: readText(path.join(runDir, "tasks", `${taskId}.md`)),
    attempts,
    integration_verify_for_task: onlyTask && latest !== undefined ? latest.verify : [],
  };
}
