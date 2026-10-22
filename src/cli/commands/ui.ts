import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `substrate ui`: the browser UI (docs/design/web-ui.md, section 8). `ui serve` runs the server in the foreground until
// SIGINT or SIGTERM and records its pid in ui.pid. `ui start` runs it detached, `ui stop` ends it, `ui status` reports
// it, and `ui install-service` writes the systemd user unit that keeps it running. The server itself is passed in by the
// dispatcher (ctx.web), since the CLI may not import src/web.

interface UiHost {
  serveUi(options: { port?: number }): Promise<{ url: string; port: number; close(): Promise<void> }>;
}

interface CommandContext {
  cwd: string;
  flags: {
    port?: number;
    outputFormat?: "text" | "json" | "stream-json";
    force?: boolean;
    enable?: boolean;
    disable?: boolean;
  };
  rawArgs: string[];
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  signal?: AbortSignal;
  web?: UiHost;
}

interface CliCommand {
  name: string;
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);
const ui = await import(`../../store/ui-state.js`);
const proc = await import(`../../util/process-control.js`);
const unit = await import(`../../util/systemd-unit.js`);
const cmds = await import(`../systemctl.js`);
const { listProjects } = await import(`../../store/projects.js`);
const { projectRunsOf } = await import(`../../observe/runs-view.js`);

/** How long `ui start` waits for the child to write its pid file and answer its health endpoint. */
const START_WAIT_MS = 15000;
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

/** Resolves when the process is asked to stop: the dispatcher's abort signal, or SIGINT or SIGTERM when there is none. */
function untilStopRequested(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal !== undefined) {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
      return;
    }
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

