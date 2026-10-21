import { parseArgs } from "node:util";

import type { Effort, Engine, PermissionMode } from "../contracts/index.js";
import type { SessionStore } from "../store/sessions.js";
import { readEnvLayer } from "../config/index.js";

export interface CliGlobalFlags {
  help?: boolean;
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  from?: string;
  run?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  local?: boolean;
  provider?: string;
  refresh?: boolean;
  stats?: boolean;
  by?: string;
  since?: string;
  allProjects?: boolean;
  cache?: boolean;
  rebuild?: boolean;
  force?: boolean;
  plan?: string;
  work?: string;
  fast?: string;
  dryRun?: boolean;
  abortOnConflict?: boolean;
  /** merge: land the passed tasks of a failed run after integration verify passes on the run branch (R8.2). */
  partial?: boolean;
  merge?: boolean;
  /** Do not merge a finished run into the checked-out branch, for this run only (R10.1). */
  noMerge?: boolean;
  /** watch: print the run's history and exit, without following it (R10.2). */
  noFollow?: boolean;
  hard?: boolean;
  verify?: string[];
  request?: string;
  answers?: string;
  allVersions?: boolean;
  olderThan?: string;
  historyAll?: boolean;
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
  signal?: AbortSignal;
}

const { registry } = await import(`./registry.js`);

// Load all command modules
await import(`./commands/run.js`);
await import(`./commands/plan.js`);
await import(`./commands/resume.js`);
await import(`./commands/status.js`);
await import(`./commands/tasks.js`);
await import(`./commands/cost.js`);
await import(`./commands/report.js`);
await import(`./commands/verify.js`);
await import(`./commands/merge.js`);
await import(`./commands/undo.js`);
await import(`./commands/discard.js`);
await import(`./commands/models.js`);
await import(`./commands/agents.js`);
await import(`./commands/backends.js`);
await import(`./commands/sessions.js`);
await import(`./commands/config.js`);
await import(`./commands/doctor.js`);
await import(`./commands/init.js`);
await import(`./commands/history.js`);
await import(`./commands/archive.js`);
await import(`./commands/charter.js`);
await import(`./commands/gc.js`);
await import(`./commands/watch.js`);
await import(`./commands/runs.js`);
await import(`./commands/stop.js`);
await import(`./bench.js`);

const CLI_OPTIONS = {
  help: { type: "boolean", short: "h" },
  print: { type: "boolean", short: "p" },
  continue: { type: "boolean", short: "c" },
  "fork-session": { type: "boolean" },
  // Deprecated no-op: the governor is deleted. Still accepted so existing callers do not break.
  "no-governor": { type: "boolean" },
  sandbox: { type: "boolean" },
  local: { type: "boolean" },
  "output-format": { type: "string" },
  model: { type: "string" },
  "worker-model": { type: "string" },
  effort: { type: "string" },
  "session-id": { type: "string" },
  resume: { type: "string" },
  from: { type: "string" },
  run: { type: "string" },
  mode: { type: "string" },
  "permission-mode": { type: "string" },
  settings: { type: "string" },
  "max-budget-usd": { type: "string" },
  timeout: { type: "string" },
  "allowed-tools": { type: "string", multiple: true },
  "disallowed-tools": { type: "string", multiple: true },
  verify: { type: "string", multiple: true },
  provider: { type: "string" },
  refresh: { type: "boolean" },
  stats: { type: "boolean" },
  by: { type: "string" },
  since: { type: "string" },
  "all-projects": { type: "boolean" },
  cache: { type: "boolean" },
  rebuild: { type: "boolean" },
  force: { type: "boolean" },
  plan: { type: "string" },
  work: { type: "string" },
  fast: { type: "string" },
  "dry-run": { type: "boolean" },
  "abort-on-conflict": { type: "boolean" },
  partial: { type: "boolean" },
  merge: { type: "boolean" },
  "no-merge": { type: "boolean" },
  "no-follow": { type: "boolean" },
  hard: { type: "boolean" },
  request: { type: "string" },
  answers: { type: "string" },
  "all-versions": { type: "boolean" },
  "older-than": { type: "string" },
  "history-all": { type: "boolean" },
} as const;

