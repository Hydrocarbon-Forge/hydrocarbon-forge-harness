import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// web-ui design, 8.1 to 8.4: the background UI service through the built CLI. Every state, config and unit directory
// is a temp dir, and the fake harnesses come first on PATH. systemctl is never run here: install-service without
// --enable only writes the unit file.

const projectRoot = resolve(__dirname, "../..");
const substrateMjs = resolve(projectRoot, "dist/substrate.mjs");
const fakeBin = resolve(projectRoot, "test/fixtures/fake-harness/bin");

const roots: string[] = [];
const started: NodeJS.ProcessEnv[] = [];

function isolatedEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "substrate-ui-e2e-"));
  roots.push(root);
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SUBSTRATE_")));
  return {
    ...base,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    SUBSTRATE_CONFIG_DIR: join(root, "config", "substrate"),
  };
}

function runUi(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [substrateMjs, "ui", ...args], {
    env,
    cwd: roots[0],
    encoding: "utf8",
    timeout: 60000,
  });
}

afterAll(() => {
  // Stop anything a failed case left running, then remove the temp dirs.
  for (const env of started) runUi(env, ["stop", "--force"]);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("8.1 to 8.3: the background UI starts, reports, stops and keeps its port", () => {
  it("start, status (json), start again (idempotent), stop, then start again on the same port", () => {
    const env = isolatedEnv();
    started.push(env);

    const first = runUi(env, ["start"]);
    expect(first.status).toBe(0);
    const url = first.stdout.trim();
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);

    const status = runUi(env, ["status", "--output-format", "json"]);
    expect(status.status).toBe(0);
    const parsed = JSON.parse(status.stdout) as { running: boolean; url: string; pid: number };
    expect(parsed.running).toBe(true);
    expect(parsed.url).toBe(url);
    expect(typeof parsed.pid).toBe("number");

    const again = runUi(env, ["start"]);
    expect(again.status).toBe(0);
    expect(again.stdout.trim()).toBe(url);

    expect(runUi(env, ["stop"]).status).toBe(0);
    expect(runUi(env, ["status"]).stdout).toContain("stopped");

    const restarted = runUi(env, ["start"]);
    expect(restarted.status).toBe(0);
    expect(restarted.stdout.trim()).toBe(url);
    expect(runUi(env, ["stop"]).status).toBe(0);
  }, 120000);
});

describe("8.4: install-service writes the unit without touching systemctl", () => {
  it("writes a user unit with the absolute entry and the install-time PATH, and prints the enable commands", () => {
    const env = isolatedEnv();
    const res = runUi(env, ["install-service"]);
    expect(res.status).toBe(0);

    const unit = readFileSync(join(env.XDG_CONFIG_HOME as string, "systemd", "user", "substrate-ui.service"), "utf8");
    expect(unit).toContain(`ExecStart=${process.execPath} ${realpathSync(substrateMjs)} ui serve\n`);
    expect(unit).toMatch(/^ExecStart=\//m);
    expect(unit).toContain(`Environment=PATH=${env.PATH}\n`);
    expect(unit).toContain("Restart=on-failure\n");
    expect(res.stdout).toContain("systemctl --user enable --now substrate-ui.service");
    expect(res.stdout).toContain("loginctl enable-linger");
  });
});

describe("8.1: status with nothing running", () => {
  it("exits 0 and reports stopped", () => {
    const env = isolatedEnv();
    const res = runUi(env, ["status"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("stopped");
  });
});
