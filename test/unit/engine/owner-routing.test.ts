import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { VerifyResult } from "../../../src/contracts/index.js";
import type { EngineState } from "../../../src/engine/reducer.js";
import {
  MAX_OWNER_ROUTINGS_PER_TASK,
  applyOwnerRoute,
  decideOwnerRoute,
  mentionsPath,
} from "../../../src/engine/owner-routing.js";
import { parseTaskSpec, parseManifest } from "../../../src/spec/index.js";
import { sampleManifestYaml, sampleTaskSpecMarkdown } from "../spec/fixtures.js";

// 2026-10-23 (owner, item 88): a failure that names another task's files is routed to that task. These tests cover the
// decision (who owns the failing files, defer or fix, and when routing is not taken) and the files the route writes.

let runDir: string;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-routing-"));
  fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

interface PlannedTask {
  id: string;
  depends_on?: string[];
  write?: string[];
  create?: string[];
}

function writePlan(tasks: PlannedTask[]): void {
  const entries = tasks.map((t) => ({ id: t.id, spec: `tasks/${t.id}.md` }));
  fs.writeFileSync(path.join(runDir, "manifest.yaml"), sampleManifestYaml({ tasks: entries }), "utf8");
  for (const t of tasks) {
    fs.writeFileSync(
      path.join(runDir, "tasks", `${t.id}.md`),
      sampleTaskSpecMarkdown({
        frontmatter: {
          id: t.id,
          title: `Task ${t.id}`,
          depends_on: t.depends_on ?? [],
          write: t.write ?? [],
          create: t.create ?? [],
          protected: [],
          verify: [{ run: `grep -q x ${(t.write ?? ["none"])[0]}`, timeout_s: 10 }],
        },
      }),
      "utf8",
    );
  }
}

function failed(cmd: string, stderr = ""): VerifyResult {
  return {
    cmd,
    exit_code: 1,
    timed_out: false,
    duration_ms: 1,
    stdout_tail: "",
    stderr_tail: stderr,
    truncated: false,
  };
}

function stateOf(states: Record<string, string>): EngineState {
  const tasks: Record<string, { id: string; state: string; generation: number; attempt: number }> = {};
  for (const [id, state] of Object.entries(states)) {
    tasks[id] = { id, state, generation: 1, attempt: 2 };
  }
  return { tasks } as unknown as EngineState;
}

const TWO_TASKS: PlannedTask[] = [
  { id: "A", write: ["src/a.txt"] },
  { id: "B", write: ["src/b.txt"] },
];

describe("mentionsPath: a path is matched as a whole token", () => {
  it("matches the path at a token boundary, including before a sentence period", () => {
    expect(mentionsPath("grep -q x src/a.txt", "src/a.txt")).toBe(true);
    expect(mentionsPath("src/a.txt. failed", "src/a.txt")).toBe(true);
    expect(mentionsPath("see src/a.txt:12", "src/a.txt")).toBe(true);
  });

  it("does not match a longer name or a path inside another path", () => {
    expect(mentionsPath("src/a.txt2", "src/a.txt")).toBe(false);
    expect(mentionsPath("old/src/a.txt", "src/a.txt")).toBe(false);
    expect(mentionsPath("src/a.txt.bak", "src/a.txt")).toBe(false);
  });

  it("matches a directory entry by its prefix", () => {
    expect(mentionsPath("lint src/feature/x.ts", "src/feature/")).toBe(true);
    expect(mentionsPath("lint src/other/x.ts", "src/feature/")).toBe(false);
  });
});