export interface ParseCliArgsResult {
  commandName?: string;
  flags: ParsedCliFlags;
  positional: string[];
  unknownOptions: string[];
}

export function parseCliArgs(argv: string[]): ParseCliArgsResult {
  let parsedValues: Record<string, any> = {};
  let rawPositionals: string[] = [];

  try {
    const res = parseArgs({
      args: argv,
      options: CLI_OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    parsedValues = res.values;
    rawPositionals = res.positionals;
  } catch {
    rawPositionals = argv.filter((a) => !a.startsWith("-"));
  }

  const flags: ParsedCliFlags = {};
  if (parsedValues.help) flags.help = true;
  if (parsedValues.print) flags.print = true;
  if (parsedValues.continue) flags.continue = true;
  if (parsedValues["fork-session"]) flags.forkSession = true;
  if (parsedValues.sandbox) flags.sandbox = true;
  if (parsedValues.local) flags.local = true;
  if (parsedValues["output-format"]) {
    flags.outputFormat = parsedValues["output-format"] as any;
  }
  if (parsedValues.model) flags.model = parsedValues.model as string;
  if (parsedValues["worker-model"]) {
    flags.workerModel = parsedValues["worker-model"] as string;
  }
  if (parsedValues.effort) flags.effort = parsedValues.effort as any;
  if (parsedValues["session-id"]) {
    flags.sessionId = parsedValues["session-id"] as string;
  }
  if (parsedValues.resume) flags.resume = parsedValues.resume as string;
  if (parsedValues.from !== undefined) flags.from = parsedValues.from as string;
  if (parsedValues.run !== undefined) flags.run = parsedValues.run as string;
  if (parsedValues.mode) flags.mode = parsedValues.mode as any;
  if (parsedValues["permission-mode"]) {
    flags.permissionMode = parsedValues["permission-mode"] as any;
  }
  if (parsedValues.settings) flags.settings = parsedValues.settings as string;
  if (parsedValues.provider !== undefined) {
    flags.provider = parsedValues.provider as string;
  }
  if (parsedValues.refresh) flags.refresh = true;
  if (parsedValues.stats) flags.stats = true;
  if (parsedValues.by !== undefined) flags.by = parsedValues.by as string;
  if (parsedValues.since !== undefined) flags.since = parsedValues.since as string;
  if (parsedValues["all-projects"]) flags.allProjects = true;
  if (parsedValues.cache) flags.cache = true;
  if (parsedValues.rebuild) flags.rebuild = true;
  if (parsedValues.force) flags.force = true;
  if (parsedValues.plan !== undefined) flags.plan = parsedValues.plan as string;
  if (parsedValues.work !== undefined) flags.work = parsedValues.work as string;
  if (parsedValues.fast !== undefined) flags.fast = parsedValues.fast as string;
  if (parsedValues["dry-run"]) flags.dryRun = true;
  if (parsedValues["abort-on-conflict"]) flags.abortOnConflict = true;
  if (parsedValues.partial) flags.partial = true;
  if (parsedValues.merge) flags.merge = true;
  if (parsedValues["no-merge"]) flags.noMerge = true;
  if (parsedValues["no-follow"]) flags.noFollow = true;
  if (parsedValues.hard) flags.hard = true;
  if (parsedValues["max-budget-usd"] !== undefined) {
    flags.maxBudgetUsd = Number(parsedValues["max-budget-usd"]);
  }
  if (parsedValues.timeout !== undefined) {
    flags.timeout = Number(parsedValues.timeout);
  }
  if (parsedValues["allowed-tools"]) {
    flags.allowedTools = parsedValues["allowed-tools"] as string[];
  }
  if (parsedValues["disallowed-tools"]) {
    flags.disallowedTools = parsedValues["disallowed-tools"] as string[];
  }
  if (parsedValues.verify) {
    flags.verify = parsedValues.verify as string[];
  }
  if (parsedValues.request !== undefined) {
    flags.request = parsedValues.request as string;
  }
  if (parsedValues.answers !== undefined) {
    flags.answers = parsedValues.answers as string;
  }
  if (parsedValues["all-versions"]) {
    flags.allVersions = true;
  }
  if (parsedValues["older-than"] !== undefined) {
    flags.olderThan = parsedValues["older-than"] as string;
  }
  if (parsedValues["history-all"]) {
    flags.historyAll = true;
  }

  let commandName: string | undefined;
  let positional: string[] = [...rawPositionals];

  if (rawPositionals.length > 0) {
    const first = rawPositionals[0];
    const registered = registry.get(first);
    if (registered) {
      commandName = registered.name;
      positional = rawPositionals.slice(1);
    } else if (flags.print) {
      commandName = "run";
      positional = rawPositionals;
    } else if (first.includes(" ") || rawPositionals.length > 1) {
      commandName = "run";
      positional = rawPositionals;
    } else {
      // An unregistered first word is a run prompt, never an error (R1.6).
      commandName = "run";
      positional = rawPositionals;
    }
  } else if (flags.print) {
    commandName = "run";
  }

  const known = new Set(Object.keys(CLI_OPTIONS));
  const unknownOptions: string[] = [];
  for (const key of Object.keys(parsedValues)) {
    if (!known.has(key)) {
      unknownOptions.push(key.length === 1 ? `-${key}` : `--${key}`);
    }
  }

  return { commandName, flags, positional, unknownOptions };
}

export async function readStdinIfAvailable(
  stdinStream?: NodeJS.ReadStream,
): Promise<string | undefined> {
  const stream = stdinStream ?? process.stdin;
  if (stream.isTTY) {
    return undefined;
  }

  return new Promise((resolve) => {
    let data = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      data += chunk.toString();
    });
    stream.on("end", () => {
      const trimmed = data.trim();
      resolve(trimmed.length > 0 ? trimmed : undefined);
    });
    stream.on("error", () => {
      resolve(undefined);
    });
    if ((stream as any).readableEnded) {
      const trimmed = data.trim();
      resolve(trimmed.length > 0 ? trimmed : undefined);
    }
  });
}

