/* intra-tui */ import type { SlashCommandDef, SlashCommandRegistry } from "./types.js";

function defaultHandler(cmd: string) {
  return (args: string) => ({ type: "DISPATCH_SLASH" as const, command: cmd, args });
}

export const CANONICAL_COMMANDS: readonly SlashCommandDef[] = [
  // core
  {
    name: "/help",
    description: "Displays interactive command catalogue and operational help.",
    argumentHint: "[command]",
    aliases: ["?", "/?"],
    category: "core",
    handler: defaultHandler("help"),
  },
  {
    name: "/doctor",
    description: "Verifies local sandbox environment, tool paths, and backend health.",
    category: "core",
    handler: defaultHandler("doctor"),
  },
  {
    name: "/init",
    description: "Initializes .substrate/ configuration and project scaffolding.",
    category: "core",
    handler: defaultHandler("init"),
  },
  {
    name: "/clear",
    description: "Clears terminal screen buffer and prompt history.",
    aliases: ["cls", "/cls"],
    category: "core",
    handler: () => ({ type: "PROMPT_CLEAR" as const }),
  },
  {
    name: "/exit",
    description: "Gracefully terminates interactive TUI session with clean cleanup.",
    aliases: ["quit", "/quit", "q", "/q"],
    category: "core",
    handler: () => ({ type: "EXIT" as const, code: 0 }),
  },

  // config
  {
    name: "/mode",
    description: "Views or switches active run gate permission mode.",
    argumentHint: "[permission_mode]",
    category: "config",
    handler: defaultHandler("mode"),
  },
  {
    name: "/models",
    description: "Lists configured model routing rules and active models per role.",
    argumentHint: "[role]",
    category: "config",
    handler: defaultHandler("models"),
  },
  {
    name: "/agents",
    description: "Lists active worker profiles and configured agent definitions.",
    category: "config",
    handler: defaultHandler("agents"),
  },
  {
    name: "/permissions",
    description: "Inspects tool permission rules, soft-denials, and gate approvals.",
    category: "config",
    handler: defaultHandler("permissions"),
  },
  {
    name: "/config",
    description: "Inspects or edits Substrate configuration keys and overrides.",
    argumentHint: "[key] [val]",
    category: "config",
    handler: defaultHandler("config"),
  },
  {
    name: "/hooks",
    description: "Lists registered lifecycle hooks and gate policies.",
    category: "config",
    handler: defaultHandler("hooks"),
  },

  // control
  {
    name: "/plan",
    description: "Triggers planning phase to generate structured run manifest.",
    argumentHint: "[prompt]",
    category: "control",
    handler: defaultHandler("plan"),
  },
  {
    name: "/run",
    description: "Initiates execution of current plan or resumes specified run.",
    argumentHint: "[run_id]",
    category: "control",
    handler: defaultHandler("run"),
  },
  {
    name: "/resume",
    description: "Reopens an existing run or session by identifier.",
    argumentHint: "<id>",
    aliases: ["continue", "/continue"],
    category: "control",
    handler: defaultHandler("resume"),
  },
  {
    name: "/undo",
    description: "Rolls back last integrated task git commit and reverts state.",
    category: "control",
    handler: defaultHandler("undo"),
  },

  // state
  {
    name: "/status",
    description: "Displays current run lifecycle state, active task, and engine health.",
    category: "state",
    handler: defaultHandler("status"),
  },
  {
    name: "/tasks",
    description: "Displays interactive task board across task state lifecycles.",
    category: "state",
    handler: () => ({ type: "TOGGLE_TASK_BOARD" as const }),
  },
  {
    name: "/cost",
    description: "Shows cumulative session and run cost breakdown against budget caps.",
    category: "state",
    handler: defaultHandler("cost"),
  },
  {
    name: "/sessions",
    description: "Lists recent sessions and launches interactive session picker.",
    category: "state",
    handler: defaultHandler("sessions"),
  },
];

function normalizeKey(key: string): string {
  const trimmed = key.trim().toLowerCase();
  if (trimmed === "?" || trimmed === "/?") {
    return "?";
  }
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

class SlashCommandRegistryImpl implements SlashCommandRegistry {
  private readonly commandMap = new Map<string, SlashCommandDef>();
  private readonly canonicalKeys = new Set<string>();

  constructor() {
    for (const cmd of CANONICAL_COMMANDS) {
      this.registerCanonical(cmd);
    }
  }

  private registerCanonical(def: SlashCommandDef): void {
    const norm = normalizeKey(def.name);
    this.commandMap.set(norm, def);
    this.canonicalKeys.add(norm);

    if (def.aliases) {
      for (const alias of def.aliases) {
        const normAlias = normalizeKey(alias);
        this.commandMap.set(normAlias, def);
        this.canonicalKeys.add(normAlias);
      }
    }
  }

  register(def: SlashCommandDef): void {
    const norm = normalizeKey(def.name);
    if (this.canonicalKeys.has(norm)) {
      return;
    }
    this.commandMap.set(norm, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        const normAlias = normalizeKey(alias);
        if (!this.canonicalKeys.has(normAlias)) {
          this.commandMap.set(normAlias, def);
        }
      }
    }
  }

  get(nameOrAlias: string): SlashCommandDef | undefined {
    return this.commandMap.get(normalizeKey(nameOrAlias));
  }

  list(): SlashCommandDef[] {
    const seen = new Set<SlashCommandDef>();
    for (const def of this.commandMap.values()) {
      seen.add(def);
    }
    return Array.from(seen);
  }

  resolve(input: string): { def?: SlashCommandDef; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    let cmdToken: string;
    let args = "";

    if (trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        cmdToken = trimmed;
        args = "";
      } else {
        cmdToken = trimmed.slice(0, spaceIdx);
        args = trimmed.slice(spaceIdx + 1).trim();
      }
    } else if (trimmed.startsWith("?")) {
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        cmdToken = "?";
        args = "";
      } else {
        cmdToken = "?";
        args = trimmed.slice(spaceIdx + 1).trim();
      }
    } else {
      return null;
    }

    const def = this.get(cmdToken);
    return { def, args };
  }
}

export function createSlashCommandRegistry(): SlashCommandRegistry {
  return new SlashCommandRegistryImpl();
}
