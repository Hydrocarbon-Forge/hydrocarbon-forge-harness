import type { Effort, Engine, EnvReport, HarnessAdapter, PermissionMode } from "../../contracts/index.js";
import { ClaudeAdapter } from "../../backends/adapters/claude.js";
import { OpenCodeAdapter } from "../../backends/adapters/opencode.js";
import { AgyAdapter } from "../../backends/adapters/agy.js";
import { FakeAdapter } from "../../../test/conformance/fake-adapter.js";
import { DEFAULT_SETTINGS } from "../../config/index.js";
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

export const backendsCommand: CliCommand = {
  name: "backends",
  description: "Display supported harness adapters, version pins, and environment status",
  async execute(ctx: CommandContext): Promise<number> {
    const adapters: Array<{ name: string; adapter: HarnessAdapter }> = [
      { name: "claude", adapter: new ClaudeAdapter() },
      { name: "opencode", adapter: new OpenCodeAdapter() },
      { name: "agy", adapter: new AgyAdapter({ pricing: DEFAULT_SETTINGS.pricing }) },
      { name: "fake", adapter: new FakeAdapter() },
    ];

    ctx.stdout.write(`=== Backend Adapters ===\n\n`);
    ctx.stdout.write(`Backend\t\tPin\t\tInstalled\tStatus\n`);
    ctx.stdout.write(`----------------------------------------------------------------\n`);

    for (const { name, adapter } of adapters) {
      let report: EnvReport;
      try {
        report = await adapter.validateEnvironment();
      } catch (err: any) {
        report = { ok: false, pin_matches: false, problems: [err.message] };
      }

      const pin = adapter.capabilities.version_pin ?? "-";
      const installed = report.version ?? "not installed";
      const status = report.ok ? "OK" : report.pin_matches === false ? "Mismatch" : "Missing";

      ctx.stdout.write(`${name}\t\t${pin}\t\t${installed}\t${status}\n`);
    }

    ctx.stdout.write(`\n=== Capabilities ===\n`);
    for (const { name, adapter } of adapters) {
      const caps = adapter.capabilities;
      const features: string[] = [];
      if (caps.effort) features.push("effort");
      if (caps.structured_output) features.push("structured_output");
      if (caps.budget_flag) features.push("budget_flag");
      if (caps.resume) features.push("resume");
      if (caps.sandbox_flag) features.push("sandbox");
      ctx.stdout.write(`  ${name}: ${features.join(", ") || "none"}\n`);
    }

    return 0;
  },
};

registry.register(backendsCommand);
