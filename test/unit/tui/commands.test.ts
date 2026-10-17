import { describe, expect, it } from "vitest";

import type * as Contracts from "../../../src/contracts/index.js";
import type { TuiAction, TuiState } from "./reducer.test.js";

export type CommandCategory = "core" | "state" | "config" | "control";

export interface SlashCommandDef {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  category: CommandCategory;
  handler: (args: string, state: TuiState) => TuiAction | void;
}

export interface SlashCommandRegistry {
  register(def: SlashCommandDef): void;
  get(nameOrAlias: string): SlashCommandDef | undefined;
  list(): SlashCommandDef[];
  resolve(input: string): { def?: SlashCommandDef; args: string } | null;
}

async function loadCommandsModule(): Promise<{
  CANONICAL_COMMANDS: readonly SlashCommandDef[];
  createSlashCommandRegistry: () => SlashCommandRegistry;
}> {
  return (await import("../../../src/tui/commands/registry.js" as any)) as any;
}

const EXPECTED_CANONICAL_COMMAND_NAMES = [
  "/help",
  "/mode",
  "/plan",
  "/run",
  "/status",
  "/tasks",
  "/cost",
  "/models",
  "/agents",
  "/permissions",
  "/config",
  "/resume",
  "/sessions",
  "/undo",
  "/doctor",
  "/init",
  "/clear",
  "/exit",
  "/hooks",
] as const;

