import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createE2ERepo } from "./helpers/repo.js";

// SIGINT while a harness session is hung. The planner session is the first
// session of a default `run`, so the hang lands in the plan action. Abort must
// kill that child, end the run as run.paused user_cancel, exit 130, and leave the
// run lock released.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const binDir = resolve(projectRoot, "test/fixtures/fake-harness/bin");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== "ESRCH";
  }
}

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

describe("E2E interrupt: SIGINT aborts a hung harness session", () => {
  it("planner session hung: SIGINT kills the child, exits 130 and leaves a resumable run", async () => {
    const repo = createE2ERepo({ "src/a.txt": "one\n" });
    const scenarioDir = mkdtempSync(join(tmpdir(), "substrate-scenario-interrupt-"));
    const homeDir = mkdtempSync(join(tmpdir(), "substrate-home-interrupt-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    const pidFile = `${scenarioPath}.pid`;
    let child: ChildProcess | undefined;
    let hungPid: number | undefined;

    try {
      mkdirSync(join(repo.dir, ".substrate"), { recursive: true });
      writeFileSync(
        join(repo.dir, ".substrate", "settings.json"),
        JSON.stringify(
          {
            backends: {
              claude: { bin: join(binDir, "claude") },
              opencode: { bin: join(binDir, "opencode") },
              agy: { bin: join(binDir, "agy") },
            },
            concurrency: { workers: 1 },
          },
          null,
          2
        ),
        "utf8"
      );
      writeFileSync(scenarioPath, JSON.stringify({ calls: [{ failure: "hang" }] }), "utf8");

      const stderrChunks: string[] = [];
      child = spawn(
        process.execPath,
        [substrateMjs, "run", "--plan", "claude:claude-sonnet-5-5", "--work", "claude:haiku", "--permission-mode", "bypassPermissions", "do it"],
        {
          cwd: repo.dir,
          env: { ...process.env, HOME: homeDir, FAKE_SCENARIO_FILE: scenarioPath },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      child.stderr?.on("data", (d) => stderrChunks.push(d.toString()));
      const exited = new Promise<number | null>((res) => child!.on("exit", (code) => res(code)));

      const hung = await waitUntil(() => existsSync(pidFile), 20000);
      expect(hung).toBe(true);
      hungPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      expect(Number.isFinite(hungPid)).toBe(true);
      expect(pidAlive(hungPid)).toBe(true);

      const sentAt = Date.now();
      child.kill("SIGINT");
      const code = await Promise.race([
        exited,
        sleep(10000).then(() => "timeout" as const),
      ]);
      const elapsed = Date.now() - sentAt;
      expect(code).toBe(130);
      expect(elapsed).toBeLessThan(5000);

      // The killed planner child must be gone (reaped or zombie-free).
      const gone = await waitUntil(() => !pidAlive(hungPid!), 3000);
      expect(gone).toBe(true);

      const runsBase = join(repo.dir, ".substrate", "runs");
      const runId = readdirSync(runsBase)[0];
      const events = readFileSync(join(runsBase, runId, "events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      const paused = events.filter((e) => e.type === "run.paused").at(-1);
      expect(paused?.data?.reason).toBe("user_cancel");
      expect(events.some((e) => e.type === "run.finished")).toBe(false);
      expect(existsSync(join(repo.dir, ".substrate", "state", `${runId}.lock`))).toBe(false);
      expect(stderrChunks.join("")).toContain("stopping (SIGINT)");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (hungPid !== undefined && pidAlive(hungPid)) {
        try {
          process.kill(hungPid, "SIGKILL");
        } catch {}
      }
      repo.cleanup();
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 40000);
});
