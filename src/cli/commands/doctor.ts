import { execFileSync } from "node:child_process";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  noGovernor?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
}

export type ParsedCliFlags = CliGlobalFlags & CliGovernanceFlags;

export interface CommandContext {
  cwd: string;
  flags: ParsedCliFlags;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: Engine;
  sessionStore?: SessionStore;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);

export const doctorCommand: CliCommand = {
  name: "doctor",
  description: "Diagnose system environment, runtime dependencies, and backend readiness",
  async execute(ctx: CommandContext): Promise<number> {
    let allPass = true;

    // 1. Node.js version check
    const nodeVer = process.versions.node;
    const major = parseInt(nodeVer.split(".")[0], 10);
    const nodeOk = major >= 22;
    if (!nodeOk) allPass = false;

    // 2. Git check
    let gitVer = "not found";
    let gitOk = false;
    try {
      gitVer = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
      gitOk = true;
    } catch {
      allPass = false;
    }

    // 3. Bubblewrap sandbox check
    let bwrapVer = "not found";
    let bwrapOk = false;
    try {
      bwrapVer = execFileSync("bwrap", ["--version"], { encoding: "utf8" }).trim();
      bwrapOk = true;
    } catch {
      // bubblewrap may not be installed in all test environments
    }

    // 4. Backends check
    const adapterVersions: Record<string, string> = {};
    for (const bin of ["claude", "opencode", "agy"]) {
      let ver = "not found";
      try {
        ver = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
      } catch {
        // optional
      }
      adapterVersions[bin] = ver;
    }

    const results = {
      node: { version: nodeVer, ok: nodeOk },
      git: { version: gitVer, ok: gitOk },
      bubblewrap: { version: bwrapVer, ok: bwrapOk },
      adapters: adapterVersions,
    };

    if (ctx.flags.outputFormat === "json") {
      ctx.stdout.write(JSON.stringify(results) + "\n");
      return allPass ? 0 : 1;
    }

    ctx.stdout.write(`=== Substrate System Diagnostics ===\n\n`);
    ctx.stdout.write(`Node.js Version: ${results.node.version} ${results.node.ok ? "[PASS (>= 22)]" : "[FAIL (requires >= 22)]"}\n`);
    ctx.stdout.write(`Git Version:     ${results.git.version} ${results.git.ok ? "[PASS]" : "[FAIL]"}\n`);
    ctx.stdout.write(`Bubblewrap (bwrap): ${results.bubblewrap.version} ${results.bubblewrap.ok ? "[PASS]" : "[WARN (sandbox disabled)]"}\n`);
    for (const [bin, ver] of Object.entries(results.adapters)) {
      ctx.stdout.write(`Adapter [${bin}]: ${ver}\n`);
    }

    return allPass ? 0 : 1;
  },
};

registry.register(doctorCommand);
