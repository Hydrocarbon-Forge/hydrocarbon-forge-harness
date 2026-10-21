import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createE2ERepo, type E2ERepo } from "./helpers/repo.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// R12.3: plan lint blocks only a plan that cannot run. A plan that trips several former-error rules (warnings
// now) is accepted on the first planner attempt, the warnings are recorded and shown, and the run proceeds.
// A dependency cycle is still refused and retried. The built CLI runs against the fake harness.

const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");
const binDir = resolve(__dirname, "../../test/fixtures/fake-harness/bin");
const PLANNER = "claude:claude-sonnet-5-5";
const WORKER = "claude:haiku";
const BAD_TYPECHECK = "node -e 'process.exit(1)'";

/** A read set above the 50-file cap: 60 files under src/many. */
const MANY = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/many/f${i}.txt`, `file ${i}\n`]));
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB, ...MANY };

type Ev = { type: string; data: any };
const repos: E2ERepo[] = [];

afterAll(() => {
  for (const r of repos) r.cleanup();
});

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

function cli(repoDir: string, args: string[], calls?: unknown[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "lint-soft-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.FAKE_SCENARIO_FILE;
  if (calls !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), "lint-soft-scenario-"));
    const file = join(dir, "scenario.json");
    writeFileSync(file, JSON.stringify({ calls }), "utf8");
    env.FAKE_SCENARIO_FILE = file;
  }
  const out = spawnSync(process.execPath, [substrateMjs, ...args], { cwd: repoDir, encoding: "utf8", env, timeout: 120000 });
  rmSync(home, { recursive: true, force: true });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

function runIdFrom(repoDir: string): string {
  const ids = readdirSync(join(repoDir, ".substrate", "runs")).filter((n) => n.startsWith("r_"));
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

/** The plan-warnings.txt lines of a run: [id, task, message] per line. */
function warningLines(repoDir: string, runId: string): string[][] {
  const file = join(repoDir, ".substrate", "runs", runId, "plan-warnings.txt");
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => l.split("\t"));
}

/** A spec whose read set is the 60-file glob (over the cap of 50). */
function bigReadSpec(spec: string): string {
  return spec.replace("read:\n  - contracts/types.ts", "read:\n  - src/many/*");
}

/**
 * The plan of the warnings case: a contract typecheck that fails (L018), an overlap of two write sets in
 * one layer (L008), a path one task protects that the other writes with no dependency (L009), a verify
 * binary that is not on PATH (L011) and a read set over the cap (L017).
 */
function warnedPlan(): Record<string, string> {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], protectedPaths: ["src/b.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = bigReadSpec(
    taskSpec({
      id: "T2",
      write: ["src/b.txt", "src/a.txt"],
      verify: "definitely-not-on-path-tool --check",
    }),
  );
  const manifest = manifestFor("Several warnings", ["T1", "T2"]).replace("echo typecheck contracts", BAD_TYPECHECK);
  return contractFiles(manifest, { "tasks/T1.md": t1, "tasks/T2.md": t2 });
}

/** A plan whose T2 depends on T1, so the protected write is a descendant write (L009), and T1 reads the big set. */
function runnablePlan(): Record<string, string> {
  const t1 = bigReadSpec(taskSpec({ id: "T1", write: ["src/a.txt"], protectedPaths: ["src/b.txt"], verify: "grep -q t1-done src/a.txt" }));
  const t2 = taskSpec({ id: "T2", dependsOn: ["T1"], write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  return contractFiles(manifestFor("Run the warned plan", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 });
}

/** A plan with a dependency cycle (L005): T1 needs T2 and T2 needs T1. */
function cyclePlan(): Record<string, string> {
  const t1 = taskSpec({ id: "T1", dependsOn: ["T2"], write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", dependsOn: ["T1"], write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  return contractFiles(manifestFor("A cycle", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 });
}

const edit = (task: string, file: string, marker: string) => ({
  task,
  edits: { [file]: `seed ${file.slice(-5, -4)}\n${marker}\n` },
  reply: `${task} done\nDONE`,
});

describe("R12.3: lint warnings never refuse a plan", () => {
  it("(A) a plan that trips five former-error rules is accepted on the first attempt, with the warnings recorded and shown", () => {
    const r = repo();
    const out = cli(r.dir, ["plan", "--plan", PLANNER, "Plan the warned change"], [planCall(warnedPlan())]);
    expect(out.status, out.stderr + out.stdout).toBe(0);

    const id = runIdFrom(r.dir);
    const events = eventsOf(r.dir, id);
    // One planner attempt: no retry and no format rejection.
    expect(count(events, "usage.recorded")).toBe(1);
    expect(count(events, "plan.format_rejected")).toBe(0);
    expect(count(events, "plan.ready")).toBe(1);
    expect(out.stdout).toContain("Status:     planned");

    // The warnings are in plan-warnings.txt, one per line, with their ids.
    const lines = warningLines(r.dir, id);
    const ids = [...new Set(lines.map((l) => l[0]))].sort();
    expect(ids).toEqual(["L008", "L009", "L011", "L017", "L018"]);
    expect(lines.every((l) => l.length === 3 && l[2].length > 0)).toBe(true);

    // plan.produced carries them, with the total.
    const produced = events.filter((e) => e.type === "plan.produced").at(-1);
    expect(produced?.data.warning_count).toBe(lines.length);
    expect(produced?.data.warnings.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining(["L008", "L009", "L011", "L017", "L018"]));
    expect(produced?.data.warnings.every((w: { message: string }) => w.message.length <= 300)).toBe(true);

    // The `plan ready` line is followed by the one note line, which names the file and the first warning.
    const note = new RegExp(
      `plan ready: 2 tasks\\n\\[\\d\\d:\\d\\d\\] note: the plan has ${lines.length} warnings ` +
        `\\(see \\.substrate/runs/${id}/plan-warnings\\.txt\\); the first: L\\d{3} `,
    );
    expect(out.stdout).toMatch(note);
    expect(out.stdout.match(/note: the plan has/g)?.length).toBe(1);
  });

  it("(B) a plan with warnings runs to the end: the tasks pass, the run lands, and the json result counts the warnings", () => {
    const r = repo();
    const out = cli(
      r.dir,
      ["run", "--mode", "plan", "--plan", PLANNER, "--work", WORKER, "--permission-mode", "bypassPermissions", "--output-format", "json", "Run the warned plan"],
      [
        planCall(runnablePlan()),
        edit("T1", "src/a.txt", "t1-done"),
        edit("T2", "src/b.txt", "t2-done"),
      ],
    );
    expect(out.status, out.stderr + out.stdout).toBe(0);
    const result = JSON.parse(out.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(result.status).toBe("finished");
    expect(result.plan_warnings).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(r.dir, "src/a.txt"), "utf8")).toContain("t1-done");
    expect(readFileSync(join(r.dir, "src/b.txt"), "utf8")).toContain("t2-done");

    const id = runIdFrom(r.dir);
    const ids = warningLines(r.dir, id).map((l) => l[0]);
    expect(ids).toEqual(expect.arrayContaining(["L009", "L017"]));
    // The note is also in the run's progress log, which a json run still writes.
    expect(readFileSync(join(r.dir, ".substrate", "runs", id, "progress.log"), "utf8")).toContain("note: the plan has");
  });

  it("(C) a dependency cycle is still refused: the planner is asked again, and after the last attempt the run fails spec_invalid", () => {
    const r = repo();
    const out = cli(r.dir, ["plan", "--plan", PLANNER, "Plan a cycle"], [planCall(cyclePlan()), planCall(cyclePlan()), planCall(cyclePlan())]);
    expect(out.status).not.toBe(0);
    const id = runIdFrom(r.dir);
    const events = eventsOf(r.dir, id);
    const rejected = events.filter((e) => e.type === "plan.format_rejected").map((e) => e.data.attempt);
    expect(rejected).toEqual([1, 2, 3]);
    expect(count(events, "plan.produced")).toBe(0);
    expect(out.stdout).toContain("plan rejected (attempt 3/3)");
    const failed = events.find((e) => e.type === "task.failed");
    expect(failed?.data.failure_class).toBe("spec_invalid");
    expect(String(failed?.data.message)).toContain("[L005]");
  });

  it("(D) resume of an edited planned run: a warning-only edit passes and is noted; a blocker is refused with exit 2 and no spawn", () => {
    const r = repo();
    const plan = cli(r.dir, ["plan", "--plan", PLANNER, "Plan the change"], [planCall(runnablePlan())]);
    expect(plan.status, plan.stderr).toBe(0);
    const id = runIdFrom(r.dir);
    const specPath = join(r.dir, ".substrate", "runs", id, "tasks", "T1.md");
    const good = readFileSync(specPath, "utf8");

    // A blocker: T1 depends on a task the plan does not have. Refused with exit 2, nothing spawned.
    writeFileSync(specPath, good.replace("depends_on: []", "depends_on: [T9]"), "utf8");
    const refused = cli(r.dir, ["resume", id, "--work", WORKER], []);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("does not pass review");
    const afterRefusal = eventsOf(r.dir, id);
    expect(count(afterRefusal, "task.session.started")).toBe(0);
    expect(count(afterRefusal, "plan.produced")).toBe(1);

    // A warning-only edit: an empty Edge cases section (L014). The plan passes, the note is printed, the work runs.
    writeFileSync(specPath, good.replace("## Edge cases\n\nThe file is not rewritten, only appended.", "## Edge cases\n"), "utf8");
    const resumed = cli(r.dir, ["resume", id, "--work", WORKER], [
      edit("T1", "src/a.txt", "t1-done"),
      edit("T2", "src/b.txt", "t2-done"),
    ]);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(resumed.stdout).toMatch(/note: the plan has \d+ warnings \(see \.substrate\/runs\/r_[A-Z0-9]+\/plan-warnings\.txt\)/);
    const ids = warningLines(r.dir, id).map((l) => l[0]);
    expect(ids).toContain("L014");
    expect(existsSync(join(r.dir, "src/a.txt"))).toBe(true);
  });
});
