import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// docs/design/web-ui.md, sections 6.3 and 6.4: a run leaves what the web UI reads from disk. Every harness session
// has a transcript (a header line, then {ts, event} lines); a merged task keeps its patch; the planner session id
// is in the event log. Built CLI and fake harnesses, scratch git repos.

const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "contracts/types.ts": CONTRACT_STUB };

interface TranscriptFile {
  file: string;
  header: any;
  lines: any[];
}

function transcriptsOf(res: RunSubstrateResult): TranscriptFile[] {
  const dir = join(res.runDir ?? "", "transcripts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const lines = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      return { file: f, header: lines[0], lines: lines.slice(1) };
    });
}

function eventsOf(res: RunSubstrateResult, type: string): Array<{ type: string; data: any }> {
  return res.events.filter((e) => e.type === type).map((e) => ({ type: e.type, data: e.data as any }));
}

function diagnostics(res: RunSubstrateResult): string {
  return `exit ${res.exitCode}\nstdout: ${res.stdout.slice(-1500)}\nstderr: ${res.stderr.slice(-800)}`;
}

describe("web UI recording: transcripts, merged patches and the planner session", () => {
  it("a normal two-task run leaves a transcript for the planner and each worker, merged patches and the planner session id", () => {
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Record", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          { task: "T1", edits: { "src/a.txt": "seed a\nt1-done\n" }, reply: "DONE" },
          { task: "T2", edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" },
        ],
      },
      args: [...RUN_ARGS, "Record case"],
    });
    try {
      expect(res.exitCode, diagnostics(res)).toBe(0);

      const transcripts = transcriptsOf(res);
      const planner = transcripts.find((t) => t.header.role === "planner");
      expect(planner, diagnostics(res)).toBeDefined();
      expect(planner!.header).toMatchObject({ type: "header", task_id: null, generation: null });
      expect(planner!.lines.length).toBeGreaterThan(0);
      for (const task of ["T1", "T2"]) {
        const worker = transcripts.find((t) => t.header.role === "worker" && t.header.task_id === task);
        expect(worker, `${task} transcript: ${diagnostics(res)}`).toBeDefined();
        expect(worker!.header).toMatchObject({ generation: 1, attempt: 1 });
        expect(worker!.lines.length).toBeGreaterThan(0);
      }

      const runDir = res.runDir ?? "";
      for (const task of ["T1", "T2"]) {
        const patch = join(runDir, "packets", "merged", `${task}-g1.patch`);
        expect(existsSync(patch), `${task} merged patch`).toBe(true);
        expect(statSync(patch).size).toBeGreaterThan(0);
      }
      expect(existsSync(join(runDir, "packets", "verify", "T1-g1-attempt1-0.out"))).toBe(true);

      const produced = eventsOf(res, "plan.produced")[0];
      expect(produced.data.planner_session_id).toBe(planner!.header.session);
    } finally {
      res.cleanup();
    }
  });

  it("a failed task still leaves its worker transcript", () => {
    // T1's verify can never pass (its worker writes nothing), so its two attempts fail and the replan ladder gives up.
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const res = runSubstrate({
      files: SEED,
      scenario: {
        calls: [
          planCall(contractFiles(manifestFor("Failing", ["T1", "T2"]), { "tasks/T1.md": t1, "tasks/T2.md": t2 })),
          { task: "T1", reply: "DONE" },
          { task: "T1", reply: "DONE" },
          { task: "T2", edits: { "src/b.txt": "seed b\nt2-done\n" }, reply: "DONE" },
          ...Array.from({ length: 12 }, () => ({ reply: "DONE" })),
        ],
      },
      args: [...RUN_ARGS, "Failing case"],
    });
    try {
      const failed = eventsOf(res, "task.failed").find((e) => e.data.task_id === "T1");
      expect(failed, diagnostics(res)).toBeDefined();

      const worker = transcriptsOf(res).find((t) => t.header.role === "worker" && t.header.task_id === "T1" && t.header.attempt === 1);
      expect(worker, `T1 transcript: ${diagnostics(res)}`).toBeDefined();
      expect(worker!.lines.length).toBeGreaterThan(0);
    } finally {
      res.cleanup();
    }
  });
});
