import fs from "node:fs";
import path from "node:path";

import type { BenchmarkArm, BenchmarkRunConfig } from "../../bench/types.js";
import { runBenchmarkSuite, formatBenchmarkReport } from "../../bench/index.js";

import type { Effort, Engine, PermissionMode } from "../contracts/index.js";
import type { SessionStore } from "../store/sessions.js";

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

const { registry } = await import(`./registry.js`);

const ALLOWED_FLAGS = new Set([
  "--tasks",
  "--arms",
  "--repetitions",
  "--max-budget",
  "--top-model",
  "--cheap-model",
  "--local-model",
  "--format",
  "--output",
  "--concurrency",
  "--dry-run",
]);

export const benchCommand: CliCommand = {
  name: "bench",
  description: "Run benchmark evaluation harness across arms A-D",
  async execute(ctx: CommandContext): Promise<number> {
    let tasks: string[] | undefined;
    let arms: BenchmarkArm[] | undefined;
    let repetitions = 3;
    let maxBudget: number | undefined;
    let topModel: string | undefined;
    let cheapModel: string | undefined;
    let localModel: string | undefined;
    let format: "text" | "json" | "markdown" = "text";
    let output: string | undefined;
    let concurrency: number | undefined;
    let dryRun = false;

    const args = ctx.rawArgs;
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
        const flagVal = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

        if (!ALLOWED_FLAGS.has(flagName)) {
          ctx.stderr.write(`Error: Unknown or invalid flag "${flagName}".\n`);
          return 2;
        }

        const getVal = (): string | undefined => {
          if (flagVal !== undefined) return flagVal;
          if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
            i++;
            return args[i];
          }
          return undefined;
        };

        switch (flagName) {
          case "--dry-run":
            dryRun = true;
            break;
          case "--tasks": {
            const val = getVal();
            if (!val) {
              ctx.stderr.write("Error: --tasks requires an argument\n");
              return 2;
            }
            tasks = val.split(",").map((s) => s.trim());
            break;
          }
          case "--arms": {
            const val = getVal();
            if (!val) {
              ctx.stderr.write("Error: --arms requires an argument\n");
              return 2;
            }
            const armList = val.split(",").map((s) => s.trim().toUpperCase());
            for (const a of armList) {
              if (a !== "A" && a !== "B" && a !== "C" && a !== "D") {
                ctx.stderr.write(
                  `Error: Invalid arm identifier "${a}". Allowed arms: A, B, C, D\n`
                );
                return 2;
              }
            }
            arms = armList as BenchmarkArm[];
            break;
          }
          case "--repetitions": {
            const val = getVal();
            const num = Number(val);
            if (!val || !Number.isInteger(num) || num <= 0) {
              ctx.stderr.write(
                "Error: --repetitions must be a positive integer greater than 0\n"
              );
              return 2;
            }
            repetitions = num;
            break;
          }
          case "--max-budget": {
            const val = getVal();
            const num = Number(val);
            if (!val || Number.isNaN(num) || num < 0) {
              ctx.stderr.write("Error: --max-budget cannot be negative\n");
              return 2;
            }
            maxBudget = num;
            break;
          }
          case "--format": {
            const val = getVal();
            if (val !== "text" && val !== "json" && val !== "markdown") {
              ctx.stderr.write(
                `Error: Invalid format "${val}". Allowed formats: text, json, markdown\n`
              );
              return 2;
            }
            format = val;
            break;
          }
          case "--output": {
            const val = getVal();
            if (!val) {
              ctx.stderr.write("Error: --output requires a file path\n");
              return 2;
            }
            output = val;
            break;
          }
          case "--top-model":
            topModel = getVal();
            break;
          case "--cheap-model":
            cheapModel = getVal();
            break;
          case "--local-model":
            localModel = getVal();
            break;
          case "--concurrency": {
            const val = getVal();
            const num = Number(val);
            if (!val || !Number.isInteger(num) || num <= 0) {
              ctx.stderr.write("Error: --concurrency must be a positive integer\n");
              return 2;
            }
            concurrency = num;
            break;
          }
        }
      } else {
        if (!tasks) tasks = [];
        tasks.push(arg);
      }
      i++;
    }

    try {
      const config: BenchmarkRunConfig = {
        taskPaths: tasks,
        arms,
        repetitions,
        budgetCapUsd: maxBudget,
        topModel,
        cheapModel,
        localModel,
        concurrency,
        dryRun,
      };

      const report = await runBenchmarkSuite(config, ctx.cwd);
      const formatted = formatBenchmarkReport(report, format);

      if (dryRun) {
        ctx.stdout.write(
          `Planned benchmark dry-run matrix (${Object.keys(report.taskResults).length} tasks, ${repetitions} repetitions):\n`
        );
      }

      if (output) {
        const outPath = path.isAbsolute(output)
          ? output
          : path.resolve(ctx.cwd, output);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, formatted, "utf8");
      }

      ctx.stdout.write(formatted + "\n");
      return 0;
    } catch (err: any) {
      ctx.stderr.write(`Benchmark error: ${err.message}\n${err.stack ?? ""}\n`);
      return 1;
    }
  },
};

registry.register(benchCommand);
