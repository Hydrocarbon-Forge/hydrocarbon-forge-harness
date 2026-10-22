import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { runSubstrate, type RunSubstrateResult } from "./helpers/run-substrate.js";
import { CONTRACT_STUB, contractFiles, manifestFor, planCall, taskSpec } from "./helpers/plan-scenario.js";

// Chat with the planner (docs/design/web-ui.md, 7). A chat message on a failed run gets the planner's reply, and an
// amendment the planner writes is queued for the engine: the resume applies it. A question changes nothing. A
// finished run answers in text and refuses an amendment. The planner is the fake harness: each test puts it first on
// PATH and scripts its calls, so no live harness runs.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const fakeBin = resolve(projectRoot, "test/fixtures/fake-harness/bin");
const RUN_ARGS = ["run", "--permission-mode", "bypassPermissions"];
const SEED = { "src/a.txt": "seed a\n", "src/b.txt": "seed b\n", "src/c.txt": "seed c\n", "contracts/types.ts": CONTRACT_STUB };

interface Ui {
  url: string;
  stop(): Promise<void>;
}
interface ChatMsg {
  id: string;
  role: string;
  status: string;
  reply_to: string | null;
  text: string;
  amendment: { outcome: string; added: string[] } | null;
}

const children: ChildProcess[] = [];
const temps: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** The fake planner's scenario file for the chat turns: its calls are taken in order by each turn. */
function scenarioOf(calls: unknown[]): string {
  const file = join(tempDir("substrate-chat-scenario-"), "scenario.json");
  writeFileSync(file, JSON.stringify({ calls }), "utf8");
  return file;
}

/** The environment of the UI server and of the CLI runs: the fake harness first on PATH, one state dir for both. */
function envOf(xdg: string, scenario?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    XDG_STATE_HOME: xdg,
    ...(scenario !== undefined ? { FAKE_SCENARIO_FILE: scenario } : {}),
  };
}

/** Starts `ui serve` on an OS-chosen port and resolves with its URL (its first stdout line). */
function startUi(env: NodeJS.ProcessEnv): Promise<Ui> {
  const child = spawn(process.execPath, [substrateMjs, "ui", "serve", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return new Promise((resolvePromise, reject) => {
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const newline = out.indexOf("\n");
      if (newline < 0) return;
      resolvePromise({
        url: out.slice(0, newline).trim(),
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            child.once("exit", () => done());
            child.kill("SIGINT");
          }),
      });
    });
    child.once("exit", (code) => reject(new Error(`ui serve exited with ${code} before it printed its URL`)));
  });
}

/** The run ref: the project id (first 12 hex characters of sha256 over the realpath) and the run id. */
function refOf(projectPath: string, runId: string): string {
  return `${createHash("sha256").update(realpathSync(projectPath)).digest("hex").slice(0, 12)}~${runId}`;
}

