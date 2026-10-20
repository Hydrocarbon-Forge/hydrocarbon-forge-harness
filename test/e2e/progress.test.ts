import { describe, it, expect } from "vitest";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";

// Plan and worker scenario for a two-task run. The write targets exist at base, so the
// plan passes lint; T2 depends on T1, so the progress output shows "after T1".
function specFor(id: string, title: string, deps: string[], write: string, create: string, verify: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "class: feature",
    `depends_on: [${deps.join(", ")}]`,
    "read:",
    "  - contracts/types.ts",
    "write:",
    `  - ${write}`,
    "create:",
    `  - ${create}`,
    "protected:",
    "  - contracts/types.ts",
    "budget:",
    "  max_usd: 0.5",
    "  max_turns: 12",
    "verify:",
    `  - run: ${verify}`,
    "    timeout_s: 10",
    "---",
    "",
    "## Objective",
    "",
    `Do ${title}.`,
    "",
    "## Interface",
    "",
    "Export runFeature from contracts/types.ts.",
    "",
    "## Behavior",
    "",
    "Behaves as described.",
    "",
    "## Invariants",
    "",
    "The contract file is not modified.",
    "",
    "## Edge cases",
    "",
    "None.",
    "",
    "## Guardrails",
    "",
    "No network access.",
    "",
    "## Out of scope",
    "",
    "Nothing else.",
    "",
  ].join("\n");
}

const MANIFEST = [
  "version: 1",
  "run_id: r_CCCCCCCCCCCC",
  "goal: Add the feature helper",
  "base_ref: main",
  "ecosystem: node-ts",
  "setup:",
  "  - run: echo setup",
  "    timeout_s: 30",
  "contracts:",
  "  files:",
  "    - contracts/types.ts",
  "  typecheck:",
  "    - run: echo typecheck contracts",
  "      timeout_s: 30",
  "integration_verify:",
  "  - run: echo verify all",
  "    timeout_s: 60",
  "tasks:",
  "  - id: T1",
  "    spec: tasks/T1.md",
  "  - id: T2",
  "    spec: tasks/T2.md",
  "budget:",
  "  max_usd: 5",
  "  max_tokens: 200000",
  "  max_wall_min: 30",
  "",
].join("\n");

const PLAN_FILES = {
  "manifest.yaml": MANIFEST,
  "tasks/T1.md": specFor("T1", "Add feature helper", [], "src/feature.ts", "src/helper.ts", "grep -q runFeature src/feature.ts"),
  "tasks/T2.md": specFor("T2", "Add the other file", ["T1"], "src/other.ts", "src/other2.ts", "test -f src/other2.ts"),
  "contracts/types.ts": "export declare function runFeature(name: string): boolean;\n",
};

const SEED = {
  "src/feature.ts": "export const featureEnabled = true;\n",
  "src/other.ts": "export const other = 1;\n",
};

const WORKER_T1 = {
  edits: {
    "src/feature.ts": "export const featureEnabled = true;\nexport function runFeature(n: string) { return n.length > 0; }\n",
    "src/helper.ts": "export const helper = 1;\n",
  },
  reply: "Done T1",
};

const WORKER_T2 = {
  edits: { "src/other.ts": "export const other = 2;\n", "src/other2.ts": "export const other2 = 3;\n" },
  reply: "Done T2",
};

const RUN_ARGS = [
  "run",
  "--mode",
  "plan",
  "--permission-mode",
  "bypassPermissions",
  "Add the feature helper",
];

function textLines(res: RunSubstrateResult): string[] {
  return res.stdout.split("\n").filter((l) => l.trim() !== "");
}

function indexOfLine(lines: string[], pattern: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? "")) return i;
  }
  return -1;
}

