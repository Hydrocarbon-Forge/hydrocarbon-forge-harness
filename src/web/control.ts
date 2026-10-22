import { endRunProcess, isSubstrateProcess, processInfoOf, startDetached } from "../util/process-control.js";
import type { ProjectRun } from "../observe/runs-view.js";
import { log } from "../util/log.js";
import { ApiError } from "./http.js";

// The two control actions of the job (docs/design/web-ui.md, 5.2): stop and resume. Both call the functions the
// `stop` and `resume` commands call (src/util/process-control.ts), so the browser and the CLI do the same thing.

export interface ControlAccepted {
  ref: string;
  status: "stopping" | "resuming";
}

/** Ends the run's process as `substrate stop <id>` does, in the background; the answer comes before the wait ends. */
export function stopRun(run: ProjectRun, ref: string): ControlAccepted {
  const proc = run.record.process;
  if (proc === undefined || !proc.alive) throw new ApiError("conflict", "the run is not running");
  if (!isSubstrateProcess(processInfoOf(proc.pid).args)) {
    throw new ApiError("conflict", "the run's pid is not a Substrate process (stale lock)");
  }
  endRunProcess(proc.pid, { force: false }).then(
    (outcome) => {
      if (outcome !== "stopped" && outcome !== "killed") log.warn(`run ${run.record.runId} did not stop (${outcome})`);
    },
    (err: unknown) => log.warn(`run ${run.record.runId} could not be stopped: ${err instanceof Error ? err.message : String(err)}`),
  );
  return { ref, status: "stopping" };
}

/**
 * Continues a run that is not live as `substrate resume <id> --detach` does: the CLI starts itself detached with the
 * same arguments. `answers` answer the run's questions (the CLI's --answers from stdin).
 */
export async function resumeRun(run: ProjectRun, ref: string, answers: Record<string, string> | undefined): Promise<ControlAccepted> {
  const { record } = run;
  if (record.process?.alive === true) throw new ApiError("conflict", "the run is live");
  if (record.state.state === "FINISHED") throw new ApiError("conflict", "the run is finished");
  if (answers !== undefined && record.state.pause_reason !== "needs_human") {
    throw new ApiError("conflict", "the run has no questions to answer");
  }
  const args = ["resume", record.runId];
  let stdin: string | undefined;
  if (answers !== undefined) {
    args.push("--answers", "-");
    stdin = JSON.stringify({ answers: Object.entries(answers).map(([id, text]) => ({ id, text })) });
  }
  let stderr = "";
  const code = await startDetached({
    cwd: run.project.path,
    args,
    ...(stdin !== undefined ? { stdin } : {}),
    stdout: { write: () => true },
    stderr: {
      write: (text: string) => {
        stderr += text;
        return true;
      },
    },
  });
  if (code !== 0) throw new ApiError("internal", stderr.trim().slice(-500) || `resume exited with ${code}`);
  return { ref, status: "resuming" };
}