/** Runs a systemctl or loginctl command with its output on this process's streams; returns its exit status. */
function runCommand(command: string, args: string[]): number {
  const res = spawnSync(command, args, { stdio: "inherit" });
  if (res.error !== undefined) {
    process.stderr.write(`Error: could not run ${command}: ${res.error.message}\n`);
    return 1;
  }
  return res.status ?? 1;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

async function serve(ctx: CommandContext): Promise<number> {
  if (ctx.web === undefined) {
    ctx.stderr.write("Error: the web server is not available in this process\n");
    return 1;
  }
  const env = process.env;
  const configFile = ui.uiConfigFileOf(env);
  const pidFile = ui.uiPidFileOf(env);
  const flagPort = ctx.flags.port;
  if (flagPort !== undefined && !validPort(flagPort)) {
    ctx.stderr.write("Error: --port must be a whole number from 0 to 65535\n");
    return 2;
  }
  let stored: number | undefined;
  try {
    stored = ui.readUiPort(configFile);
  } catch (err) {
    ctx.stderr.write(`Error: ${(err as Error).message}\n`);
    return 2;
  }
  const existing = ui.uiPidStateOf(pidFile);
  if (existing.state === "live") {
    ctx.stderr.write(`Error: the web UI is already running at ${existing.record.url} (pid ${existing.record.pid}); use: substrate ui stop\n`);
    return 1;
  }

  const chosen = ui.choosePort(flagPort, stored);
  let server: { url: string; port: number; close(): Promise<void> };
  try {
    server = await ctx.web.serveUi({ port: chosen.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") {
      ctx.stderr.write(`Error: the web UI could not start: ${(err as Error).message}\n`);
      return 1;
    }
    if (chosen.source === "flag") {
      ctx.stderr.write(`Error: port ${chosen.port} is in use; choose another with --port\n`);
      return 1;
    }
    // The stored port is taken by something else: take a new one from the system and keep it (ui.json).
    try {
      server = await ctx.web.serveUi({ port: 0 });
    } catch (again) {
      ctx.stderr.write(`Error: the web UI could not start: ${(again as Error).message}\n`);
      return 1;
    }
    ctx.stderr.write(`port ${chosen.port} is in use; the web UI now uses port ${server.port} (saved in ${configFile})\n`);
  }

  if (flagPort === undefined && server.port !== stored) {
    try {
      ui.writeUiPort(configFile, server.port);
    } catch (err) {
      ctx.stderr.write(`warning: could not save the port in ${configFile}: ${(err as Error).message}\n`);
    }
  }
  ui.writeUiPidRecord(pidFile, {
    pid: process.pid,
    url: server.url,
    started_at: new Date().toISOString(),
    node: process.execPath,
  });
  ctx.stdout.write(`${server.url}\n`);
  await untilStopRequested(ctx.signal);
  await server.close();
  const current = ui.uiPidStateOf(pidFile);
  if (current.state !== "none" && current.record.pid === process.pid) ui.removeUiPidRecord(pidFile);
  return 0;
}

async function start(ctx: CommandContext): Promise<number> {
  const env = process.env;
  const json = ctx.flags.outputFormat === "json";
  const pidFile = ui.uiPidFileOf(env);
  const emit = (url: string, pid: number): void => {
    ctx.stdout.write(json ? `${JSON.stringify({ url, pid })}\n` : `${url}\n`);
  };

  const state = ui.uiPidStateOf(pidFile);
  if (state.state === "live") {
    if (await ui.probeHealth(state.record.url)) {
      emit(state.record.url, state.record.pid);
      return 0;
    }
    ctx.stderr.write(
      `Error: the web UI (pid ${state.record.pid}) is running but does not answer at ${state.record.url}; use: substrate ui stop\n`,
    );
    return 1;
  }
  if (state.state === "stale") ui.removeUiPidRecord(pidFile);

  const flagPort = ctx.flags.port;
  if (flagPort !== undefined && !validPort(flagPort)) {
    ctx.stderr.write("Error: --port must be a whole number from 0 to 65535\n");
    return 2;
  }
  const args = ["ui", "serve"];
  if (flagPort !== undefined) args.push("--port", String(flagPort));
  const logFile = ui.uiLogFileOf(env);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const child = proc.spawnDetached({
    script: path.resolve(process.argv[1]),
    args,
    cwd: ctx.cwd,
    env: { ...process.env },
    logFile,
    stdin: false,
  });
  let exited = false;
  let exitCode = 1;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code ?? 1;
  });

  const deadline = Date.now() + START_WAIT_MS;
  while (!exited && Date.now() < deadline) {
    const now = ui.uiPidStateOf(pidFile);
    if (now.state === "live" && now.record.pid === child.pid && (await ui.probeHealth(now.record.url, 1000))) {
      emit(now.record.url, now.record.pid);
      return 0;
    }
    await sleep(POLL_MS);
  }

  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").slice(-20).join("\n") : "";
  if (tail.trim().length > 0) ctx.stderr.write(tail.endsWith("\n") ? tail : `${tail}\n`);
  if (!exited && child.pid !== undefined) proc.realProcessControl.signal(child.pid, "SIGTERM");
  ctx.stderr.write(
    exited
      ? `Error: the web UI exited with status ${exitCode} before it answered; log: ${logFile}\n`
      : `Error: the web UI did not answer within ${START_WAIT_MS / 1000} s; log: ${logFile}\n`,
  );
  return exited ? exitCode || 1 : 1;
}

