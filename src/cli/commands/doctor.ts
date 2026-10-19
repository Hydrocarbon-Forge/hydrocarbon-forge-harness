import { execFileSync } from "node:child_process";

import type { Effort, Engine, EnvReport, PermissionMode, Settings } from "../../contracts/index.js";
import { DEFAULT_SETTINGS, loadSettings } from "../../config/index.js";
import { createAdapters } from "../../backends/registry.js";
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

const PROVIDERS = ["claude", "opencode", "agy"] as const;

// One doctor check. `fix` is present for WARN and FAIL and prints on its own line.
interface DoctorCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  fix?: string;
}

// The R1.8 JSON shape (node, git, bubblewrap, adapters) kept exactly; the checks
// are added as their own list alongside it.
interface DoctorJson {
  node: { version: string; ok: boolean };
  git: { version: string; ok: boolean };
  bubblewrap: { version: string; ok: boolean };
  adapters: Record<string, string>;
  checks: DoctorCheck[];
}

function gitAtLeast(version: string, major: number, minor: number): boolean {
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const foundMajor = parseInt(match[1], 10);
  const foundMinor = parseInt(match[2], 10);
  return foundMajor > major || (foundMajor === major && foundMinor >= minor);
}

// Providers a run depends on: those named by a profile or by defaults.
function providersInUse(settings: Settings): string[] {
  const names = new Set<string>();
  for (const provider of Object.keys(settings.profiles ?? {})) {
    names.add(provider);
  }
  if (settings.defaults?.planner_provider) {
    names.add(settings.defaults.planner_provider);
  }
  if (settings.defaults?.worker_provider) {
    names.add(settings.defaults.worker_provider);
  }
  return [...names];
}

