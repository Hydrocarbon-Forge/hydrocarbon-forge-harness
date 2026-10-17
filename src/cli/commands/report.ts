import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  noGovernor?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
}

export type ParsedCliFlags = CliGlobalFlags & CliGovernanceFlags;

export interface CommandContext {
  cwd: string;
  flags: ParsedCliFlags;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: Engine;
  sessionStore?: SessionStore;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);

export const reportCommand: CliCommand = {
  name: "report",
  description: "Generate diagnostic report for a run",
  async execute(ctx: CommandContext): Promise<number> {
    const runId = ctx.rawArgs[0];
    if (!runId) {
      ctx.stderr.write("Error: Run ID required\n");
      return 2;
    }

    const runDir = path.join(ctx.cwd, ".substrate", "runs", runId);
    if (!fs.existsSync(runDir)) {
      ctx.stderr.write(`Error: Run '${runId}' directory not found\n`);
      return 2;
    }

    let goal = "";
    const manifestPath = path.join(runDir, "manifest.yaml");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8"));
        goal = manifest.goal || "";
      } catch {
        // ignore
      }
    }

    const eventsPath = path.join(runDir, "events.jsonl");
    const events: any[] = [];
    if (fs.existsSync(eventsPath)) {
      try {
        const lines = fs
          .readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.trim().length > 0);
        for (const line of lines) {
          const ev = JSON.parse(line);
          events.push(ev);
          if (!goal && ev.type === "run.created" && ev.data?.goal) {
            goal = ev.data.goal;
          }
        }
      } catch {
        // ignore
      }
    }

    ctx.stdout.write(`=== Diagnostic Report for Run ${runId} ===\n\n`);
    ctx.stdout.write(`Goal: ${goal || "Unknown"}\n\n`);
    ctx.stdout.write(`Total Events: ${events.length}\n`);

    const replans = events.filter((e) => e.type?.includes("replan"));
    ctx.stdout.write(`Replan Iterations: ${replans.length}\n`);

    const failures = events.filter(
      (e) => e.type === "task.failed" || e.data?.failure_class,
    );
    ctx.stdout.write(`Task Failures: ${failures.length}\n`);

    return 0;
  },
};

registry.register(reportCommand);
