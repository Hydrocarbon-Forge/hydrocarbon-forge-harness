import fs from "node:fs";
import path from "node:path";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { currentVersion, readIndex, type ArchiveRecord } from "../../archive/index.js";

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
  allVersions?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
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

export const historyCommand: CliCommand = {
  name: "history",
  description: "List archived runs for the current version or all versions",
  async execute(ctx: CommandContext): Promise<number> {
    const substrateDir = path.join(ctx.cwd, ".substrate");
    const archiveDir = path.join(substrateDir, "archive");
    const jsonMode = ctx.flags.outputFormat === "json";
    const allVersions = Boolean(ctx.flags.allVersions);

    if (allVersions) {
      if (!fs.existsSync(archiveDir)) {
        if (jsonMode) {
          ctx.stdout.write(JSON.stringify({ versions: [] }) + "\n");
        } else {
          ctx.stdout.write("no archived runs\n");
        }
        return 0;
      }

      const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
      const versionDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      const versions: Array<{ version: string; runs: ArchiveRecord[] }> = [];
      let totalRuns = 0;
      for (const v of versionDirs) {
        const runs = readIndex(substrateDir, v);
        versions.push({ version: v, runs });
        totalRuns += runs.length;
      }

      if (totalRuns === 0 && !jsonMode) {
        ctx.stdout.write("no archived runs\n");
        return 0;
      }

      if (jsonMode) {
        ctx.stdout.write(JSON.stringify({ versions }) + "\n");
        return 0;
      }

      for (const v of versions) {
        for (const run of v.runs) {
          ctx.stdout.write(`${run.run_id} | ${run.status} | ${run.goal} | ${run.ended_at}\n`);
        }
      }
      return 0;
    }

    const version = currentVersion(substrateDir);
    const runs = readIndex(substrateDir, version);

    if (runs.length === 0) {
      if (jsonMode) {
        ctx.stdout.write(JSON.stringify({ version, runs: [] }) + "\n");
      } else {
        ctx.stdout.write("no archived runs\n");
      }
      return 0;
    }

    if (jsonMode) {
      ctx.stdout.write(JSON.stringify({ version, runs }) + "\n");
      return 0;
    }

    for (const run of runs) {
      ctx.stdout.write(`${run.run_id} | ${run.status} | ${run.goal} | ${run.ended_at}\n`);
    }
    return 0;
  },
};

registry.register(historyCommand);
