import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runSubstrate } from "./helpers/run-substrate.js";
import { createE2ERepo } from "./helpers/repo.js";

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("E2E Entry Point and Signal Tests", () => {
  it("(a) --help exits 0 and stdout contains Usage", () => {
    const res = runSubstrate({
      args: ["--help"],
    });
    try {
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Usage");
    } finally {
      res.cleanup();
    }
  });

  let savedRepo: ReturnType<typeof createE2ERepo> | null = null;
  let savedRunId: string | null = null;
  let savedScenarioPath: string | null = null;
  let savedHomeDir: string | null = null;
  let savedScenarioDir: string | null = null;

  it("(b) SIGINT: a solo run with hanging scenario exits 130 and stops cleanly", async () => {
    savedRepo = createE2ERepo({
      "src/a.txt": "one\n",
    });
    savedScenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-entry-"));
    savedHomeDir = mkdtempSync(join(tmpdir(), "substrate-home-entry-"));
    savedScenarioPath = join(savedScenarioDir, "scenario.json");

    const baseSettings = {
      backends: {
        claude: { bin: join(binDir, "claude") },
        opencode: { bin: join(binDir, "opencode") },
        agy: { bin: join(binDir, "agy") },
      },
      concurrency: {
        workers: 1,
      },
    };

    const dotSubstrate = join(savedRepo.dir, ".substrate");
    mkdirSync(dotSubstrate, { recursive: true });
    writeFileSync(
      join(dotSubstrate, "settings.json"),
      JSON.stringify(baseSettings, null, 2),
      "utf8"
    );

    writeFileSync(
      savedScenarioPath,
      JSON.stringify({ calls: [{ failure: "hang" }] }),
      "utf8"
    );

    const env = {
      ...process.env,
      HOME: savedHomeDir,
      FAKE_SCENARIO_FILE: savedScenarioPath,
    };

    const child = spawn(
      process.execPath,
      [substrateMjs, "run", "--mode", "solo", "do it"],
      {
        cwd: savedRepo.dir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let childStdout = "";
    let childStderr = "";
    child.stdout.on("data", (d) => { childStdout += d.toString(); });
    child.stderr.on("data", (d) => { childStderr += d.toString(); });

    const runsBase = join(savedRepo.dir, ".substrate", "runs");
    let runDir: string | null = null;
    const startWait = Date.now();

    while (Date.now() - startWait < 15000) {
      if (existsSync(runsBase)) {
        const entries = readdirSync(runsBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        if (entries.length > 0) {
          savedRunId = entries[0];
          runDir = join(runsBase, savedRunId);
          break;
        }
      }
      await wait(50);
    }
    expect(runDir).not.toBeNull();

    const eventsFile = join(runDir!, "events.jsonl");
    let foundStarted = false;
    while (Date.now() - startWait < 20000) {
      if (existsSync(eventsFile)) {
        const content = readFileSync(eventsFile, "utf8");
        if (content.includes('"type":"task.session.started"')) {
          foundStarted = true;
          break;
        }
      }
      await wait(50);
    }
    if (!foundStarted) {
      console.error("DEBUG childStdout:", childStdout);
      console.error("DEBUG childStderr:", childStderr);
      if (existsSync(eventsFile)) {
        console.error("DEBUG eventsFile content:", readFileSync(eventsFile, "utf8"));
      } else {
        console.error("DEBUG eventsFile does not exist!");
      }
    }
    expect(foundStarted).toBe(true);

    const pidFile = `${savedScenarioPath}.pid`;
    while (!existsSync(pidFile) && Date.now() - startWait < 25000) {
      await wait(50);
    }
    expect(existsSync(pidFile)).toBe(true);
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);

    // Send SIGINT
    child.kill("SIGINT");

    const exitCode = await new Promise<number>((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error("Timeout waiting for child to exit on SIGINT")),
        30000
      );
      child.on("exit", (code) => {
        clearTimeout(timer);
        res(code ?? -1);
      });
    });

    expect(exitCode).toBe(130);

    // Expect run.paused with data.reason user_cancel
    const eventsContent = readFileSync(eventsFile, "utf8");
    const parsedEvents = eventsContent
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

    const pausedEvt = parsedEvents.find((e) => e.type === "run.paused");
    expect(pausedEvt).toBeDefined();
    expect(pausedEvt.data.reason).toBe("user_cancel");

    // Expect child pid to be terminated (process.kill(pid, 0) throws ESRCH)
    let pidAlive = true;
    try {
      process.kill(pid, 0);
    } catch (err: any) {
      if (err.code === "ESRCH") {
        pidAlive = false;
      }
    }
    expect(pidAlive).toBe(false);

    // Expect run lock to be gone
    const lockFile = join(savedRepo.dir, ".substrate", "state", `${savedRunId}.lock`);
    expect(existsSync(lockFile)).toBe(false);
  }, 35000);

  // Expected to fail until R3.2 (C-H4)
  it("(c) resume after a cancel finishes the task", async () => {
    expect(savedRepo).not.toBeNull();
    expect(savedRunId).not.toBeNull();
    expect(savedScenarioPath).not.toBeNull();

    try {
      writeFileSync(
        savedScenarioPath!,
        JSON.stringify({
          calls: [
            { failure: "hang" },
            { edits: { "src/a.txt": "two\n" }, reply: "DONE" },
          ],
        }),
        "utf8"
      );

      const env = {
        ...process.env,
        HOME: savedHomeDir!,
        FAKE_SCENARIO_FILE: savedScenarioPath!,
      };

      const proc = spawnSync(
        process.execPath,
        [substrateMjs, "resume", savedRunId!],
        {
          cwd: savedRepo!.dir,
          env,
          encoding: "utf8",
          timeout: 30000,
        }
      );

      expect(proc.status).toBe(0);

      const runDir = join(savedRepo!.dir, ".substrate", "runs", savedRunId!);
      const eventsFile = join(runDir, "events.jsonl");
      const eventsContent = readFileSync(eventsFile, "utf8");
      const parsedEvents = eventsContent
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      const finishedEvt = [...parsedEvents]
        .reverse()
        .find((e) => e.type === "run.finished");
      expect(finishedEvt).toBeDefined();
      expect(finishedEvt.data.exit_code).toBe(0);
    } finally {
      savedRepo?.cleanup();
      try {
        if (savedScenarioDir) rmSync(savedScenarioDir, { recursive: true, force: true });
      } catch {}
      try {
        if (savedHomeDir) rmSync(savedHomeDir, { recursive: true, force: true });
      } catch {}
    }
  }, 35000);
});
