import fs from "node:fs";
import path from "node:path";

import { Effort } from "../../contracts/index.js";
import type { Engine, PermissionMode, Settings } from "../../contracts/index.js";
import { loadSettings } from "../../config/index.js";
import { createAdapters } from "../../backends/registry.js";
import type { SessionStore } from "../../store/sessions.js";
import { registerProject } from "../../store/projects.js";

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
  provider?: string;
  force?: boolean;
  plan?: string;
  work?: string;
  fast?: string;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktree?: boolean;
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

// Behaviour 1: the runtime directories init creates. Behaviour 2 lists the
// subset written to .gitignore; archive/ stays committable.
const RUNTIME_DIRS = ["runs", "worktrees", "state", "sessions", "ledger", "archive"];
const GITIGNORE_LINES = [
  "runs/",
  "worktrees/",
  "state/",
  "sessions/",
  "ledger/",
  "settings.local.json",
];

const CHARTER_STUB =
  "# Charter\n\nThe charter is sent to the planner as project instructions, capped at 4 KB.\n";

// One slot flag value: "model" or "model:effort".
interface SlotValue {
  flag: string;
  model: string;
  effort?: Effort;
  rawEffort?: string;
}

function parseSlot(flag: string, raw: string): SlotValue {
  const separator = raw.indexOf(":");
  if (separator === -1) {
    return { flag, model: raw };
  }
  const rawEffort = raw.slice(separator + 1);
  const parsed = Effort.safeParse(rawEffort);
  return {
    flag,
    model: raw.slice(0, separator),
    effort: parsed.success ? parsed.data : undefined,
    rawEffort: parsed.success ? undefined : rawEffort,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Behaviour 6: an existing file is kept unless --force is given, and a kept file
// prints `kept <path>`. A file with nothing to write prints `kept <path>` too,
// since there is no content to overwrite.
function writeEntry(
  ctx: CommandContext,
  substrateDir: string,
  relPath: string,
  content: string | null
): void {
  const display = path.posix.join(".substrate", relPath);
  const fullPath = path.join(substrateDir, relPath);
  if (content === null || (fs.existsSync(fullPath) && !ctx.flags.force)) {
    if (fs.existsSync(fullPath)) {
      ctx.stdout.write(`kept ${display}\n`);
    }
    return;
  }
  fs.writeFileSync(fullPath, content, "utf8");
  ctx.stdout.write(`wrote ${display}\n`);
}

export const initCommand: CliCommand = {
  name: "init",
  description:
    "Initialize the Substrate workspace: directories, .gitignore, charter, and the settings that differ from defaults",
  async execute(ctx: CommandContext): Promise<number> {
    registerProject(ctx.cwd);
    const flags = ctx.flags;

    const slots: SlotValue[] = [];
    if (flags.plan !== undefined) slots.push(parseSlot("plan", flags.plan));
    if (flags.work !== undefined) slots.push(parseSlot("work", flags.work));
    if (flags.fast !== undefined) slots.push(parseSlot("fast", flags.fast));

    const hasSlots = slots.length > 0;

    // Behaviour 8: flag validation runs before anything is written.
    if (hasSlots) {
      if (flags.provider === undefined) {
        ctx.stderr.write("Error: --provider is required with slot flags\n");
        return 2;
      }
      if (flags.plan === undefined || flags.work === undefined) {
        ctx.stderr.write("Error: --plan and --work are required together\n");
        return 2;
      }
    }

    for (const slot of slots) {
      if (slot.rawEffort !== undefined) {
        ctx.stderr.write(
          `Error: effort "${slot.rawEffort}" is not valid; valid efforts: ${Effort.options.join(", ")}\n`
        );
        return 2;
      }
    }

    const provider = flags.provider;
    if (provider !== undefined && !(PROVIDERS as readonly string[]).includes(provider)) {
      ctx.stderr.write(`Error: unknown provider ${provider}\n`);
      return 2;
    }

    let settings: Settings;
    try {
      settings = await loadSettings({
        projectDir: ctx.cwd,
        settingsFile: flags.settings,
      });
    } catch (err) {
      ctx.stderr.write(`Error: ${(err as Error).message}\n`);
      return 2;
    }

    const adapters = createAdapters(settings);

    // Behaviour 8: an installed provider and a model it lists.
    if (hasSlots && provider !== undefined) {
      const adapter = adapters[provider as keyof typeof adapters];
      const report = await adapter.validateEnvironment();
      if (!report.ok) {
        ctx.stderr.write(`Error: provider ${provider} is not installed\n`);
        return 2;
      }
      const models = adapter.listModels ? await adapter.listModels() : [];
      const ids = models.map((model) => model.id);
      for (const slot of slots) {
        if (!ids.includes(slot.model)) {
          ctx.stderr.write(
            `Error: model '${slot.model}' is not listed by ${provider}; valid ids: ${ids.join(", ")}\n`
          );
          return 2;
        }
      }
    }

    const substrateDir = path.join(ctx.cwd, ".substrate");
    for (const dir of RUNTIME_DIRS) {
      fs.mkdirSync(path.join(substrateDir, dir), { recursive: true });
    }

    // Behaviour 4: only the keys that differ from the built-in defaults, so a
    // run with no slot flags has nothing to write and writes no profile.
    let settingsContent: string | null = null;
    if (hasSlots && provider !== undefined) {
      const profile: Record<string, Record<string, string>> = {};
      for (const slot of slots) {
        const entry: Record<string, string> = { model: slot.model };
        if (slot.effort !== undefined) {
          entry.effort = slot.effort;
        }
        profile[slot.flag] = entry;
      }

      const diff: Record<string, unknown> = {
        profiles: { [provider]: profile },
        defaults: { planner_provider: provider, worker_provider: provider },
      };

      settingsContent = `${JSON.stringify(diff, null, 2)}\n`;
    }

    writeEntry(ctx, substrateDir, "settings.json", settingsContent);

    writeEntry(ctx, substrateDir, ".gitignore", `${GITIGNORE_LINES.join("\n")}\n`);

    // Behaviour 5: the charter stub is written only when absent.
    const charterPath = path.join(substrateDir, "charter.md");
    if (fs.existsSync(charterPath)) {
      ctx.stdout.write("kept .substrate/charter.md\n");
    } else {
      fs.writeFileSync(charterPath, CHARTER_STUB, "utf8");
      ctx.stdout.write("wrote .substrate/charter.md\n");
    }

    if (!hasSlots) {
      // Behaviour 7: list what substrate models finds and let the caller choose.
      for (const name of PROVIDERS) {
        const adapter = adapters[name];
        const report = await adapter.validateEnvironment();
        if (!report.ok) {
          continue;
        }
        const models = adapter.listModels ? await adapter.listModels() : [];
        const ids = models.map((model) => model.id);
        ctx.stdout.write(`${name}: installed (${report.version ?? "version unknown"})\n`);
        ctx.stdout.write(`  models: ${ids.join(", ")}\n`);
        ctx.stdout.write(
          `  set profiles: substrate init --provider ${name} --plan <id> --work <id> --fast <id>\n`
        );
      }
    }

    return 0;
  },
};

registry.register(initCommand);
