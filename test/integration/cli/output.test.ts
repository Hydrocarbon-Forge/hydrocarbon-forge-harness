import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import { join } from "node:path";

import type * as Contracts from "../../../src/contracts/index.js";
import type { EngineEvent, RunSummary, RunOptions } from "../../../src/contracts/index.js";
import { createRunId } from "../../../src/util/index.js";
import { createFormatter } from "../../../src/cli/output.js";
import { streamTypeFor, STREAM_TYPE } from "../../../src/cli/stream-map.js";
import { EVENT_TYPES } from "../../../src/contracts/events.js";
import {
  setupScenarioEnv,
  fakeClaudeAdapter,
  loadEngine,
  writePlanFiles,
  readEventLog,
  type ScenarioEnv,
} from "../scenarios/helpers.js";
import {
  sampleValidManifest,
  sampleValidTaskSpecMarkdown,
  sampleValidContractStub,
} from "../roles/fixtures.js";

function createMockStream(): NodeJS.WriteStream & {
  getOutput: () => string;
  getLines: () => string[];
} {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as any;
  stream.isTTY = false;
  stream.getOutput = () => output;
  stream.getLines = () => output.trim().split("\n").filter((l) => l.trim().length > 0);
  return stream;
}

// Real two-task engine run against a temp repo; the engine writes every
// catalog event into events.jsonl and streams them to onEvent.
describe("cli: output formatters driven by real engine runs", () => {
  let env: ScenarioEnv;
  let fakeClaude: ReturnType<typeof fakeClaudeAdapter> | undefined;
  let engine: Contracts.Engine;

  beforeEach(async () => {
    fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      {
        // Tagged by task: two workers run at once, and an untagged call would go to whichever starts first.
        task: "T1",
        edits: {
          "src/t1.ts": "export const t1 = 1;\n",
          "test/t1.test.ts": "export const testT1 = true;\n",
        },
        reply: "Done T1",
      },
      {
        task: "T2",
        edits: {
          "src/t2.ts": "export const t2 = 2;\n",
          "test/t2.test.ts": "export const testT2 = true;\n",
        },
        reply: "Done T2",
      },
    ]);
    env = await setupScenarioEnv("cli-output", { adapter: fakeClaude.adapter });
    env.testRepo.commitFile("src/feature.ts", "// existing file declared as write\n");
    env.testRepo.commitFile("src/t1.ts", "// existing file declared as write\n");
    env.testRepo.commitFile("src/t2.ts", "// existing file declared as write\n");

    const engineMod = await loadEngine();
    engine = engineMod.createEngine({
      settings: env.settings,
      adapter: env.adapter,
    });
  });

  afterEach(async () => {
    await env.cleanup();
    fakeClaude?.cleanup();
  });

  function planTwoTasks() {
    const runId = createRunId();
    const manifest: Contracts.Manifest = {
      ...sampleValidManifest(runId),
      tasks: [
        { id: "T1", spec: "tasks/T1.md" },
        { id: "T2", spec: "tasks/T2.md" },
      ],
      integration_verify: [
        { run: "echo integration verify passed", timeout_s: 30 },
      ],
    };
    const specs: Record<string, string> = {
      "tasks/T1.md": sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T1",
          title: "Task 1",
          depends_on: [],
          write: ["src/t1.ts"],
          create: ["test/t1.test.ts"],
          verify: [{ run: "echo verify T1", timeout_s: 30 }],
        },
      }),
      "tasks/T2.md": sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T2",
          title: "Task 2",
          depends_on: [],
          write: ["src/t2.ts"],
          create: ["test/t2.test.ts"],
          verify: [{ run: "echo verify T2", timeout_s: 30 }],
        },
      }),
    };
    writePlanFiles(env.repoRoot, runId, manifest, specs, { "contracts/types.ts": sampleValidContractStub() });
    return runId;
  }

  async function runTwoTasks(
    formatter: ReturnType<typeof createFormatter>
  ): Promise<{ summary: RunSummary; runId: string }> {
    const runId = planTwoTasks();
    const opts: RunOptions = {
      prompt: "Implement tasks T1 and T2",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "bypassPermissions",
      onEvent: (event: EngineEvent) => formatter.onEvent(event),
    };
    const summary = await engine.run(opts);
    formatter.onSummary(summary, "sess_output_test");
    await formatter.flush();
    return { summary, runId };
  }

  // Behavior 1: text progress goes to stdout, in order with the summary, one prefixed line
  // per tracked event. Stderr stays empty for a run with no warnings.
  it("text progress prints the tracked event lines on stdout, in order, and nothing on stderr", async () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const formatter = createFormatter("text", stdout, stderr);

    const { summary } = await runTwoTasks(formatter);

    const out = stdout.getOutput();
    expect(out).toMatch(/\[\d\d:\d\d\] run r_\S+ started: mode plan/);
    expect(out).toMatch(/\[\d\d:\d\d\] routed to plan/);
    expect(out).toMatch(/\[\d\d:\d\d\] planning/);
    expect(out).toMatch(/\[\d\d:\d\d\] \[task T1\] started \(gen 1, attempt 1\)/);
    expect(out).toMatch(/\[\d\d:\d\d\] \[task T2\] started \(gen 1, attempt 1\)/);
    expect(out).toMatch(/\[task T1\] verify passed/);
    expect(out).toMatch(/\[task T2\] verify passed/);
    expect(out).toMatch(/\[task T1\] merged, \$/);
    expect(out).toMatch(/\[task T2\] merged, \$/);
    // No failures in this run: no failed lines.
    expect(out).not.toMatch(/\] failed:/);
    expect(out.indexOf("[task T1] started")).toBeLessThan(out.indexOf("[task T1] merged"));
    expect(out.indexOf("[task T2] started")).toBeLessThan(out.indexOf("[task T2] merged"));
    expect(out.indexOf("[task T1] merged")).toBeLessThan(out.indexOf("--- Run Summary ---"));
    expect(out).toMatch(new RegExp(`\\[\\d\\d:\\d\\d\\] run ${summary.run_id} finished: 2/2 passed`));

    expect(stderr.getOutput()).toBe("");

    const log = readEventLog(env.runDir, summary.run_id);
    const eventTypes = log.map((e) => e.type);
    expect(eventTypes).not.toContain("task.failed");
    expect(eventTypes).not.toContain("run.paused");
    expect(out).toContain("--- Run Summary ---");
    // The two tasks run at once, so which one starts first is not fixed. The text lines follow the journal's
    // order, which is the guarantee: the started lines, in stdout, name the tasks in the order the log started them.
    const startedInLog = log.filter((e) => e.type === "task.session.started").map((e) => (e.data as { task_id: string }).task_id);
    const startedInOut = [...out.matchAll(/\[task (T\d+)\] started/g)].map((m) => m[1]);
    expect(startedInOut).toEqual(startedInLog);
    expect([...startedInLog].sort()).toEqual(["T1", "T2"]);
  });

  // Behavior 2: text summary counts a task passed when its state is PASSED
  // or MERGED; the total is the number of tasks in the summary.
  it("text summary counts PASSED or MERGED tasks as passed", async () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const formatter = createFormatter("text", stdout, stderr);

    const { summary } = await runTwoTasks(formatter);

    const passedStates = Object.values(summary.tasks).filter(
      (t) => t.state === "PASSED" || t.state === "MERGED"
    ).length;
    const out = stdout.getOutput();
    expect(out).toContain(`Tasks:      ${passedStates} passed / 2 total`);
    expect(passedStates).toBe(2);
    expect(out).toContain("--- Run Summary ---");
    expect(out).toMatch(/finished/i);
  });

  // Behavior 3: JSON mode writes exactly one JSON object to stdout.
  it("json mode writes exactly one JSON object with the run summary", async () => {
    const stdout = createMockStream();
    const formatter = createFormatter("json", stdout);

    const { summary } = await runTwoTasks(formatter);

    const lines = stdout.getOutput().trim().split("\n");
    // One object: it must parse as a whole (pretty-printed across lines).
    const parsed = JSON.parse(stdout.getOutput());
    expect(parsed.run_id).toBe(summary.run_id);
    expect(parsed.session_id).toBe("sess_output_test");
    expect(parsed.status).toBe("finished");
    expect(parsed.events.length).toBeGreaterThan(0);
    void lines;
  });

  it("json mode renders errors as one error object on stdout", async () => {
    const stdout = createMockStream();
    const formatter = createFormatter("json", stdout);

    formatter.onError(new Error("engine exploded"));
    await formatter.flush();

    const parsed = JSON.parse(stdout.getOutput().trim());
    expect(parsed).toEqual({ error: "engine exploded" });
  });

  // Behavior 4: stream-json writes NDJSON only, mapped through the table,
  // and ends with the result object.
  it("stream-json streams NDJSON event lines mapped by the table and ends with the result object", async () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const formatter = createFormatter("stream-json", stdout, stderr);

    const { summary } = await runTwoTasks(formatter);

    const lines = stdout.getOutput().trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const parsed = lines.map((l) => JSON.parse(l));

    // Engine events stream with mapped names and envelope fields.
    const eventLines = parsed.filter((p) => p.type !== "result");
    expect(eventLines.length).toBeGreaterThan(0);
    for (const p of eventLines) {
      expect(p).toHaveProperty("run_id");
      expect(p).toHaveProperty("seq");
      expect(p).toHaveProperty("ts");
      expect(p.type).not.toBe("usage.recorded");
      if (p.type === "usage") {
        expect(p.record).toBeDefined();
      }
      // The mapped name never leaks an unmapped member name.
      expect(p.type).not.toBe("unknown");
    }

    const last = parsed[parsed.length - 1];
    expect(last.type).toBe("result");
    expect(last.subtype).toBe("success");
    expect(last.is_error).toBe(false);
    expect(last.run_id).toBe(summary.run_id);
    expect(last.num_tasks).toBe(2);
    expect(typeof last.duration_ms).toBe("number");

    // Nothing else goes to stdout. stderr holds one line in stream-json mode: the R10.2 announcement.
    expect(stderr.getOutput()).toBe(`run ${summary.run_id} started; follow it with: substrate watch ${summary.run_id}\n`);
  });

  // Edge case: run.paused streams with its reason field, mapped unchanged.
  it("stream-json includes run.paused with its reason field", async () => {
    fakeClaude?.cleanup();
    fakeClaude = fakeClaudeAdapter([
      { reply: "PLAN READY" },
      { failure: "permission_denial", reply: "Denied by policy" },
    ]);
    const engineMod = await loadEngine();
    engine = engineMod.createEngine({
      settings: env.settings,
      adapter: fakeClaude.adapter,
    });

    const stdout = createMockStream();
    const stderr = createMockStream();
    const formatter = createFormatter("stream-json", stdout, stderr);

    const runId = createRunId();
    const manifest: Contracts.Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
    };
    writePlanFiles(env.repoRoot, runId, manifest, {
      "tasks/T1.md": sampleValidTaskSpecMarkdown({
        frontmatter: {
          id: "T1",
          title: "Permission Sensitive Task",
          depends_on: [],
          write: ["src/feature.ts"],
          verify: [{ run: "echo verify", timeout_s: 30 }],
        },
      }),
    }, { "contracts/types.ts": sampleValidContractStub() });

    const summary = await engine.run({
      prompt: "Execute task triggering tool denial",
      cwd: env.repoRoot,
      mode: "plan",
      permission_mode: "dontAsk",
      onEvent: (event: EngineEvent) => formatter.onEvent(event),
    });

    formatter.onSummary(summary, "sess_paused");
    await formatter.flush();

    const parsed = stdout.getOutput().trim().split("\n").map((l) => JSON.parse(l));
    const paused = parsed.find((p) => p.type === "run.paused");
    expect(paused).toBeDefined();
    expect(paused.reason).toBe(summary.pause_reason);
    expect(summary.status).toBe("paused");

    const last = parsed[parsed.length - 1];
    expect(last.type).toBe("result");
    expect(last.subtype).toBe("error_needs_human");
  });

  // stream-map.ts is a complete table over the catalog.
  it("STREAM_TYPE covers every catalog member and streamTypeFor maps unknown types", () => {
    for (const type of EVENT_TYPES) {
      const mapped = STREAM_TYPE[type];
      if (type === "usage.recorded") {
        expect(mapped).toBe("usage");
      } else {
        expect(mapped).toBe(type);
      }
    }
    expect(streamTypeFor("usage.recorded")).toBe("usage");
    expect(streamTypeFor("not.in.catalog")).toBe("unknown");
  });
});
