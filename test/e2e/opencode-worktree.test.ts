import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runSubstrate } from "./helpers/run-substrate.js";

// Known issue 7: the opencode adapter writes its per-run agent file (and opencode.json when a
// local provider is set) into the request directory. For a worker that is the task worktree.
// This test runs a worker through the fake opencode dialect and checks what a task leaves in
// the worktree and in its diff. It documents the current behaviour: the files are present in
// the worktree while opencode runs, they are hidden from git by the worktree's info/exclude
// entry, and they are removed when the session ends.

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const FAKE_OPENCODE = resolve(PROJECT_ROOT, "test/fixtures/fake-harness/bin/opencode");

function git(dir: string, args: string[]): { status: number; out: string } {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return { status: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

describe("opencode config files and task worktrees (known issue 7)", () => {
  it("a worker run leaves no opencode config in the worktree status, the diff or the merged tree", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "substrate-opencode-wt-"));
    const logPath = join(logDir, "invocations.log");
    const wrapperPath = join(logDir, "opencode-wrapper.sh");
    // The wrapper records what the worktree looks like when opencode starts, then runs the fake.
    writeFileSync(
      wrapperPath,
      `#!/bin/sh
{
  echo "CWD=$PWD"
  echo "--- files under .opencode:"
  find .opencode -type f 2>/dev/null
  echo "--- git status --porcelain at start:"
  git status --porcelain 2>/dev/null
  echo "--- end"
} >> '${logPath}'
exec '${FAKE_OPENCODE}' "$@"
`,
      "utf8",
    );
    chmodSync(wrapperPath, 0o755);

    const seed = "one\n";
    const res = runSubstrate({
      files: { "src/a.txt": seed },
      scenario: { calls: [{ reply: "DONE" }] },
      settings: {
        backends: { opencode: { bin: wrapperPath } },
        profiles: {
          opencode: {
            plan: { model: "opencode/deepseek-v4.1-flash-free", effort: "medium" },
            work: { model: "opencode/deepseek-v4.1-flash-free", effort: "medium" },
          },
        },
        defaults: { planner_provider: "opencode", worker_provider: "opencode" },
        roles: { worker: { backend: "opencode", model: "opencode/deepseek-v4.1-flash-free" } },
      },
      args: ["run", "--permission-mode", "bypassPermissions", "--mode", "solo", "--work", "opencode:opencode/deepseek-v4.1-flash-free", "execute the worker"],
    });

    try {
      expect(res.exitCode, `stdout: ${res.stdout.slice(-1500)}\nstderr: ${res.stderr.slice(-1500)}`).toBe(0);
      expect(res.stdout).toMatch(/Status:\s+finished/);

      // The worker ran in a task worktree, not in the repository root.
      const log = readFileSync(logPath, "utf8");
      // R7.2: a named --work sends the request path, which first probes the model catalog from
      // the repo root. The worker's own invocation is the last CWD line.
      const worker = log.slice(log.lastIndexOf("CWD="));
      const cwdLine = worker.split("\n")[0];
      expect(cwdLine).toBeDefined();
      expect(cwdLine).toContain(join(".substrate", "worktrees"));

      // While opencode ran, git status showed nothing, even though the agent file was present.
      const statusSection = worker.split("--- git status --porcelain at start:")[1] ?? "";
      expect(statusSection.split("--- end")[0].trim()).toBe("");

      // Current behaviour (known issue 7): the agent file is in the worktree during the run.
      expect(log).toMatch(/\.opencode\/agents\/agent_[a-z0-9]+\.md/);

      // Afterwards: no agent file or opencode.json is left in any task worktree, and every
      // worktree still reports a clean status.
      const worktreesRoot = join(res.repoDir, ".substrate", "worktrees");
      const leftovers = listFiles(worktreesRoot).filter(
        (f) => /agent_[a-z0-9]+\.md$/.test(f) || f.endsWith("opencode.json"),
      );
      expect(leftovers).toEqual([]);
      if (existsSync(worktreesRoot)) {
        for (const runDir of readdirSync(worktreesRoot)) {
          for (const taskDir of readdirSync(join(worktreesRoot, runDir))) {
            const wt = join(worktreesRoot, runDir, taskDir);
            expect(git(wt, ["status", "--porcelain"]).out).toBe("");
          }
        }
      }

      // The merged tree and the diff from the seed commit contain no opencode config.
      const tree = git(res.repoDir, ["ls-tree", "-r", "--name-only", "main"]).out.split("\n");
      expect(tree.filter((p) => p.startsWith(".opencode/") || p === "opencode.json")).toEqual([]);
      const root = git(res.repoDir, ["rev-list", "--max-parents=0", "main"]).out.split("\n")[0];
      const diff = git(res.repoDir, ["diff", "--name-only", root, "main"]).out.split("\n").filter(Boolean);
      expect(diff.filter((p) => p.startsWith(".opencode/") || p === "opencode.json")).toEqual([]);
    } finally {
      res.cleanup();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
