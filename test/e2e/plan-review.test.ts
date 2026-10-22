import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";
import { applyJournalEvent } from "../../src/engine/journal.js";
import type { EngineEvent } from "../../src/contracts/index.js";

// R10.5: `plan` ends planned (a plan to review, no worker spawned); `run --review` is the same with the worker
// recorded; `resume` runs the plan the person reviewed. The built CLI runs against the fake harness.

const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");
const binDir = resolve(__dirname, "../../test/fixtures/fake-harness/bin");
const SEED = { "src/a.txt": "seed a\n", "contracts/types.ts": CONTRACT_STUB };
const PLANNER = "claude:claude-sonnet-5-5";
const WORKER = "claude:haiku";

type Ev = { type: string; data: any };
const repos: E2ERepo[] = [];

function repo(): E2ERepo {
  const r = createE2ERepo(SEED);
  repos.push(r);
  mkdirSync(join(r.dir, ".substrate"), { recursive: true });
  writeFileSync(
    join(r.dir, ".substrate", "settings.json"),
    JSON.stringify({
      backends: {
        claude: { bin: join(binDir, "claude") },
        opencode: { bin: join(binDir, "opencode") },
        agy: { bin: join(binDir, "agy") },
      },
      concurrency: { workers: 1 },
    }),
    "utf8",
  );
  return r;
}

afterAll(() => {
  for (const r of repos) r.cleanup();
});

function cli(repoDir: string, args: string[], calls?: unknown[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "plan-review-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.FAKE_SCENARIO_FILE;
  if (calls !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), "plan-review-scenario-"));
    const file = join(dir, "scenario.json");
    writeFileSync(file, JSON.stringify({ calls }), "utf8");
    env.FAKE_SCENARIO_FILE = file;
  }
  const out = spawnSync(process.execPath, [substrateMjs, ...args], { cwd: repoDir, encoding: "utf8", env, timeout: 120000 });
  rmSync(home, { recursive: true, force: true });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

function runIdFrom(repoDir: string): string {
  const dir = join(repoDir, ".substrate", "runs");
  const ids = readdirSync(dir).filter((n) => n.startsWith("r_"));
  if (ids.length !== 1) throw new Error(`expected one run, found ${ids.length}`);
  return ids[0];
}