function printHelp(out: NodeJS.WriteStream): void {
  out.write(`Substrate - Autonomous Execution Engine\n\n`);
  out.write(`Usage: substrate [command] [options] [prompt]\n\n`);
  out.write(`Available Commands:\n`);
  const cmds = registry.list();
  for (const cmd of cmds) {
    out.write(`  ${cmd.name.padEnd(14)} ${cmd.description}\n`);
  }
  out.write(`\nGlobal Options:\n`);
  out.write(`  -p, --print               Run headless and print output\n`);
  out.write(`  -c, --continue            Continue latest session\n`);
  out.write(`  --resume <target>         Resume prior session or run\n`);
  out.write(`  --fork-session            Branch existing session\n`);
  out.write(`  --output-format <fmt>     Output format: text | json | stream-json\n`);
  out.write(`  --from <value>          Source for agents import (claude or opencode)\n`);
  out.write(`  --run <value>           Run id for verify\n`);
  out.write(`  --sandbox                 Enable bubblewrap sandbox\n`);
  out.write(`  --no-follow               watch: print the run's history and exit\n`);
}

export async function runCli(
  argv: string[],
  streams?: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
    signal?: AbortSignal;
  },
): Promise<number> {
  const stdin = streams?.stdin ?? process.stdin;
  const stdout = streams?.stdout ?? (process.stdout as NodeJS.WriteStream);
  const stderr = streams?.stderr ?? (process.stderr as NodeJS.WriteStream);

  const { commandName, flags, positional, unknownOptions } = parseCliArgs(argv);

  // bench validates its own command-local flags; everything else is strict.
  if (unknownOptions.length > 0 && commandName !== "bench") {
    stderr.write(`Error: Unknown option '${unknownOptions[0]}'\n`);
    return 2;
  }

  if (flags.help) {
    printHelp(stdout);
    return 0;
  }

  if (flags.continue && flags.resume) {
    stderr.write("Error: --continue and --resume are mutually exclusive\n");
    return 2;
  }

  // No arguments at all: always help, even when stdin is not a TTY (R1.6).
  if (!commandName) {
    printHelp(stdout);
    return 0;
  }

  const cmd = registry.get(commandName);
  if (!cmd) {
    stderr.write(`Error: unknown command '${commandName}'\n`);
    return 2;
  }

  if (cmd.name === "run" || cmd.name === "plan") {
    try {
      // SUBSTRATE_* run defaults apply only when the matching flag is not given.
      const envDefaults = readEnvLayer(process.env).runDefaults;
      if (flags.permissionMode === undefined) flags.permissionMode = envDefaults.permissionMode;
      if (flags.outputFormat === undefined) flags.outputFormat = envDefaults.outputFormat;
    } catch (err) {
      stderr.write(`Error: ${(err as Error).message}\n`);
      return 2;
    }
  }

  let stdinData: string | undefined;
  if (cmd.name === "run" || cmd.name === "plan") {
    if (flags.request === "-") {
      stdinData = await readStdinIfAvailable(stdin);
    } else if (flags.request === undefined) {
      if (positional.length === 0) {
        if (stdin.isTTY) {
          stderr.write("Error: prompt required\n");
          return 2;
        }
        const stdinContent = await readStdinIfAvailable(stdin);
        if (!stdinContent || !stdinContent.trim()) {
          stderr.write("Error: prompt required on command line or stdin\n");
          return 2;
        }
        positional.push(stdinContent.trim());
        stdinData = stdinContent;
      }
    }
  } else if (cmd.name === "resume") {
    if (flags.answers === "-") {
      stdinData = await readStdinIfAvailable(stdin);
    }
  }

  if (flags.historyAll && (cmd.name === "run" || cmd.name === "plan")) {
    const origExecute = cmd.execute.bind(cmd);
    cmd.execute = async (commandCtx: CommandContext) => {
      let realEngine: any = commandCtx.engine;
      const interceptedEngine: any = {
        async run(opts: any) {
          opts.historyAll = true;
          if (!realEngine) {
            const { createEngine } = await import(`../engine/engine.js`);
            const { loadSettings, sandboxProblem } = await import(`../config/index.js`);
            const settings = await loadSettings({
              projectDir: commandCtx.cwd,
              settingsFile: commandCtx.flags.settings,
              flags: opts.overrides,
            });
            const problem = sandboxProblem(settings);
            if (problem) {
              commandCtx.stderr.write(`Error: ${problem}\n`);
              return { exit_code: 2 } as any;
            }
            (settings as any).historyAll = true;
            realEngine = createEngine({ settings });
          } else if (realEngine.options?.settings) {
            (realEngine.options.settings as any).historyAll = true;
          }
          return realEngine.run(opts);
        },
        async resume(runId: any, opts?: any) {
          const runOpts = opts ?? {};
          runOpts.historyAll = true;
          if (!realEngine) {
            const { createEngine } = await import(`../engine/engine.js`);
            const { loadSettings, sandboxProblem } = await import(`../config/index.js`);
            const settings = await loadSettings({
              projectDir: commandCtx.cwd,
              settingsFile: commandCtx.flags.settings,
              flags: runOpts.overrides,
            });
            const problem = sandboxProblem(settings);
            if (problem) {
              commandCtx.stderr.write(`Error: ${problem}\n`);
              return { exit_code: 2 } as any;
            }
            (settings as any).historyAll = true;
            realEngine = createEngine({ settings });
          } else if (realEngine.options?.settings) {
            (realEngine.options.settings as any).historyAll = true;
          }
          return realEngine.resume(runId, runOpts);
        },
      };
      return origExecute({ ...commandCtx, engine: interceptedEngine });
    };
  }

  const ctx: CommandContext = {
    cwd: process.cwd(),
    flags,
    rawArgs: positional,
    stdin: stdinData,
    stdout,
    stderr,
    signal: streams?.signal,
  };

  return cmd.execute(ctx);
}
