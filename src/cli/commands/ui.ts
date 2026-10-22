import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// `substrate ui`: the browser UI (docs/design/web-ui.md, 8.1 and 8.2). `ui serve` runs the server in the foreground
// until SIGINT or SIGTERM. The other subcommands (start, stop, status, install-service) are added to SUBCOMMANDS.
// The server itself is passed in by the dispatcher (ctx.web), since the CLI may not import src/web.

interface UiHost {
  serveUi(options: { port?: number }): Promise<{ url: string; close(): Promise<void> }>;
}

interface CommandContext {
  cwd: string;
  flags: { port?: number };
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

/** The user-level config file: `ui.json` in the directory of settings.json ($SUBSTRATE_CONFIG_DIR, else ~/.config/substrate). */
export function uiConfigFileOf(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SUBSTRATE_CONFIG_DIR && env.SUBSTRATE_CONFIG_DIR.length > 0
    ? env.SUBSTRATE_CONFIG_DIR
    : path.join(homedir(), ".config", "substrate");
  return path.join(dir, "ui.json");
}

/** The port the config file names, or undefined when the file does not exist. A file that names no valid port throws. */
export function readUiPort(file: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file} is not readable`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const port = (parsed as { port?: unknown } | null)?.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${file} does not name a port from 0 to 65535`);
  }
  return port;
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

async function serve(ctx: CommandContext): Promise<number> {
  if (ctx.web === undefined) {
    ctx.stderr.write("Error: the web server is not available in this process\n");
    return 1;
  }
  const configFile = uiConfigFileOf();
  let port = ctx.flags.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    ctx.stderr.write("Error: --port must be a whole number from 0 to 65535\n");
    return 2;
  }
  if (port === undefined) {
    try {
      port = readUiPort(configFile);
    } catch (err) {
      ctx.stderr.write(`Error: ${(err as Error).message}\n`);
      return 2;
    }
  }
  let server: { url: string; close(): Promise<void> };
  try {
    server = await ctx.web.serveUi({ port: port ?? 0 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      ctx.stderr.write(`Error: port ${port} is in use; choose another with --port, or change the port in ${configFile}\n`);
    } else {
      ctx.stderr.write(`Error: the web UI could not start: ${(err as Error).message}\n`);
    }
    return 1;
  }
  ctx.stdout.write(`${server.url}\n`);
  await untilStopRequested(ctx.signal);
  await server.close();
  return 0;
}

/** The subcommands of `ui`, by name. */
const SUBCOMMANDS: Record<string, { description: string; run(ctx: CommandContext): Promise<number> }> = {
  serve: {
    description: "Run the browser UI in the foreground until SIGINT or SIGTERM (what systemd runs)",
    run: serve,
  },
};

export const uiCommand: CliCommand = {
  name: "ui",
  description: "The browser UI on localhost (ui serve runs it in the foreground)",
  async execute(ctx: CommandContext): Promise<number> {
    const sub = ctx.rawArgs[0];
    if (sub === undefined) {
      ctx.stdout.write("Usage: substrate ui <subcommand>\n\nSubcommands:\n");
      for (const [name, entry] of Object.entries(SUBCOMMANDS)) {
        ctx.stdout.write(`  ${name.padEnd(14)} ${entry.description}\n`);
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
