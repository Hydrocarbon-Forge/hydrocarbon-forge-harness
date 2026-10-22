import { type DetachContext, startDetached } from "../util/process-control.js";

// R10.3: `run --detach` and `resume --detach`. The start itself (the child, the lock wait, the printed commands)
// lives in src/util/process-control.ts, where the web server also uses it. This file is the CLI's route into it.

/**
 * The `--detach` route of run and resume (R10.3): the CLI's own arguments minus --detach start the
 * child. stream-json cannot be followed from a detached start, so it is refused before anything runs.
 */
export async function detachFrom(ctx: {
  cwd: string;
  argv?: string[];
  flags: { outputFormat?: "text" | "json" | "stream-json" };
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  if (ctx.flags.outputFormat === "stream-json") {
    ctx.stderr.write("Error: --detach cannot stream; use substrate watch\n");
    return 2;
  }
  const start: DetachContext = {
    cwd: ctx.cwd,
    args: (ctx.argv ?? []).filter((arg) => arg !== "--detach"),
    outputFormat: ctx.flags.outputFormat,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  };
  if (ctx.stdin !== undefined) start.stdin = ctx.stdin;
  return startDetached(start);
}