describe("E2E progress: text mode writes the run's progress to stdout (R7.3)", () => {
  it("prints the start, planning, plan, task, verify, merge and finish lines in order", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [{ plan: { files: PLAN_FILES }, reply: "wrote the plan\nPLAN READY" }, WORKER_T1, WORKER_T2] },
      args: RUN_ARGS,
    });

    try {
      expect(res.exitCode).toBe(0);
      const lines = textLines(res);
      const steps = [
        /^\[\d\d:\d\d\] run r_\S+ started: mode plan, planner claude:claude-sonnet-5-5, worker claude:haiku$/,
        /^\[\d\d:\d\d\] routed to plan \(--mode plan\)$/,
        /^\[\d\d:\d\d\] planning with claude:claude-sonnet-5-5$/,
        /^\[\d\d:\d\d\] planner attempt 1 finished, \$\d+\.\d{4}$/,
        /^\[\d\d:\d\d\] plan ready: 2 tasks$/,
        /^\[\d\d:\d\d\]   T1  Add feature helper  \[feature\]$/,
        /^\[\d\d:\d\d\]   T2  Add the other file  \[feature\]  after T1$/,
        /^\[\d\d:\d\d\] \[task T1\] started \(gen 1, attempt 1\) on /,
        /^\[\d\d:\d\d\] \[task T1\] verify passed$/,
        /^\[\d\d:\d\d\] \[task T1\] merged, \$/,
        /^\[\d\d:\d\d\] \[task T2\] started \(gen 1, attempt 1\)/,
        /^\[\d\d:\d\d\] \[task T2\] verify passed$/,
        /^\[\d\d:\d\d\] \[task T2\] merged, \$/,
        /^\[\d\d:\d\d\] run r_\S+ finished: 2\/2 passed, \$/,
        /^--- Run Summary ---$/,
      ];
      let cursor = 0;
      for (const step of steps) {
        const at = indexOfLine(lines, step, cursor);
        expect(at, `missing or out of order: ${step}`).toBeGreaterThanOrEqual(cursor);
        cursor = at + 1;
      }
      expect(res.stdout).toMatch(/Tasks:      2 passed \/ 2 total/);
      expect(res.stdout).toMatch(/Merged:     yes/);
      expect(res.stdout).not.toMatch(/Drafts and logs:/);
    } finally {
      res.cleanup();
    }
  });

  it("prints each rejected planner attempt with its first messages, then the retry runs", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          { plan: { files: { "manifest.yaml": "goal: [unclosed bracket\n" } }, reply: "drafted the plan, please review" },
          { plan: { files: PLAN_FILES }, reply: "corrected manifest.yaml\nPLAN READY" },
          WORKER_T1,
          WORKER_T2,
        ],
      },
      args: RUN_ARGS,
    });

    try {
      expect(res.exitCode).toBe(0);
      const lines = textLines(res);
      const rejected = indexOfLine(lines, /^\[\d\d:\d\d\] plan rejected \(attempt 1\/3\): /);
      expect(rejected).toBeGreaterThanOrEqual(0);
      expect(lines[rejected]).toMatch(/finish line must be PLAN READY or NEEDS INPUT/);
      const ready = indexOfLine(lines, /^\[\d\d:\d\d\] plan ready: 2 tasks$/);
      expect(ready).toBeGreaterThan(rejected);

      const events = res.events.filter((e) => e.type === "plan.format_rejected");
      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual({
        attempt: 1,
        max_attempts: 3,
        errors: ["finish line must be PLAN READY or NEEDS INPUT", "got: drafted the plan, please review"],
      });
    } finally {
      res.cleanup();
    }
  });

  it("writes heartbeat lines while the run is quiet when the interval is set low", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: { calls: [{ plan: { files: PLAN_FILES }, reply: "wrote the plan\nPLAN READY" }, WORKER_T1, WORKER_T2] },
      args: RUN_ARGS,
      env: { SUBSTRATE_HEARTBEAT_MS: "1" },
    });

    try {
      expect(res.exitCode).toBe(0);
      const beats = textLines(res).filter((l) => /^\[\d\d:\d\d\] still working: /.test(l));
      expect(beats.length).toBeGreaterThan(0);
      expect(beats[0]).toMatch(/\((\d+)s, \$\d+\.\d{4}\)$/);
      // The run still finishes with its summary after the heartbeats.
      expect(res.stdout).toMatch(/--- Run Summary ---/);
    } finally {
      res.cleanup();
    }
  });
});

describe("E2E progress: stream-json carries planning events and heartbeats (R7.3)", () => {
  it("streams the planning events, the rejected attempt, and heartbeat objects, then the result", () => {
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          { plan: { files: { "manifest.yaml": "goal: [unclosed bracket\n" } }, reply: "drafted the plan" },
          { plan: { files: PLAN_FILES }, reply: "PLAN READY" },
          WORKER_T1,
          WORKER_T2,
        ],
      },
      args: [...RUN_ARGS, "--output-format", "stream-json"],
      env: { SUBSTRATE_HEARTBEAT_MS: "1" },
    });

    try {
      expect(res.exitCode).toBe(0);
      const parsed = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
      const types = parsed.map((p) => p.type);
      expect(types).toContain("run.routed");
      expect(types).toContain("plan.started");
      expect(types).toContain("plan.format_rejected");
      expect(types).toContain("plan.produced");
      expect(types.indexOf("plan.started")).toBeLessThan(types.indexOf("plan.format_rejected"));
      expect(types.indexOf("plan.format_rejected")).toBeLessThan(types.indexOf("plan.produced"));

      const beats = parsed.filter((p) => p.type === "heartbeat");
      expect(beats.length).toBeGreaterThan(0);
      for (const beat of beats) {
        expect(typeof beat.elapsed_s).toBe("number");
        expect(typeof beat.phase).toBe("string");
        expect(typeof beat.cost_usd).toBe("number");
        expect(typeof beat.run_id).toBe("string");
      }

      const last = parsed[parsed.length - 1];
      expect(last.type).toBe("result");
      expect(last.subtype).toBe("success");
    } finally {
      res.cleanup();
    }
  });
});
