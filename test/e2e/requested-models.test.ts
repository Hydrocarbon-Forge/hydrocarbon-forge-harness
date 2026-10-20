import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R7.4: the models a caller names (--plan, --work) reach every role. The fake claude
// dialect appends each spawn's argv to FAKE_ARGV_LOG, so the --model of every process is
// observable. The planner is the first spawn; every later spawn is a task.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };

// Settings that name other models everywhere a request could otherwise be ignored: a
// profile for both roles, a feature route and a worker role. The request must beat all of them.
const CONFLICTING_SETTINGS = {
  profiles: {
    claude: {
      plan: { model: "claude-opus-5-5", effort: "medium" },
      work: { model: "claude-opus-5-5", effort: "medium" },
    },
  },
  defaults: { planner_provider: "claude", worker_provider: "claude" },
  routing: { feature: { backend: "claude", model: "claude-opus-5-5" } },
  roles: { worker: { backend: "claude", model: "claude-opus-5-5" } },
};

const CLAUDE_BIN = resolve(fileURLToPath(import.meta.url), "../../fixtures/fake-harness/bin/claude");

// The claude adapter passes its child only an allowlisted environment, so FAKE_ARGV_LOG
// reaches the fake through a wrapper that exports it (as adapters.test.ts does).
function claudeWrapper(dir: string, argvLog: string): string {
  const wrapper = join(dir, "claude-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_ARGV_LOG='${argvLog}'\nexec '${CLAUDE_BIN}' "$@"\n`, { mode: 0o755 });
  return wrapper;
}

interface Spawn {
  argv: string[];
  model: string | undefined;
}

function spawnsOf(res: RunSubstrateResult, argvLog: string): Spawn[] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const argv = (JSON.parse(line) as { argv: string[] }).argv;
      const idx = argv.indexOf("--model");
      return { argv, model: idx >= 0 ? argv[idx + 1] : undefined };
    })
    // The harness version probe is logged too; only real spawns count.
    .filter((spawn) => !spawn.argv.includes("--version"));
}

function diagnostics(res: RunSubstrateResult): string {
  return `exit=${res.exitCode}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`;
}

describe("R7.4: requested planner and worker models reach every role", () => {
  it("plan mode: the planner spawn uses --plan's model and every task spawn uses --work's model", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-r74-plan-"));
    const argvLog = join(dir, "argv.log");
    const claude = claudeWrapper(dir, argvLog);
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const scenarioCalls = [
      planCall(contractFiles(manifestFor("Requested models", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
      { edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "T1 done\nDONE" },
      { edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "T2 done\nDONE" },
    ];
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: scenarioCalls },
      settings: { ...CONFLICTING_SETTINGS, backends: { claude: { bin: claude } } },
      args: [...RUN_ARGS, "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "Two tasks with named models"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const spawns = spawnsOf(res, argvLog);
      expect(spawns.length, diagnostics(res)).toBe(3);
      expect(spawns[0].model).toBe("claude-sonnet-5-5");
      expect(spawns.slice(1).map((s) => s.model)).toEqual(["haiku", "haiku"]);
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("solo: --work's model is the solo worker, beating routing.feature and roles.worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-r74-solo-"));
    const argvLog = join(dir, "argv.log");
    const claude = claudeWrapper(dir, argvLog);
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [{ edits: { "a.txt": "created\n" }, reply: "DONE" }] },
      settings: { ...CONFLICTING_SETTINGS, backends: { claude: { bin: claude } } },
      args: ["run", "--mode", "solo", "--work", "claude:haiku", "--verify", "test -f a.txt", "create a.txt"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);
      const spawns = spawnsOf(res, argvLog);
      expect(spawns.length, diagnostics(res)).toBe(1);
      expect(spawns[0].model).toBe("haiku");
    } finally {
      res.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