async function stop(ctx: CommandContext): Promise<number> {
  const json = ctx.flags.outputFormat === "json";
  const pidFile = ui.uiPidFileOf(process.env);
  const notRunning = (note?: string): number => {
    if (json) ctx.stdout.write(`${JSON.stringify({ running: false, stopped: false, pid: null, url: null })}\n`);
    else ctx.stdout.write(note ?? "the web UI is not running\n");
    return 0;
  };

  const state = ui.uiPidStateOf(pidFile);
  if (state.state === "none") return notRunning();
  if (state.state === "stale") {
    ui.removeUiPidRecord(pidFile);
    return notRunning("the web UI is not running (removed a stale pid file)\n");
  }

  const { pid, url } = state.record;
  const outcome = await proc.endRunProcess(pid, { force: ctx.flags.force === true });
  if (outcome === "refused") {
    ctx.stderr.write(`pid ${pid} is not a Substrate process (stale pid file); not signalling it\n`);
    return 1;
  }
  if (outcome === "not_stopped") {
    ctx.stderr.write(
      `the web UI (pid ${pid}) did not stop within ${proc.STOP_WAIT_MS / 1000} s; use: substrate ui stop --force\n`,
    );
    if (json) ctx.stdout.write(`${JSON.stringify({ running: true, stopped: false, pid, url })}\n`);
    return 1;
  }
  ui.removeUiPidRecord(pidFile);
  if (json) ctx.stdout.write(`${JSON.stringify({ running: false, stopped: true, pid, url })}\n`);
  else ctx.stdout.write(`the web UI stopped (pid ${pid})\n`);
  return 0;
}

async function status(ctx: CommandContext): Promise<number> {
  const env = process.env;
  const json = ctx.flags.outputFormat === "json";
  const state = ui.uiPidStateOf(ui.uiPidFileOf(env));
  const live = state.state === "live" ? state.record : undefined;
  const answering = live !== undefined && (await ui.probeHealth(live.url));
  const unitFile = unit.uiUnitFileOf(env);
  const installed = fs.existsSync(unitFile);
  const projects = listProjects(env).length;
  const runningJobs = projectRunsOf(env).filter((r) => r.record.process?.alive === true).length;
  const uptimeSeconds = live !== undefined && live.started_at.length > 0
    ? Math.max(0, Math.floor((Date.now() - Date.parse(live.started_at)) / 1000))
    : null;

  if (json) {
    ctx.stdout.write(`${JSON.stringify({
      running: answering,
      url: live?.url ?? null,
      pid: live?.pid ?? null,
      started_at: live?.started_at ?? null,
      uptime_seconds: answering ? uptimeSeconds : null,
      projects,
      running_jobs: runningJobs,
      service: { installed, unit_file: unitFile },
    })}\n`);
    return 0;
  }
  if (answering && live !== undefined) {
    ctx.stdout.write(
      `Substrate web UI: running\n` +
        `url:      ${live.url}\n` +
        `pid:      ${live.pid}\n` +
        `uptime:   ${formatUptime(uptimeSeconds ?? 0)}\n`,
    );
  } else if (live !== undefined) {
    ctx.stdout.write(`Substrate web UI: stopped (pid ${live.pid} does not answer at ${live.url})\n`);
  } else {
    ctx.stdout.write(`Substrate web UI: stopped\n`);
  }
  ctx.stdout.write(
    `projects: ${projects}\n` +
      `jobs:     ${runningJobs} running\n` +
      `service:  ${installed ? `installed (${unitFile})` : "not installed"}\n`,
  );
  return 0;
}

/** The Linux check the service commands share: systemd user units exist only on Linux for now (web-ui design, 8.4). */
function refuseUnlessLinux(ctx: CommandContext): number | undefined {
  if (process.platform === "linux") return undefined;
  ctx.stderr.write(
    `Error: the web UI service is supported on Linux with systemd only for now; on this platform run: substrate ui start\n`,
  );
  return 2;
}