async function sendChat(url: string, ref: string, message: string): Promise<Response> {
  return fetch(`${url}/api/runs/${encodeURIComponent(ref)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Substrate-UI": "1" },
    body: JSON.stringify({ message }),
  });
}

async function chatOf(url: string, ref: string): Promise<ChatMsg[]> {
  return (await fetch(`${url}/api/runs/${encodeURIComponent(ref)}/chat`)).json() as Promise<ChatMsg[]>;
}

/** Polls the run's chat until the predicate holds: a reply comes from a detached turn, so it takes a few seconds. */
async function waitForChat(url: string, ref: string, ready: (chat: ChatMsg[]) => boolean): Promise<ChatMsg[]> {
  const deadline = Date.now() + 90000;
  for (;;) {
    const chat = await chatOf(url, ref);
    if (ready(chat)) return chat;
    if (Date.now() > deadline) throw new Error(`chat did not reach the expected state: ${JSON.stringify(chat)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function eventsIn(runDir: string): { type: string; data: any }[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** The inbox messages of the run, by kind, in number order. */
function inboxKindsOf(runDir: string): string[] {
  const dir = join(runDir, "inbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
    .map((name) => (JSON.parse(readFileSync(join(dir, name), "utf8")) as { kind: string }).kind);
}

/** Runs the built CLI in the repository for `resume`, with the fake harness scripted for that call only. */
function cliResume(repoDir: string, runId: string, xdg: string, calls: unknown[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(process.execPath, [substrateMjs, "resume", runId], {
    cwd: repoDir,
    encoding: "utf8",
    env: envOf(xdg, scenarioOf(calls)),
    timeout: 120000,
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

const edit = (task: string, file: string, marker: string) => ({
  task,
  edits: { [file]: `seed ${file.slice(-5, -4)}\n${marker}\n` },
  reply: `${task} done\nDONE`,
});

/** T1 passes; T2 fails on each of its scripted calls; T3 depends on T2 and is skipped. */
function threeTaskFailure(xdg: string): RunSubstrateResult {
  const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
  const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
  const t3 = taskSpec({ id: "T3", write: ["src/c.txt"], dependsOn: ["T2"], verify: "grep -q t3-done src/c.txt" });
  return runSubstrate({
    files: SEED,
    env: { XDG_STATE_HOME: xdg },
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

describe("E2E planner chat (ui chat, web-ui design section 7)", () => {
  it("queues the planner's amendment for a failed run, and the resume applies it: the added task runs", async () => {
    const xdg = tempDir("substrate-chat-xdg-");
    const res = threeTaskFailure(xdg);
    let ui: Ui | undefined;
    try {
      expect(res.exitCode).toBe(1);
      const runDir = res.runDir as string;
      const runId = basename(runDir);
      const ref = refOf(res.repoDir, runId);
      const t1 = readFileSync(join(runDir, "tasks", "T1.md"), "utf8");
      const t2 = readFileSync(join(runDir, "tasks", "T2.md"), "utf8");
      const t3 = readFileSync(join(runDir, "tasks", "T3.md"), "utf8");
      const t4 = taskSpec({ id: "T4", dependsOn: ["T1"], write: ["src/d.txt"], verify: "grep -q t4-done src/d.txt" });

      // The planner's chat turn writes the whole amendment under amendments/c1/ and answers in text.
      const chatScenario = scenarioOf([
        {
          plan: {
            files: {
              "amendments/c1/manifest.yaml": manifestFor("Three and four", ["T1", "T2", "T3", "T4"]),
              "amendments/c1/tasks/T1.md": t1,
              "amendments/c1/tasks/T2.md": t2,
              "amendments/c1/tasks/T3.md": t3,
              "amendments/c1/tasks/T4.md": t4,
              "amendments/c1/contracts/types.ts": CONTRACT_STUB,
            },
          },
          reply: "I will add T4 after T1. T1 has started, so it stays as it is.",
        },
      ]);
      ui = await startUi(envOf(xdg, chatScenario));
      const sent = await sendChat(ui.url, ref, "Add a task T4 after T1 that writes src/d.txt.");
      expect(sent.status).toBe(202);
      expect(((await sent.json()) as { message: ChatMsg }).message).toMatchObject({ id: "c1", role: "user", status: "queued" });

      const chat = await waitForChat(ui.url, ref, (m) => m.some((x) => x.role === "system" && x.text.startsWith("Amendment ready:")));
      expect(chat.find((x) => x.id === "c1")?.status).toBe("answered");
      expect(chat.find((x) => x.role === "planner")).toMatchObject({ status: "answered", reply_to: "c1", amendment: { outcome: "pending", added: ["T4"] } });
      const note = chat.find((x) => x.role === "system")?.text ?? "";
      expect(note).toContain("added T4");
      expect(note).toContain("kept, already started and not changed: T1");
      expect(note).toContain("Resume the job to apply it.");
      // The chat message is the engine's first inbox entry; the amendment follows it.
      expect(inboxKindsOf(runDir)).toEqual(["chat", "amendment"]);

      await ui.stop();
      ui = undefined;

      const out = cliResume(res.repoDir, runId, xdg, [
        edit("T2", "src/b.txt", "t2-done"),
        edit("T3", "src/c.txt", "t3-done"),
        edit("T4", "src/d.txt", "t4-done"),
      ]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("finished: 4/4 passed");
      const amended = eventsIn(runDir).filter((e) => e.type === "run.amended").at(-1);
      expect(amended?.data).toMatchObject({ chat_id: "c1", outcome: "applied", applied_at: "resume", added: ["T4"], kept_started: ["T1"] });
      expect(readFileSync(join(res.repoDir, "src/d.txt"), "utf8")).toContain("t4-done");
    } finally {
      await ui?.stop();
      res.cleanup();
    }
  }, 300000);

  it("answers a question on a failed run with text only: nothing is queued and the journal's changes are the turn's usage", async () => {
    const xdg = tempDir("substrate-chat-xdg-");
    const res = threeTaskFailure(xdg);
    let ui: Ui | undefined;
    try {
      const runDir = res.runDir as string;
      const ref = refOf(res.repoDir, basename(runDir));
      const before = eventsIn(runDir).filter((e) => e.type !== "usage.recorded").length;

      ui = await startUi(envOf(xdg, scenarioOf([{ reply: "T2 failed: its verify command did not find t2-done in src/b.txt." }])));
      expect((await sendChat(ui.url, ref, "Why did T2 fail?")).status).toBe(202);

      const chat = await waitForChat(ui.url, ref, (m) => m.some((x) => x.role === "planner" && x.reply_to === "c1"));
      expect(chat.map((m) => `${m.role}:${m.status}`)).toEqual(["user:answered", "planner:answered"]);
      expect(chat.find((m) => m.role === "planner")?.text).toContain("t2-done");
      expect(chat.find((m) => m.role === "planner")?.amendment).toBeNull();

      // No amendment directory, no amendment in the inbox, and no engine event but the turn's cost.
      expect(existsSync(join(runDir, "amendments"))).toBe(false);
      expect(inboxKindsOf(runDir)).toEqual(["chat"]);
      const after = eventsIn(runDir);
      expect(after.filter((e) => e.type !== "usage.recorded").length).toBe(before);
      expect(after.some((e) => e.type === "usage.recorded" && e.data.role === "planner_chat")).toBe(true);
    } finally {
      await ui?.stop();
      res.cleanup();
    }
  }, 300000);

  it("answers on a finished run in text and reports that it cannot amend, even when the planner writes an amendment", async () => {
    const xdg = tempDir("substrate-chat-xdg-");
    const t1 = taskSpec({ id: "T1", write: ["src/a.txt"], verify: "grep -q t1-done src/a.txt" });
    const t2 = taskSpec({ id: "T2", write: ["src/b.txt"], verify: "grep -q t2-done src/b.txt" });
    const res = runSubstrate({
      files: SEED,
      env: { XDG_STATE_HOME: xdg },
      scenario: {
        calls: [planCall(contractFiles(manifestFor("One", ["T1"]), { "tasks/T1.md": t1 })), edit("T1", "src/a.txt", "t1-done")],
      },
      args: [...RUN_ARGS, "One task"],
    });
    let ui: Ui | undefined;
    try {
      expect(res.exitCode).toBe(0);
      const runDir = res.runDir as string;
      const ref = refOf(res.repoDir, basename(runDir));

      ui = await startUi(
        envOf(
          xdg,
          scenarioOf([
            {
              plan: {
                files: {
                  "amendments/c1/manifest.yaml": manifestFor("One and two", ["T1", "T2"]),
                  "amendments/c1/tasks/T1.md": t1,
                  "amendments/c1/tasks/T2.md": t2,
                  "amendments/c1/contracts/types.ts": CONTRACT_STUB,
                },
              },
              reply: "A second task is possible, but this job is finished.",
            },
          ]),
        ),
      );
      expect((await sendChat(ui.url, ref, "Add a task T2 that writes src/b.txt.")).status).toBe(202);

      const chat = await waitForChat(ui.url, ref, (m) => m.some((x) => x.role === "system" && x.status === "refused"));
      expect(chat.find((m) => m.role === "planner")).toMatchObject({ status: "answered", reply_to: "c1" });
      const note = chat.find((m) => m.role === "system");
      expect(note?.text).toContain("finished");
      expect(note?.text).toContain("cannot be amended");
      expect(inboxKindsOf(runDir)).toEqual(["chat"]);
      expect(eventsIn(runDir).some((e) => e.type === "run.amended")).toBe(false);
    } finally {
      await ui?.stop();
      res.cleanup();
    }
  }, 300000);
});
