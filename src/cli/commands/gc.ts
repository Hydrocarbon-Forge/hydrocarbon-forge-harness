import fs from "node:fs";
import path from "node:path";

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
  olderThan?: string;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
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

function parseAgeToMs(spec: string): number | null {
  const match = spec.match(/^(\d+)([dhm])$/);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2];
  if (unit === "d") return count * 24 * 60 * 60 * 1000;
  if (unit === "h") return count * 60 * 60 * 1000;
  if (unit === "m") return count * 60 * 1000;
  return null;
}

export const gcCommand: CliCommand = {
  name: "gc",
  description: "Garbage-collect raw run data for runs that have an archive record older than the threshold",
  async execute(ctx: CommandContext): Promise<number> {
    const olderThan = ctx.flags.olderThan ?? "30d";
    const ageMs = parseAgeToMs(olderThan);

    if (ageMs === null) {
      ctx.stderr.write(`Error: invalid --older-than "${olderThan}"\n`);
      return 2;
    }

    const cutoff = Date.now() - ageMs;
    const substrateDir = path.join(ctx.cwd, ".substrate");
    const runsDir = path.join(substrateDir, "runs");
    const archiveDir = path.join(substrateDir, "archive");

    if (!fs.existsSync(runsDir)) {
      ctx.stdout.write("removed 0 run(s)\n");
      return 0;
    }

    const runEntries = fs.readdirSync(runsDir, { withFileTypes: true });
    let removedCount = 0;

    for (const entry of runEntries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      const runPath = path.join(runsDir, runId);

      // Check whether this run has an archive record and its summary.md mtime is older than cutoff
      let hasArchive = false;
      let summaryMtime: number | null = null;

      if (fs.existsSync(archiveDir)) {
        const versionDirs = fs
          .readdirSync(archiveDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);

        for (const v of versionDirs) {
          const summaryPath = path.join(archiveDir, v, runId, "summary.md");
          if (fs.existsSync(summaryPath)) {
            hasArchive = true;
            try {
              const stat = fs.statSync(summaryPath);
              if (summaryMtime === null || stat.mtimeMs < summaryMtime) {
                summaryMtime = stat.mtimeMs;
              }
            } catch {
              // ignore
            }
          }
        }
      }

      if (hasArchive && summaryMtime !== null && summaryMtime <= cutoff) {
        try {
          fs.rmSync(runPath, { recursive: true, force: true });
          removedCount++;
        } catch (err: any) {
          ctx.stderr.write(`warning: failed to remove ${runPath}: ${err?.message ?? String(err)}\n`);
        }
      }
    }

    ctx.stdout.write(`removed ${removedCount} run(s)\n`);
    return 0;
  },
};

registry.register(gcCommand);
