import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// W5a (docs/design/web-ui.md, 7): the planner's amendment is written into the run's inbox. A resume of a failed run
// applies it before scheduling: the new task runs and passes, a started task's change is reported and not applied,
// and an amendment the plan lint refuses (a dependency cycle) is refused in chat while the run goes on unchanged.

const substrateMjs = resolve(__dirname, "../../dist/substrate.mjs");
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };

type Ev = { type: string; data: any };

function eventsIn(runDir: string): Ev[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function chatIn(runDir: string): { role: string; status: string; reply_to: string | null; text: string }[] {
  const file = join(runDir, "chat.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Runs the built CLI in the repo. `calls` gives the fake harness its scripted calls for this round only. */
function cli(repoDir: string, args: string[], calls: unknown[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "substrate-amend-home-"));
  const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-amend-scenario-"));
  const file = join(scenarioDir, "scenario.json");
  writeFileSync(file, JSON.stringify({ calls }), "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FAKE_SCENARIO_FILE: file };
  try {
    const out = spawnSync(process.execPath, [substrateMjs, ...args], { cwd: repoDir, encoding: "utf8", env, timeout: 120000 });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(scenarioDir, { recursive: true, force: true });
  }
}

const edit = (task: string, file: string, marker: string) => ({
  task,
  edits: { [file]: `seed ${file.slice(-5, -4)}\n${marker}\n` },
  reply: `${task} done\nDONE`,
});

/** T1 passes; T2 fails on each of its scripted calls; T3 depends on T2 and is skipped. */
function threeTaskFailure(): RunSubstrateResult {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  const t3 = taskSpec({ id: "T3", write: ["src/c.txt"], dependsOn: ["T2"], verify: "grep -q t3-done src/c.txt" });
  return runSubstrate({
    files: SEED,
    scenario: {
      calls: [
        planCall(contractFiles(manifestFor("Three", ["T1", "T2", "T3"]), { "tasks/T1.md": t1, "tasks/T2.md": t2, "tasks/T3.md": t3 })),
        edit("T1", "src/a.txt", "t1-done"),
        { task: "T2", reply: "DONE" },
        { task: "T2", reply: "DONE" },
      ],
    },
    args: [...RUN_ARGS, "Three tasks"],
  });
}

/**
 * Writes an amendment into the run: runs/<id>/amendments/c1/ holds a full plan (manifest, specs, contract stub), and
 * inbox/1.json asks the engine to apply it. `files` are the amendment's spec and manifest texts.
 */
function writeAmendment(runDir: string, manifest: string, specs: Record<string, string>): void {
  const dir = join(runDir, "amendments", "c1");
  mkdirSync(join(dir, "tasks"), { recursive: true });
  mkdirSync(join(dir, "contracts"), { recursive: true });
  copyFileSync(join(runDir, "contracts", "types.ts"), join(dir, "contracts", "types.ts"));
  writeFileSync(join(dir, "manifest.yaml"), manifest, "utf8");
  for (const [rel, text] of Object.entries(specs)) writeFileSync(join(dir, rel), text, "utf8");
  mkdirSync(join(runDir, "inbox"), { recursive: true });
  writeFileSync(
    join(runDir, "inbox", "1.json"),
    JSON.stringify({ v: 1, n: 1, ts: new Date().toISOString(), kind: "amendment", chat_id: "c1", dir: "amendments/c1" }),
    "utf8",
  );
}

describe("W5a: a resume applies a pending amendment; a started task is kept and reported", () => {
  it("adds T4 (it runs and passes), reports T1 as kept_started without changing its spec, and says so in chat", () => {
    const res = threeTaskFailure();
    try {
      expect(res.exitCode).toBe(1);
      const runDir = res.runDir as string;
      const runId = runDir.split("/").at(-1) as string;
      const t1Before = readFileSync(join(runDir, "tasks", "T1.md"), "utf8");

      const t4 = taskSpec({ id: "T4", dependsOn: ["T1"], write: ["src/d.txt"], verify: "grep -q t4-done src/d.txt" });
      const changedT1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-edited src/a.txt" });
      writeAmendment(
        runDir,
        manifestFor("Three and four", ["T1", "T2", "T3", "T4"]),
        {
          "tasks/T1.md": changedT1,
          "tasks/T2.md": readFileSync(join(runDir, "tasks", "T2.md"), "utf8"),
          "tasks/T3.md": readFileSync(join(runDir, "tasks", "T3.md"), "utf8"),
          "tasks/T4.md": t4,
        },
      );

      const out = cli(res.repoDir, ["resume", runId], [
        edit("T2", "src/b.txt", "t2-done"),
        edit("T3", "src/c.txt", "t3-done"),
        edit("T4", "src/d.txt", "t4-done"),
      ]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("finished: 4/4 passed");

      const events = eventsIn(runDir);
      expect(events.some((e) => e.type === "run.message" && e.data.message_id === 1)).toBe(true);
      const amended = events.filter((e) => e.type === "run.amended").at(-1);
      expect(amended?.data).toMatchObject({
        chat_id: "c1",
        outcome: "applied",
        applied_at: "resume",
        added: ["T4"],
        kept_started: ["T1"],
      });
      const started = (task: string) => events.filter((e) => e.type === "task.session.started" && e.data.task_id === task).length;
      expect(started("T4")).toBe(1);
      // T1 ran once, in the failed run; the resume does not start it again.
      expect(started("T1")).toBe(1);
      expect(events.filter((e) => e.type === "run.finished").at(-1)?.data.exit_code).toBe(0);

      // The started task's spec is not read and not written: it is the one the run had.
      expect(readFileSync(join(runDir, "tasks", "T1.md"), "utf8")).toBe(t1Before);
      expect(readFileSync(join(res.repoDir, "src/d.txt"), "utf8")).toContain("t4-done");

      // Its chat reply names what was applied and what was kept.
      const reply = chatIn(runDir).find((m) => m.role === "system" && m.reply_to === "c1");
      expect(reply?.status).toBe("answered");
      expect(reply?.text).toContain("added T4");
      expect(reply?.text).toContain("kept, already started and not changed: T1");
    } finally {
      res.cleanup();
    }
  });

  it("refuses an amendment that the plan lint blocks (a dependency cycle) and resumes the run unchanged", () => {
    const res = threeTaskFailure();
    try {
      const runDir = res.runDir as string;
      const runId = runDir.split("/").at(-1) as string;
      const t4 = taskSpec({ id: "T4", dependsOn: ["T5"], write: ["src/d.txt"], verify: "grep -q t4-done src/d.txt" });
      const t5 = taskSpec({ id: "T5", dependsOn: ["T4"], write: ["src/e.txt"], verify: "grep -q t5-done src/e.txt" });
      writeAmendment(
        runDir,
        manifestFor("Cycle", ["T1", "T2", "T3", "T4", "T5"]),
        {
          "tasks/T1.md": readFileSync(join(runDir, "tasks", "T1.md"), "utf8"),
          "tasks/T2.md": readFileSync(join(runDir, "tasks", "T2.md"), "utf8"),
          "tasks/T3.md": readFileSync(join(runDir, "tasks", "T3.md"), "utf8"),
          "tasks/T4.md": t4,
          "tasks/T5.md": t5,
        },
      );

      const out = cli(res.repoDir, ["resume", runId], [
        edit("T2", "src/b.txt", "t2-done"),
        edit("T3", "src/c.txt", "t3-done"),
      ]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("finished: 3/3 passed");

      const events = eventsIn(runDir);
      const refused = events.filter((e) => e.type === "run.amended").at(-1);
      expect(refused?.data.outcome).toBe("rejected");
      expect(refused?.data.reason).toContain("[L005]");
      expect(events.some((e) => e.type === "task.session.started" && (e.data.task_id === "T4" || e.data.task_id === "T5"))).toBe(false);

      const reply = chatIn(runDir).find((m) => m.role === "system" && m.reply_to === "c1");
      expect(reply?.status).toBe("refused");
      expect(reply?.text).toContain("[L005]");
      // The refused message is kept as evidence, not left to be read again.
      expect(existsSync(join(runDir, "inbox", "consumed", "1.json"))).toBe(true);
      expect(existsSync(join(runDir, "inbox", "1.json"))).toBe(false);
    } finally {
      res.cleanup();
    }
  });
});
