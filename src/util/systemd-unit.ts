import os from "node:os";
import path from "node:path";

// The systemd user unit for the always-on web UI (web-ui design, section 8.4). Rendering is pure: the caller passes the
// absolute paths and the PATH, and gets the unit text back. Running systemctl is the caller's choice, through a runner.

export const UI_UNIT_NAME = "substrate-ui.service";

/** The unit file: `$XDG_CONFIG_HOME/systemd/user/substrate-ui.service`, else ~/.config/systemd/user. */
export function uiUnitFileOf(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "systemd", "user", UI_UNIT_NAME);
}

/** A systemd word: plain when every character is safe, else double-quoted with `\`, `"`, `%` and `$` escaped. */
export function systemdWord(text: string): string {
  if (/^[A-Za-z0-9_.\/:=+,@-]+$/.test(text)) return text;
  const escaped = text.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

export interface UnitInputs {
  /** The absolute path of the Node binary that runs the bundled CLI. */
  execPath: string;
  /** The absolute path of the bundled CLI (dist/substrate.mjs), resolved from the running process. */
  entry: string;
  /** The PATH at install time: a systemd user service gets a minimal PATH, so the harness binaries must be named here. */
  path: string;
  /** Other environment variables the service must see the same way the CLI does (state and config directories). */
  env?: Record<string, string>;
}

/** The text of the unit file. The service runs `ui serve` and restarts on failure. */
export function renderUnit(input: UnitInputs): string {
  const environment = [`PATH=${input.path}`, ...Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`)];
  return [
    "[Unit]",
    "Description=Substrate web UI",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${systemdWord(input.execPath)} ${systemdWord(input.entry)} ui serve`,
    ...environment.map((line) => `Environment=${systemdWord(line)}`),
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The environment variables the unit carries from the install-time shell, when they are set. */
export function unitEnvOf(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "SUBSTRATE_CONFIG_DIR"]) {
    const value = env[key];
    if (value !== undefined && value.length > 0) out[key] = value;
  }
  return out;
}

/** Runs one systemctl or loginctl command with its arguments; returns the exit status. */
export type CommandRunner = (command: string, args: string[]) => number;

/** Runs the given commands in order, stopping at the first that fails. Returns 0 or the failing status. */
export function runAll(commands: Array<[string, string[]]>, run: CommandRunner): number {
  for (const [command, args] of commands) {
    const status = run(command, args);
    if (status !== 0) return status;
  }
  return 0;
}
