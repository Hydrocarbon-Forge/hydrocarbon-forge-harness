import { parseArgs } from "node:util";

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

const CLI_OPTIONS = {
  print: { type: "boolean", short: "p" },
  continue: { type: "boolean", short: "c" },
  "fork-session": { type: "boolean" },
  "no-governor": { type: "boolean" },
  worktree: { type: "boolean", short: "w" },
  sandbox: { type: "boolean" },
  "output-format": { type: "string" },
  model: { type: "string" },
  "worker-model": { type: "string" },
  effort: { type: "string" },
  "session-id": { type: "string" },
  resume: { type: "string" },
  mode: { type: "string" },
  "permission-mode": { type: "string" },
  settings: { type: "string" },
  "max-budget-usd": { type: "string" },
  timeout: { type: "string" },
  "allowed-tools": { type: "string", multiple: true },
  "disallowed-tools": { type: "string", multiple: true },
} as const;

export interface ParseCliArgsResult {
  commandName?: string;
  flags: ParsedCliFlags;
  positional: string[];
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
  if (parsedValues.print) flags.print = true;
  if (parsedValues.continue) flags.continue = true;
  if (parsedValues["fork-session"]) flags.forkSession = true;
  if (parsedValues["no-governor"]) flags.noGovernor = true;
  if (parsedValues.worktree) flags.worktree = true;
  if (parsedValues.sandbox) flags.sandbox = true;
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
  if (parsedValues.mode) flags.mode = parsedValues.mode as any;
  if (parsedValues["permission-mode"]) {
    flags.permissionMode = parsedValues["permission-mode"] as any;
  }
  if (parsedValues.settings) flags.settings = parsedValues.settings as string;
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
      commandName = first;
      positional = rawPositionals.slice(1);
    }
  } else if (flags.print) {
    commandName = "run";
  }

  return { commandName, flags, positional };
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
  out.write(`  -w, --worktree            Run in isolated worktree\n`);
  out.write(`  --sandbox                 Enable bubblewrap sandbox\n`);
}

export async function runCli(
  argv: string[],
  streams?: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
  },
): Promise<number> {
  const stdin = streams?.stdin ?? process.stdin;
  const stdout = streams?.stdout ?? (process.stdout as NodeJS.WriteStream);
  const stderr = streams?.stderr ?? (process.stderr as NodeJS.WriteStream);

  const { commandName, flags, positional } = parseCliArgs(argv);

  if (flags.continue && flags.resume) {
    stderr.write("Error: --continue and --resume are mutually exclusive\n");
    return 2;
  }

  if (!commandName && positional.length === 0 && !flags.print) {
    if (stdin.isTTY) {
      printHelp(stdout);
      return 0;
    }
    const stdinContent = await readStdinIfAvailable(stdin);
    if (!stdinContent) {
      stderr.write("Error: prompt required on command line or stdin\n");
      return 2;
    }
    positional.push(stdinContent);
  }

  const effectiveCommandName = commandName ?? (positional.length > 0 ? "run" : undefined);
  if (!effectiveCommandName) {
    stderr.write("Error: unknown command\n");
    return 2;
  }

  const cmd = registry.get(effectiveCommandName);
  if (!cmd) {
    stderr.write(`Error: unknown command '${effectiveCommandName}'\n`);
    return 2;
  }

  if (cmd.name === "run" || cmd.name === "plan") {
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
    }
  }

  const ctx: CommandContext = {
    cwd: process.cwd(),
    flags,
    rawArgs: positional,
    stdout,
    stderr,
  };

  return cmd.execute(ctx);
}