describe("decideOwnerRoute: which task owns the failing files", () => {
  it("defers when the owner has not merged yet", () => {
    writePlan(TWO_TASKS);
    const route = decideOwnerRoute({
      runDir,
      taskId: "B",
      state: stateOf({ A: "PENDING", B: "REPLANNING" }),
      verify: [failed("grep -q a-done src/a.txt")],
      routings: 0,
    });
    expect(route).toMatchObject({ kind: "defer", owner: "A", files: ["src/a.txt"] });
  });

  it("takes a fix route when the owner has merged", () => {
    writePlan(TWO_TASKS);
    const route = decideOwnerRoute({
      runDir,
      taskId: "B",
      state: stateOf({ A: "MERGED", B: "REPLANNING" }),
      verify: [failed("grep -q a-done src/a.txt", "no match")],
      routings: 0,
    });
    expect(route).toMatchObject({ kind: "fix", owner: "A", files: ["src/a.txt"], commands: ["grep -q a-done src/a.txt"] });
  });

  it("leaves the failure to the ladder when the task's own files are named", () => {
    writePlan(TWO_TASKS);
    const route = decideOwnerRoute({
      runDir,
      taskId: "B",
      state: stateOf({ A: "MERGED", B: "REPLANNING" }),
      verify: [failed("grep -q b-done src/b.txt src/a.txt")],
      routings: 0,
    });
    expect(route).toBeUndefined();
  });

  it("leaves the failure to the ladder when no other task owns a named file", () => {
    writePlan(TWO_TASKS);
    expect(
      decideOwnerRoute({
        runDir,
        taskId: "B",
        state: stateOf({ A: "MERGED", B: "REPLANNING" }),
        verify: [failed("grep -q z src/unowned.txt")],
        routings: 0,
      }),
    ).toBeUndefined();
  });

  it("leaves the failure to the ladder when two tasks own the named files", () => {
    writePlan([
      { id: "A", write: ["src/shared.txt"] },
      { id: "C", write: ["src/shared.txt"] },
      { id: "B", write: ["src/b.txt"] },
    ]);
    expect(
      decideOwnerRoute({
        runDir,
        taskId: "B",
        state: stateOf({ A: "MERGED", C: "MERGED", B: "REPLANNING" }),
        verify: [failed("grep -q k src/shared.txt")],
        routings: 0,
      }),
    ).toBeUndefined();
  });

  it("leaves the failure to the ladder when the owner has failed for good", () => {
    writePlan(TWO_TASKS);
    expect(
      decideOwnerRoute({
        runDir,
        taskId: "B",
        state: stateOf({ A: "BLOCKED", B: "REPLANNING" }),
        verify: [failed("grep -q a-done src/a.txt")],
        routings: 0,
      }),
    ).toBeUndefined();
  });

  it("leaves the failure to the ladder when the owner depends on this task (a cycle)", () => {
    writePlan([
      { id: "A", write: ["src/a.txt"], depends_on: ["B"] },
      { id: "B", write: ["src/b.txt"] },
    ]);
    expect(
      decideOwnerRoute({
        runDir,
        taskId: "B",
        state: stateOf({ A: "PENDING", B: "REPLANNING" }),
        verify: [failed("grep -q a-done src/a.txt")],
        routings: 0,
      }),
    ).toBeUndefined();
  });

  it("stops routing once the per-task cap is reached", () => {
    writePlan(TWO_TASKS);
    expect(
      decideOwnerRoute({
        runDir,
        taskId: "B",
        state: stateOf({ A: "PENDING", B: "REPLANNING" }),
        verify: [failed("grep -q a-done src/a.txt")],
        routings: MAX_OWNER_ROUTINGS_PER_TASK,
      }),
    ).toBeUndefined();
  });

  it("leaves the failure to the ladder when the manifest cannot be read", () => {
    expect(
      decideOwnerRoute({
        runDir,
        taskId: "B",
        state: stateOf({ A: "MERGED", B: "REPLANNING" }),
        verify: [failed("grep -q a-done src/a.txt")],
        routings: 0,
      }),
    ).toBeUndefined();
  });

  it("ignores passing checks", () => {
    writePlan(TWO_TASKS);
    const passing: VerifyResult = { ...failed("grep -q a-done src/a.txt"), exit_code: 0 };
    expect(
      decideOwnerRoute({
        runDir,
        taskId: "B",
        state: stateOf({ A: "MERGED", B: "REPLANNING" }),
        verify: [passing],
        routings: 0,
      }),
    ).toBeUndefined();
  });
});