describe("slash command registry (P5.3)", () => {
  describe("Canonical 19 command completeness and schemas", () => {
    it("contains exactly 19 canonical commands per §4.7 and S5 §5.1", async () => {
      const { CANONICAL_COMMANDS } = await loadCommandsModule();
      expect(CANONICAL_COMMANDS).toHaveLength(19);

      const registeredNames = CANONICAL_COMMANDS.map((c) =>
        c.name.startsWith("/") ? c.name : `/${c.name}`
      );

      for (const expected of EXPECTED_CANONICAL_COMMAND_NAMES) {
        expect(registeredNames).toContain(expected);
      }
    });

    it("verifies categories match the authoritative specification", async () => {
      const { CANONICAL_COMMANDS } = await loadCommandsModule();
      const byName = new Map<string, SlashCommandDef>();
      for (const c of CANONICAL_COMMANDS) {
        const norm = c.name.startsWith("/") ? c.name : `/${c.name}`;
        byName.set(norm, c);
      }

      // core
      expect(byName.get("/help")?.category).toBe("core");
      expect(byName.get("/doctor")?.category).toBe("core");
      expect(byName.get("/init")?.category).toBe("core");
      expect(byName.get("/clear")?.category).toBe("core");
      expect(byName.get("/exit")?.category).toBe("core");

      // config
      expect(byName.get("/mode")?.category).toBe("config");
      expect(byName.get("/models")?.category).toBe("config");
      expect(byName.get("/agents")?.category).toBe("config");
      expect(byName.get("/permissions")?.category).toBe("config");
      expect(byName.get("/config")?.category).toBe("config");
      expect(byName.get("/hooks")?.category).toBe("config");

      // control
      expect(byName.get("/plan")?.category).toBe("control");
      expect(byName.get("/run")?.category).toBe("control");
      expect(byName.get("/resume")?.category).toBe("control");
      expect(byName.get("/undo")?.category).toBe("control");

      // state
      expect(byName.get("/status")?.category).toBe("state");
      expect(byName.get("/tasks")?.category).toBe("state");
      expect(byName.get("/cost")?.category).toBe("state");
      expect(byName.get("/sessions")?.category).toBe("state");
    });

    it("verifies canonical aliases and argument hints", async () => {
      const { CANONICAL_COMMANDS } = await loadCommandsModule();
      const byName = new Map<string, SlashCommandDef>();
      for (const c of CANONICAL_COMMANDS) {
        const norm = c.name.startsWith("/") ? c.name : `/${c.name}`;
        byName.set(norm, c);
      }

      // /help aliases and hints
      const help = byName.get("/help");
      expect(help?.argumentHint).toBe("[command]");
      expect(help?.aliases?.some((a) => a === "?" || a === "/?")).toBe(true);

      // /mode hint
      const mode = byName.get("/mode");
      expect(mode?.argumentHint).toBe("[permission_mode]");

      // /resume alias
      const resume = byName.get("/resume");
      expect(resume?.argumentHint).toBe("<id>");
      expect(resume?.aliases?.some((a) => a === "/continue" || a === "continue")).toBe(true);

      // /clear alias
      const clear = byName.get("/clear");
      expect(clear?.aliases?.some((a) => a === "/cls" || a === "cls")).toBe(true);

      // /exit aliases
      const exit = byName.get("/exit");
      expect(exit?.aliases?.some((a) => a === "/quit" || a === "quit")).toBe(true);
      expect(exit?.aliases?.some((a) => a === "/q" || a === "q")).toBe(true);
    });
  });

  describe("SlashCommandRegistry lookup and resolution", () => {
    it("retrieves commands by primary name or canonical alias", async () => {
      const { createSlashCommandRegistry } = await loadCommandsModule();
      const registry = createSlashCommandRegistry();

      const exitDef = registry.get("exit");
      expect(exitDef).toBeDefined();
      expect(exitDef?.name).toMatch(/\/?exit/);

      const exitBySlash = registry.get("/exit");
      expect(exitBySlash).toBe(exitDef);

      const exitByAliasQ = registry.get("q");
      expect(exitByAliasQ).toBe(exitDef);

      const exitByAliasQuit = registry.get("/quit");
      expect(exitByAliasQuit).toBe(exitDef);

      const helpByQuestion = registry.get("?");
      expect(helpByQuestion).toBeDefined();
      expect(helpByQuestion?.name).toMatch(/\/?help/);
    });

    it("resolves command token and arguments string from input prompt", async () => {
      const { createSlashCommandRegistry } = await loadCommandsModule();
      const registry = createSlashCommandRegistry();

      // Simple command without args
      const res1 = registry.resolve("/status");
      expect(res1).not.toBeNull();
      expect(res1?.def?.name).toMatch(/\/?status/);
      expect(res1?.args).toBe("");

      // Command with single arg
      const res2 = registry.resolve("/mode dontAsk");
      expect(res2).not.toBeNull();
      expect(res2?.def?.name).toMatch(/\/?mode/);
      expect(res2?.args).toBe("dontAsk");

      // Command with multiple arguments
      const res3 = registry.resolve("/config budgets.run.max_usd 25.0");
      expect(res3).not.toBeNull();
      expect(res3?.def?.name).toMatch(/\/?config/);
      expect(res3?.args).toBe("budgets.run.max_usd 25.0");

      // Alias resolution with args
      const res4 = registry.resolve("? config");
      expect(res4).not.toBeNull();
      expect(res4?.def?.name).toMatch(/\/?help/);
      expect(res4?.args).toBe("config");

      // Leading/trailing whitespace resilience
      const res5 = registry.resolve("   /tasks   ");
      expect(res5).not.toBeNull();
      expect(res5?.def?.name).toMatch(/\/?tasks/);
      expect(res5?.args).toBe("");
    });

    it("returns null or def: undefined for non-command or empty inputs", async () => {
      const { createSlashCommandRegistry } = await loadCommandsModule();
      const registry = createSlashCommandRegistry();

      expect(registry.resolve("")).toBeNull();
      expect(registry.resolve("   ")).toBeNull();

      // Regular prompt not starting with slash or alias
      const textRes = registry.resolve("Please fix bug in engine");
      expect(textRes === null || textRes.def === undefined).toBe(true);

      // Shell passthrough prompt starting with !
      const shellRes = registry.resolve("!git status");
      expect(shellRes === null || shellRes.def === undefined).toBe(true);
    });

    it("handles unknown slash commands by returning undefined def with remainder args", async () => {
      const { createSlashCommandRegistry } = await loadCommandsModule();
      const registry = createSlashCommandRegistry();

      const res = registry.resolve("/nonexistent foo bar");
      expect(res).not.toBeNull();
      expect(res?.def).toBeUndefined();
      expect(res?.args).toBe("foo bar");
    });
  });

  describe("Precedence hierarchy: canonical built-ins over custom templates", () => {
    it("guarantees built-in commands take strict precedence over custom template registrations", async () => {
      const { createSlashCommandRegistry } = await loadCommandsModule();
      const registry = createSlashCommandRegistry();

      const customExitDef: SlashCommandDef = {
        name: "exit",
        description: "Custom exit override from .substrate/commands/exit.md",
        category: "control",
        handler: () => ({ type: "SET_BANNER", message: "Custom exit attempted" }),
      };

      // Attempting to register collision should not override built-in or registry prefers canonical
      registry.register(customExitDef);

      const resolved = registry.resolve("/exit");
      expect(resolved?.def).toBeDefined();
      expect(resolved?.def?.description).not.toContain("Custom exit override");
      expect(resolved?.def?.category).toBe("core");
    });
  });

  describe("Command handler execution", () => {
    it("/exit handler dispatches EXIT action with code 0", async () => {
      const { createSlashCommandRegistry } = await loadCommandsModule();
      const registry = createSlashCommandRegistry();

      const exitDef = registry.get("exit");
      expect(exitDef).toBeDefined();

      const dummyState = {} as TuiState;
      const action = exitDef?.handler("", dummyState);
      expect(action).toEqual({ type: "EXIT", code: 0 });
    });

    it("/clear handler dispatches PROMPT_CLEAR action or clear feed", async () => {
      const { createSlashCommandRegistry } = await loadCommandsModule();
      const registry = createSlashCommandRegistry();

      const clearDef = registry.get("clear");
      expect(clearDef).toBeDefined();

      const dummyState = {} as TuiState;
      const action = clearDef?.handler("", dummyState);
      expect(action).toBeDefined();
      expect(action?.type === "PROMPT_CLEAR" || action?.type === "ENGINE_EVENT").toBe(true);
    });
  });
});
