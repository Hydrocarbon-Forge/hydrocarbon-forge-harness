import type { Effort, Engine, EnvReport, HarnessAdapter, PermissionMode } from "../../contracts/index.js";
import { createAdapters } from "../../backends/registry.js";
import { loadSettings } from "../../config/index.js";
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
    const settings = await loadSettings({
      projectDir: ctx.cwd,
      settingsFile: ctx.flags.settings,
    });
    const created = createAdapters(settings);
    const adapters: Array<{ name: string; adapter: HarnessAdapter }> = [
      { name: "claude", adapter: created.claude },
      { name: "opencode", adapter: created.opencode },
      { name: "agy", adapter: created.agy },
    ];

    const rows: Array<{
      name: string;
      pin: string;
      installed: string;
      status: string;
    }> = [];
    const capabilities: Record<string, string[]> = {};

    for (const { name, adapter } of adapters) {
      let report: EnvReport;
      try {
        report = await adapter.validateEnvironment();
      } catch (err: any) {
        report = { ok: false, pin_matches: false, problems: [err.message] };
      }

      rows.push({
        name,
        pin: adapter.capabilities.version_pin ?? "-",
        installed: report.version ?? "not installed",
        status: report.ok ? "OK" : report.pin_matches === false ? "Mismatch" : "Missing",
      });

      const caps = adapter.capabilities;
      const features: string[] = [];
      if (caps.effort) features.push("effort");
      if (caps.structured_output) features.push("structured_output");
      if (caps.budget_flag) features.push("budget_flag");
      if (caps.resume) features.push("resume");
      if (caps.sandbox_flag) features.push("sandbox");
      capabilities[name] = features;
    }

    if (ctx.flags.outputFormat === "json") {
      ctx.stdout.write(JSON.stringify({ backends: rows, capabilities }) + "\n");
      return 0;
    }

    ctx.stdout.write(`=== Backend Adapters ===\n\n`);
    ctx.stdout.write(`Backend\t\tPin\t\tInstalled\tStatus\n`);
    ctx.stdout.write(`----------------------------------------------------------------\n`);

    for (const row of rows) {
      ctx.stdout.write(`${row.name}\t\t${row.pin}\t\t${row.installed}\t${row.status}\n`);
    }

    ctx.stdout.write(`\n=== Capabilities ===\n`);
    for (const [name, features] of Object.entries(capabilities)) {
      ctx.stdout.write(`  ${name}: ${features.join(", ") || "none"}\n`);
    }

    return 0;
  },
};

registry.register(backendsCommand);