export const doctorCommand: CliCommand = {
  name: "doctor",
  description: "Diagnose system environment, runtime dependencies, and backend readiness",
  async execute(ctx: CommandContext): Promise<number> {
    // Settings give the pins and the profiles, so they are read first and reported
    // in the position the check order gives them.
    let settings: Settings;
    let settingsError: string | null = null;
    try {
      settings = await loadSettings({
        projectDir: ctx.cwd,
        settingsFile: ctx.flags.settings,
      });
    } catch (err) {
      settings = DEFAULT_SETTINGS;
      settingsError = (err as Error).message;
    }

    // 1. Node >= 22.
    const nodeVer = process.versions.node;
    const nodeOk = parseInt(nodeVer.split(".")[0], 10) >= 22;
    const nodeCheck: DoctorCheck = {
      name: "node",
      status: nodeOk ? "PASS" : "FAIL",
      detail: `Node.js ${nodeVer} (requires >= 22)`,
      fix: nodeOk ? undefined : "install Node.js 22 or newer",
    };

    // 2. git >= 2.30.
    let gitRaw = "not found";
    let gitOk = false;
    try {
      gitRaw = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
      gitOk = gitAtLeast(gitRaw, 2, 30);
    } catch {
      gitOk = false;
    }
    const gitCheck: DoctorCheck = {
      name: "git",
      status: gitOk ? "PASS" : "FAIL",
      detail: `${gitRaw} (requires >= 2.30)`,
      fix: gitOk ? undefined : "install git 2.30 or newer",
    };

    // 3. Each adapter's validateEnvironment(), including pin_matches.
    const adapters = createAdapters(settings);
    const inUse = providersInUse(settings);
    const adapterVersions: Record<string, string> = {};
    const adapterChecks: DoctorCheck[] = [];
    const reports: Record<string, EnvReport> = {};
    for (const provider of PROVIDERS) {
      const adapter = adapters[provider];
      const report = await adapter.validateEnvironment();
      reports[provider] = report;
      const pin = settings.backends[provider]?.version_pin ?? adapter.capabilities.version_pin;
      const usedByRun = inUse.includes(provider);
      adapterVersions[provider] = report.version ?? "not found";

      if (report.ok && report.pin_matches) {
        adapterChecks.push({
          name: provider,
          status: "PASS",
          detail: report.version ?? "installed",
        });
        continue;
      }

      if (!report.ok) {
        adapterChecks.push({
          name: provider,
          status: usedByRun ? "FAIL" : "WARN",
          detail: report.problems.length > 0 ? report.problems.join("; ") : "not installed",
          fix: usedByRun
            ? `install the ${provider} CLI harness, or remove profiles.${provider} and the defaults entry that names it`
            : `install the ${provider} CLI harness, or drop it from profiles and defaults`,
        });
        continue;
      }

      const found = report.version ?? "unknown";
      adapterChecks.push({
        name: provider,
        status: "FAIL",
        detail: `${found} differs from pinned ${pin}`,
        fix: `install ${provider} ${pin} (the pinned version), or set backends.${provider}.version_pin to ${found}`,
      });
    }

    // 4. loadSettings() succeeds.
    const settingsCheck: DoctorCheck =
      settingsError === null
        ? { name: "settings", status: "PASS", detail: "settings loaded" }
        : {
            name: "settings",
            status: "FAIL",
            detail: settingsError,
            fix: "fix settings.json",
          };

    // 5. Every profile model appears in that provider's listModels() answer.
    const profiles = settings.profiles ?? {};
    const profileChecks: DoctorCheck[] = [];
    const profileNames = Object.keys(profiles).sort();
    if (profileNames.length === 0) {
      profileChecks.push({
        name: "profiles",
        status: "PASS",
        detail: "no profiles configured",
      });
    } else {
      for (const provider of profileNames) {
        const adapter = adapters[provider as keyof typeof adapters];
        if (adapter === undefined) {
          profileChecks.push({
            name: `profiles.${provider}`,
            status: settingsError === null ? "WARN" : "FAIL",
            detail: `${provider} is not a provider doctor can query`,
            fix: "use claude, opencode or agy as the profile key",
          });
          continue;
        }

        if (reports[provider] === undefined || !reports[provider].ok) {
          profileChecks.push({
            name: `profiles.${provider}`,
            status: "WARN",
            detail: `${provider} is not installed, so its models cannot be listed`,
            fix: `install the ${provider} CLI harness, or remove profiles.${provider}`,
          });
          continue;
        }

        let ids: string[] = [];
        if (adapter.listModels) {
          try {
            ids = (await adapter.listModels()).map((model) => model.id);
          } catch (err) {
            profileChecks.push({
              name: `profiles.${provider}`,
              status: "WARN",
              detail: (err as Error).message,
              fix: `check that the ${provider} CLI can list models`,
            });
            continue;
          }
        }

        const profile = profiles[provider];
        const slots = ["plan", "work", "fast"] as const;
        const missing: string[] = [];
        const listed: string[] = [];
        for (const slot of slots) {
          const value = profile[slot];
          if (!value) {
            continue;
          }
          if (ids.includes(value.model)) {
            listed.push(`${slot}=${value.model}`);
          } else {
            missing.push(`${slot}=${value.model}`);
          }
        }

        if (missing.length > 0) {
          profileChecks.push({
            name: `profiles.${provider}`,
            status: "WARN",
            detail: `${missing.join(", ")} not listed by ${provider}`,
            fix: `choose a model ${provider} lists: ${ids.join(", ")}`,
          });
        } else {
          profileChecks.push({
            name: `profiles.${provider}`,
            status: "PASS",
            detail: listed.join(" "),
          });
        }
      }
    }

    // 6. bwrap, WARN only because the sandbox is off by default.
    let bwrapVer = "not found";
    let bwrapOk = false;
    try {
      bwrapVer = execFileSync("bwrap", ["--version"], { encoding: "utf8" }).trim();
      bwrapOk = true;
    } catch {
      bwrapOk = false;
    }
    const bwrapCheck: DoctorCheck = {
      name: "bwrap",
      status: bwrapOk ? "PASS" : "WARN",
      detail: bwrapOk ? bwrapVer : "not found",
      fix: bwrapOk ? undefined : "install bubblewrap (the sandbox is off by default)",
    };

    const checks: DoctorCheck[] = [
      nodeCheck,
      gitCheck,
      ...adapterChecks,
      settingsCheck,
      ...profileChecks,
      bwrapCheck,
    ];

    if (ctx.flags.outputFormat === "json") {
      const results: DoctorJson = {
        node: { version: nodeVer, ok: nodeOk },
        git: { version: gitRaw, ok: gitOk },
        bubblewrap: { version: bwrapVer, ok: bwrapOk },
        adapters: adapterVersions,
        checks,
      };
      ctx.stdout.write(`${JSON.stringify(results)}\n`);
    } else {
      ctx.stdout.write("=== Substrate System Diagnostics ===\n\n");
      for (const check of checks) {
        ctx.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
        if (check.fix) {
          ctx.stdout.write(`  fix: ${check.fix}\n`);
        }
      }
    }

    const hasFail = checks.some((check) => check.status === "FAIL");
    return hasFail ? 1 : 0;
  },
};

registry.register(doctorCommand);
