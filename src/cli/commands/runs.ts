

// The command shape every command file declares for itself (see status.ts): cli modules are not imported.
interface CommandContext {
  cwd: string;
  flags: { outputFormat?: "text" | "json" | "stream-json"; noFollow?: boolean; allProjects?: boolean };
  rawArgs: string[];
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

interface CliCommand {
  name: string;
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);
const { formatCost } = await import(`../progress.js`);
const { countsOf, listAllRuns, listRuns, requestOf, statusWordOf, taskRowsOf } = await import(`../../observe/run-observe.js`);
const { mergedOf } = await import(`../run-view.js`);

/** A time as the runs list shows it: how long ago, in the largest sensible unit. */
function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * `substrate runs` (R10.2): the runs in this project, newest first, one line each. A run is
 * `running` only while its process holds the lock; a run with no terminal event and no live
 * process is `stopped`. Reads only: nothing is written and no lock is taken.
 *
 * `--all-projects` (web-ui design, section 6.1) lists the runs of every project in the registry,
 * newest first, each row naming its project: the path in json, the name in text.
 */
export const runsCommand: CliCommand = {
  name: "runs",
  description: "List the runs in this project, newest first, with their status",
  async execute(ctx: CommandContext): Promise<number> {
    const allProjects = ctx.flags.allProjects === true;
    const entries = allProjects
      ? listAllRuns().map(({ project, projectName, record }) => ({ cwd: project, projectName, record }))
      : listRuns(ctx.cwd).map((record) => ({ cwd: ctx.cwd, projectName: undefined, record }));
    const now = Date.now();
    const rows = entries.map(({ cwd, projectName, record }) => {
      const tasks = taskRowsOf(record);
      return {
        cwd,
        projectName,
        record,
        tasks,
        passed: countsOf(tasks).passed,
        merged: mergedOf(cwd, record),
      };
    });

    if (ctx.flags.outputFormat === "json") {
      const payload = rows.map(({ cwd, projectName, record, tasks, passed, merged }) => ({
        run_id: record.runId,
        status: record.status,
        started_at: record.createdAt !== undefined ? new Date(record.createdAt).toISOString() : null,
        cost_usd: record.state.usage.total_usd,
        passed,
        total: tasks.length,
        merged,
        request: requestOf(record.events).slice(0, 200),
        ...(allProjects ? { project: cwd, project_name: projectName } : {}),
      }));
      ctx.stdout.write(JSON.stringify(payload) + "\n");
      return 0;
    }

    if (rows.length === 0) {
      ctx.stdout.write("No runs yet\n");
      return 0;
    }
    for (const { projectName, record, tasks, passed, merged } of rows) {
      const started = record.createdAt !== undefined
        ? `${agoText(record.createdAt, now)} (${new Date(record.createdAt).toISOString()})`
        : "-";
      const request = requestOf(record.events).replace(/\s+/g, " ").slice(0, 60);
      const project = projectName !== undefined ? `${projectName}  ` : "";
      ctx.stdout.write(
        `${record.runId.padEnd(16)} ${statusWordOf(record).padEnd(9)} ${started}  ${formatCost(record.state.usage.total_usd)}  ` +
          `${passed}/${tasks.length} passed  merged ${merged ? "yes" : "no"}  ${project}${request}\n`,
      );
    }
    return 0;
  },
};

registry.register(runsCommand);