function eventsOf(repoDir: string, runId: string): Ev[] {
  return readFileSync(join(repoDir, ".substrate", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const count = (events: Ev[], type: string): number => events.filter((e) => e.type === type).length;

const edit = (task: string, file: string, marker: string) => ({
  task,
  edits: { [file]: `seed ${file.slice(-5, -4)}\n${marker}\n` },
  reply: `${task} done\nDONE`,
});

function onePlan(title?: string): Record<string, string> {
  const t1 = taskSpec({ id: "T1", title, write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  return contractFiles(manifestFor("Review me", ["T1"]), { "tasks/T1.md": t1 });
}

describe("R10.5: plan ends planned, for review", () => {
  it("(D) plan exits 0 with Status: planned, the task list, no merge, no worker; status, runs and watch show it", () => {
    const r = repo();
    const out = cli(r.dir, ["plan", "--plan", PLANNER, "Plan the change"], [planCall(onePlan("Edit the allowed file for T1"))]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("Status:     planned");
    expect(out.stdout).toContain("Tasks:      1 planned");
    expect(out.stdout).toContain("Merged:     no");
    expect(out.stdout).toContain("  T1  Edit the allowed file for T1  [feature]");
    expect(out.stdout).toContain("then run: substrate resume");
    expect(out.stdout).toContain("--work <provider:model[:effort]>");
    expect(out.stdout).not.toContain("0/1 passed");
    expect(readFileSync(join(r.dir, "src/a.txt"), "utf8")).toBe("seed a\n");

    const id = runIdFrom(r.dir);
    const events = eventsOf(r.dir, id);
    expect(count(events, "task.session.started")).toBe(0);
    expect(events.filter((e) => e.type === "run.finished").at(-1)?.data).toMatchObject({ exit_code: 0, reason: "planned" });

    const status = cli(r.dir, ["status", id]);
    expect(status.stdout).toMatch(/planned/);
    expect(status.stdout).toContain(`substrate resume ${id} --work <provider:model[:effort]>`);

    const runs = cli(r.dir, ["runs"]);
    expect(runs.stdout).toMatch(new RegExp(`${id}\\s+planned`));

    // Following a planned run ends on it: the run is terminal, so watch prints its summary and exits 0.
    const watch = cli(r.dir, ["watch", id]);
    expect(watch.status, watch.stderr).toBe(0);
    expect(watch.stdout).toContain("Status:     planned");
  });

  it("(E) an edited manifest and spec (title and a verify command) are what resume --work runs", () => {
    const r = repo();
    const plan = cli(r.dir, ["plan", "--plan", PLANNER, "Plan the change"], [planCall(onePlan("Edit the allowed file for T1"))]);
    expect(plan.status).toBe(0);
    const id = runIdFrom(r.dir);
    const specPath = join(r.dir, ".substrate", "runs", id, "tasks", "T1.md");
    const spec = readFileSync(specPath, "utf8");
    writeFileSync(
      specPath,
      spec
        .replace("title: Edit the allowed file for T1", "title: Reviewed title for T1")
        .replace("  - run: grep -q t1-done src/a.txt\n    timeout_s: 10", "  - run: grep -q t1-done src/a.txt\n    timeout_s: 10\n  - run: echo reviewed-verify-ran\n    timeout_s: 10"),
      "utf8",
    );

    const out = cli(r.dir, ["resume", id, "--work", WORKER], [edit("T1", "src/a.txt", "t1-done")]);
    expect(out.status, out.stderr).toBe(0);
    const events = eventsOf(r.dir, id);
    const accepted = events.filter((e) => e.type === "plan.produced").at(-1);
    expect(accepted?.data.source).toBe("review");
    expect(accepted?.data.tasks[0].title).toBe("Reviewed title for T1");
    // A passing verify is not in the event log; its full output is saved under packets/verify/ in the run directory.
    const verifyDir = join(r.dir, ".substrate", "runs", id, "packets", "verify");
    const verifyOutputs = existsSync(verifyDir) ? readdirSync(verifyDir).map((f) => readFileSync(join(verifyDir, f), "utf8")) : [];
    expect(verifyOutputs.some((text) => text.includes("reviewed-verify-ran"))).toBe(true);
    expect(out.stdout).toContain("resuming planned run");
    expect(readFileSync(join(r.dir, "src/a.txt"), "utf8")).toContain("t1-done");
  });

  it("(F) an edit that breaks lint is refused with exit 2 and no spawn; the run stays planned; fixing it resumes", () => {
    const r = repo();
    const plan = cli(r.dir, ["plan", "--plan", PLANNER, "Plan the change"], [planCall(onePlan())]);
    expect(plan.status).toBe(0);
    const id = runIdFrom(r.dir);
    const specPath = join(r.dir, ".substrate", "runs", id, "tasks", "T1.md");
    const good = readFileSync(specPath, "utf8");
    writeFileSync(specPath, good.replace("depends_on: []", "depends_on: [T9]"), "utf8");

    const refused = cli(r.dir, ["resume", id, "--work", WORKER], []);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("does not pass review");
    const afterRefusal = eventsOf(r.dir, id);
    expect(count(afterRefusal, "task.session.started")).toBe(0);
    expect(count(afterRefusal, "plan.started")).toBe(1);
    expect(count(afterRefusal, "run.reopened")).toBe(0);

    writeFileSync(specPath, good, "utf8");
    const fixed = cli(r.dir, ["resume", id, "--work", WORKER], [edit("T1", "src/a.txt", "t1-done")]);
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(readFileSync(join(r.dir, "src/a.txt"), "utf8")).toContain("t1-done");
  });

  it("(G) run --review records the worker, so a bare resume runs the plan; a plan-only run needs --work on resume", () => {
    const r = repo();
    const review = cli(r.dir, ["run", "--review", "--plan", PLANNER, "--work", WORKER, "Plan the change"], [planCall(onePlan())]);
    expect(review.status, review.stderr).toBe(0);
    expect(review.stdout).toContain("Status:     planned");
    const id = runIdFrom(r.dir);
    expect(review.stdout).toContain(`substrate resume ${id}\n`);

    const bare = cli(r.dir, ["resume", id], [edit("T1", "src/a.txt", "t1-done")]);
    expect(bare.status, bare.stderr).toBe(0);
    expect(readFileSync(join(r.dir, "src/a.txt"), "utf8")).toContain("t1-done");
  });

  it("(G) run --review without --work exits 2; a plan-only run resumed without a worker exits 2 with the message", () => {
    const r = repo();
    const noWork = cli(r.dir, ["run", "--review", "--plan", PLANNER, "Plan the change"], []);
    expect(noWork.status).toBe(2);
    expect(noWork.stderr).toContain("--review needs --work");

    const plan = cli(r.dir, ["plan", "--plan", PLANNER, "Plan the change"], [planCall(onePlan())]);
    expect(plan.status).toBe(0);
    const id = runIdFrom(r.dir);
    const noWorker = cli(r.dir, ["resume", id], []);
    expect(noWorker.status).toBe(2);
    expect(noWorker.stderr).toContain("a worker model is required: --work <provider:model[:effort]>");
  });

  it("(H) the event log of a planned-then-executed run replays to the same state twice, and ends finished", () => {
    const r = repo();
    const plan = cli(r.dir, ["plan", "--plan", PLANNER, "Plan the change"], [planCall(onePlan())]);
    expect(plan.status).toBe(0);
    const id = runIdFrom(r.dir);
    const run = cli(r.dir, ["resume", id, "--work", WORKER], [edit("T1", "src/a.txt", "t1-done")]);
    expect(run.status, run.stderr).toBe(0);

    const events = eventsOf(r.dir, id) as unknown as EngineEvent[];
    const init = { run_id: id, state: "CREATED", tasks: {}, usage: { total_usd: 0, by_role: {} }, checkpoints: [] } as any;
    const first = events.reduce((s, e) => applyJournalEvent(s, e), init);
    const second = events.reduce((s, e) => applyJournalEvent(s, e), init);
    expect(second).toEqual(first);
    expect(first.state).toBe("FINISHED");
    expect(existsSync(join(r.dir, ".substrate", "runs", id, "events.jsonl"))).toBe(true);
  });
});
