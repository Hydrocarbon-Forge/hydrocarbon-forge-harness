import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  choosePort,
  readUiPort,
  uiPidStateOf,
  writeUiPidRecord,
  writeUiPort,
} from "../../../src/store/ui-state.js";
import { renderUnit, runAll, systemdWord, uiUnitFileOf } from "../../../src/util/systemd-unit.js";
import { enableCommandsOf } from "../../../src/cli/systemctl.js";

// web-ui design, 8.2 to 8.4: the pure parts of the always-on service. The port order and its persistence, the pid
// file's staleness (the identity check never signals a recycled pid), the systemd unit text, and the runner the
// service commands go through (a fake here, so no test runs systemctl).

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-ui-unit-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("8.4: the systemd user unit", () => {
  it("names the absolute node and bundled entry, serves ui, restarts on failure and carries the install-time PATH", () => {
    const unit = renderUnit({
      execPath: "/usr/bin/node",
      entry: "/opt/substrate/dist/substrate.mjs",
      path: "/home/me/.local/bin:/usr/bin:/bin",
    });
    expect(unit).toContain("Description=Substrate web UI\n");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/substrate/dist/substrate.mjs ui serve\n");
    expect(unit).toContain("Environment=PATH=/home/me/.local/bin:/usr/bin:/bin\n");
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("RestartSec=2\n");
    expect(unit).toContain("WantedBy=default.target\n");
    expect(unit).toMatch(/^ExecStart=\//m);
  });

  it("quotes a PATH with spaces, escapes systemd specifiers, and carries the state and config directories", () => {
    const unit = renderUnit({
      execPath: "/usr/bin/node",
      entry: "/opt/a b/dist/substrate.mjs",
      path: "/x y:/bin",
      env: { XDG_STATE_HOME: "/state" },
    });
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/a b/dist/substrate.mjs" ui serve\n');
    expect(unit).toContain('Environment="PATH=/x y:/bin"\n');
    expect(unit).toContain("Environment=XDG_STATE_HOME=/state\n");
    expect(systemdWord("50%")).toBe('"50%%"');
    expect(systemdWord("$HOME")).toBe('"$$HOME"');
  });

  it("puts the unit under XDG_CONFIG_HOME when it is set", () => {
    expect(uiUnitFileOf({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/systemd/user/substrate-ui.service");
  });

  it("enables with a daemon-reload first, and a runner that fails stops the sequence", () => {
    const commands = enableCommandsOf();
    expect(commands.map(([, args]) => args.join(" "))).toEqual([
      "--user daemon-reload",
      "--user enable --now substrate-ui.service",
    ]);
    const seen: string[] = [];
    const status = runAll(commands, (command, args) => {
      seen.push([command, ...args].join(" "));
      return 1;
    });
    expect(status).toBe(1);
    expect(seen).toHaveLength(1);
  });
});

describe("8.2: the port is the flag, then the stored port, then a new one from the system", () => {
  it("prefers the flag, then the stored port, and asks the system only when neither is set", () => {
    expect(choosePort(4001, 4002)).toEqual({ port: 4001, source: "flag" });
    expect(choosePort(undefined, 4002)).toEqual({ port: 4002, source: "config" });
    expect(choosePort(undefined, undefined)).toEqual({ port: 0, source: "new" });
  });

  it("persists the port in ui.json and reads it back; a missing file reads as none; a bad file is refused", () => {
    const dir = tempDir();
    const file = join(dir, "ui.json");
    expect(readUiPort(file)).toBeUndefined();
    writeUiPort(file, 4321, new Date("2026-10-22T00:00:00Z"));
    expect(readUiPort(file)).toBe(4321);
    writeFileSync(file, JSON.stringify({ version: 1, port: 99999 }));
    expect(() => readUiPort(file)).toThrow(/does not name a port/);
    writeFileSync(file, "not json");
    expect(() => readUiPort(file)).toThrow(/not valid JSON/);
  });
});

describe("8.3: the pid file is trusted only while its process is a ui serve", () => {
  it("is none without a file, stale when the process is gone or is not a ui serve, and live only for a ui serve", () => {
    const dir = tempDir();
    const file = join(dir, "ui.pid");
    expect(uiPidStateOf(file).state).toBe("none");

    writeUiPidRecord(file, { pid: 4242, url: "http://localhost:1", started_at: "2026-10-22T00:00:00Z", node: "/usr/bin/node" });
    expect(uiPidStateOf(file, () => ({ alive: false, args: "" })).state).toBe("stale");
    // A recycled pid: alive, but its command line does not name a Substrate ui serve. It is never signalled.
    expect(uiPidStateOf(file, () => ({ alive: true, args: "sleep 100" })).state).toBe("stale");
    expect(uiPidStateOf(file, () => ({ alive: true, args: "node dist/substrate.mjs run" })).state).toBe("stale");
    const live = uiPidStateOf(file, () => ({ alive: true, args: "/usr/bin/node /opt/dist/substrate.mjs ui serve" }));
    expect(live.state).toBe("live");
    expect(existsSync(file)).toBe(true);
  });
});