async function installService(ctx: CommandContext): Promise<number> {
  const refused = refuseUnlessLinux(ctx);
  if (refused !== undefined) return refused;
  const env = process.env;
  const unitFile = unit.uiUnitFileOf(env);
  // The bundled CLI the running process loaded, by its real path, so a symlinked install still names the file.
  const entry = fs.realpathSync(path.resolve(process.argv[1]));
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(
    unitFile,
    unit.renderUnit({ execPath: process.execPath, entry, path: env.PATH ?? "", env: unit.unitEnvOf(env) }),
    "utf8",
  );
  ctx.stdout.write(`wrote ${unitFile}\n`);

  const enable = cmds.enableCommandsOf();
  if (ctx.flags.enable === true) {
    const status = unit.runAll(enable, runCommand);
    if (status !== 0) {
      ctx.stderr.write(`Error: systemctl exited with status ${status}; the unit file is written\n`);
      return 1;
    }
    ctx.stdout.write("the web UI service is enabled and started\n");
    return 0;
  }
  const user = os.userInfo().username;
  ctx.stdout.write(
    `to start it now and at every login, run:\n` +
      enable.map((c) => `  ${cmds.commandLineOf(c)}\n`).join("") +
      `to start it at boot, before you log in, run once:\n` +
      `  loginctl enable-linger ${user}\n`,
  );
  return 0;
}

async function uninstallService(ctx: CommandContext): Promise<number> {
  const refused = refuseUnlessLinux(ctx);
  if (refused !== undefined) return refused;
  const unitFile = unit.uiUnitFileOf(process.env);
  const [disableNow, reload] = cmds.disableCommandsOf();
  if (ctx.flags.disable === true) {
    const status = runCommand(disableNow[0], disableNow[1]);
    if (status !== 0) {
      ctx.stderr.write(`Error: systemctl exited with status ${status}; the unit file is kept\n`);
      return 1;
    }
  }
  if (!fs.existsSync(unitFile)) {
    ctx.stdout.write(`no unit file at ${unitFile}\n`);
    return 0;
  }
  fs.rmSync(unitFile, { force: true });
  ctx.stdout.write(`removed ${unitFile}\n`);
  if (ctx.flags.disable === true) {
    const status = runCommand(reload[0], reload[1]);
    if (status !== 0) return status;
    ctx.stdout.write("the web UI service is stopped and disabled\n");
    return 0;
  }
  ctx.stdout.write(`to stop and disable it, run:\n  ${cmds.commandLineOf(disableNow)}\n  ${cmds.commandLineOf(reload)}\n`);
  return 0;
}

/** The subcommands of `ui`, by name. */
const SUBCOMMANDS: Record<string, { description: string; run(ctx: CommandContext): Promise<number> }> = {
  serve: {
    description: "Run the browser UI in the foreground until SIGINT or SIGTERM (what systemd runs)",
    run: serve,
  },
  start: {
    description: "Start the browser UI in the background (if it is not running) and print its URL",
    run: start,
  },
  stop: {
    description: "Stop the background browser UI (--force kills it if it does not stop)",
    run: stop,
  },
  status: {
    description: "Show whether the browser UI runs, its URL and pid, and the service state",
    run: status,
  },
  "install-service": {
    description: "Write the systemd user unit that keeps the browser UI running (--enable runs systemctl)",
    run: installService,
  },
  "uninstall-service": {
    description: "Remove the systemd user unit (--disable stops and disables it first)",
    run: uninstallService,
  },
};

export const uiCommand: CliCommand = {
  name: "ui",
  description: "The browser UI on localhost, and its background service (ui start, status, stop, install-service)",
  async execute(ctx: CommandContext): Promise<number> {
    const sub = ctx.rawArgs[0];
    if (sub === undefined) {
      ctx.stdout.write("Usage: substrate ui <subcommand>\n\nSubcommands:\n");
      for (const [name, entry] of Object.entries(SUBCOMMANDS)) {
        ctx.stdout.write(`  ${name.padEnd(18)} ${entry.description}\n`);
      }
      return 0;
    }
    const entry = Object.prototype.hasOwnProperty.call(SUBCOMMANDS, sub) ? SUBCOMMANDS[sub] : undefined;
    if (entry === undefined) {
      ctx.stderr.write(`Error: unknown ui subcommand '${sub}'\n`);
      return 2;
    }
    return entry.run(ctx);
  },
};

registry.register(uiCommand);