describe("applyOwnerRoute: what the route writes", () => {
  it("defer adds the owner to the task's depends_on and leaves the manifest alone", () => {
    writePlan(TWO_TASKS);
    const before = fs.readFileSync(path.join(runDir, "manifest.yaml"), "utf8");
    const route = decideOwnerRoute({
      runDir,
      taskId: "B",
      state: stateOf({ A: "PENDING", B: "REPLANNING" }),
      verify: [failed("grep -q a-done src/a.txt")],
      routings: 0,
    });
    const applied = applyOwnerRoute(runDir, "B", route!, stateOf({ A: "PENDING", B: "REPLANNING" }));
    expect(applied?.fixTaskId).toBeUndefined();
    expect(fs.readFileSync(path.join(runDir, "manifest.yaml"), "utf8")).toBe(before);
    const spec = parseTaskSpec(fs.readFileSync(path.join(runDir, "tasks", "B.md"), "utf8"), "tasks/B.md");
    expect(spec.frontmatter.depends_on).toEqual(["A"]);
    expect(spec.sections.has("Objective")).toBe(true);
  });

  it("fix adds a task that owns the failing files and depends on the owner, then the task depends on the fix", () => {
    writePlan(TWO_TASKS);
    const state = stateOf({ A: "MERGED", B: "REPLANNING" });
    const route = decideOwnerRoute({ runDir, taskId: "B", state, verify: [failed("grep -q a-done src/a.txt")], routings: 0 });
    const applied = applyOwnerRoute(runDir, "B", route!, state);
    expect(applied?.fixTaskId).toBe("A-FIX1");

    const manifest = parseManifest(fs.readFileSync(path.join(runDir, "manifest.yaml"), "utf8"), "manifest.yaml");
    expect(manifest.tasks.map((t) => t.id)).toEqual(["A", "B", "A-FIX1"]);

    const fix = parseTaskSpec(fs.readFileSync(path.join(runDir, "tasks", "A-FIX1.md"), "utf8"), "tasks/A-FIX1.md");
    expect(fix.frontmatter.depends_on).toEqual(["A"]);
    expect(fix.frontmatter.write).toEqual(["src/a.txt"]);
    expect(fix.frontmatter.verify[0]?.run).toBe("grep -q a-done src/a.txt");
    expect(fix.sections.has("Objective")).toBe(true);

    const spec = parseTaskSpec(fs.readFileSync(path.join(runDir, "tasks", "B.md"), "utf8"), "tasks/B.md");
    expect(spec.frontmatter.depends_on).toEqual(["A-FIX1"]);
  });

  it("restore puts back the files the route wrote, and removes the fix task", () => {
    writePlan(TWO_TASKS);
    const beforeSpec = fs.readFileSync(path.join(runDir, "tasks", "B.md"), "utf8");
    const beforeManifest = fs.readFileSync(path.join(runDir, "manifest.yaml"), "utf8");
    const state = stateOf({ A: "MERGED", B: "REPLANNING" });
    const route = decideOwnerRoute({ runDir, taskId: "B", state, verify: [failed("grep -q a-done src/a.txt")], routings: 0 });
    const applied = applyOwnerRoute(runDir, "B", route!, state);
    applied?.restore();
    expect(fs.readFileSync(path.join(runDir, "tasks", "B.md"), "utf8")).toBe(beforeSpec);
    expect(fs.readFileSync(path.join(runDir, "manifest.yaml"), "utf8")).toBe(beforeManifest);
    expect(fs.existsSync(path.join(runDir, "tasks", "A-FIX1.md"))).toBe(false);
  });
});
