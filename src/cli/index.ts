import type { Effort, Engine, PermissionMode, RunId, RunSummary, EngineEvent } from "../contracts/index.js";
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

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

export interface StreamResultEvent {
  type: "result";
  subtype: "success" | "error_failed" | "error_budget" | "error_needs_human";
  is_error: boolean;
  session_id: string;
  run_id: RunId;
  num_tasks: number;
  total_cost_usd: number;
  usage: { by_role: Record<string, number> };
  duration_ms: number;
}

export interface OutputFormatter {
  onEvent(event: EngineEvent): void;
  onSummary(summary: RunSummary, sessionId: string): void;
  onError(error: Error | string): void;
  flush(): Promise<void>;
}

const reg = await import(`./registry.js`);
const out = await import(`./output.js`);
const disp = await import(`./dispatcher.js`);

const runMod = await import(`./commands/run.js`);
const planMod = await import(`./commands/plan.js`);
const resumeMod = await import(`./commands/resume.js`);
const statusMod = await import(`./commands/status.js`);
const tasksMod = await import(`./commands/tasks.js`);
const costMod = await import(`./commands/cost.js`);
const reportMod = await import(`./commands/report.js`);
const verifyMod = await import(`./commands/verify.js`);
const mergeMod = await import(`./commands/merge.js`);
const undoMod = await import(`./commands/undo.js`);
const discardMod = await import(`./commands/discard.js`);
const modelsMod = await import(`./commands/models.js`);
const agentsMod = await import(`./commands/agents.js`);
const backendsMod = await import(`./commands/backends.js`);
const sessionsMod = await import(`./commands/sessions.js`);
const configMod = await import(`./commands/config.js`);
const doctorMod = await import(`./commands/doctor.js`);
const initMod = await import(`./commands/init.js`);

export const registry = reg.registry;
export const CommandRegistry = reg.CommandRegistry;
export const dispatchCommand = reg.dispatchCommand;

export const createFormatter = out.createFormatter;

export const parseCliArgs = disp.parseCliArgs;
export const readStdinIfAvailable = disp.readStdinIfAvailable;
export const runCli = disp.runCli;

export const runCommand: CliCommand = runMod.runCommand;
export const planCommand: CliCommand = planMod.planCommand;
export const resumeCommand: CliCommand = resumeMod.resumeCommand;
export const statusCommand: CliCommand = statusMod.statusCommand;
export const tasksCommand: CliCommand = tasksMod.tasksCommand;
export const costCommand: CliCommand = costMod.costCommand;
export const reportCommand: CliCommand = reportMod.reportCommand;
export const verifyCommand: CliCommand = verifyMod.verifyCommand;
export const mergeCommand: CliCommand = mergeMod.mergeCommand;
export const undoCommand: CliCommand = undoMod.undoCommand;
export const discardCommand: CliCommand = discardMod.discardCommand;
export const modelsCommand: CliCommand = modelsMod.modelsCommand;
export const agentsCommand: CliCommand = agentsMod.agentsCommand;
export const backendsCommand: CliCommand = backendsMod.backendsCommand;
export const sessionsCommand: CliCommand = sessionsMod.sessionsCommand;
export const configCommand: CliCommand = configMod.configCommand;
export const doctorCommand: CliCommand = doctorMod.doctorCommand;
export const initCommand: CliCommand = initMod.initCommand;
