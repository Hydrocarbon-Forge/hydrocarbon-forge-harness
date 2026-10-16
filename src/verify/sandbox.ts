import { execFileSync } from "node:child_process";

export interface SandboxOptions {
  worktreePath: string;
  network: "deny" | "allow";
  allowlistEnv?: string[];
  extraBinds?: string[];
}

export interface BwrapSandbox {
  isAvailable(): Promise<boolean>;
  wrapCommand(command: string[], options: SandboxOptions): string[];
  scrubEnvironment(
    rawEnv: NodeJS.ProcessEnv,
    allowlist?: string[]
  ): Record<string, string>;
}

const DEFAULT_SYSTEM_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_PATH",
  "NODE_ENV",
  "TERM",
  "TZ",
  "PWD",
  "SHLVL",
  "_",
  "COLORTERM",
  "CI",
];

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes("KEY") ||
    upper.includes("TOKEN") ||
    upper.includes("SECRET") ||
    upper.includes("PASSWD") ||
    upper.includes("PASSWORD") ||
    upper.includes("AUTH") ||
    upper.includes("CREDENTIAL") ||
    upper.includes("PRIVATE")
  );
}

export class BwrapSandboxImpl implements BwrapSandbox {
  async isAvailable(): Promise<boolean> {
    if (process.platform !== "linux") {
      return false;
    }
    try {
      execFileSync("bwrap", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  wrapCommand(command: string[], options: SandboxOptions): string[] {
    const wrapped: string[] = [
      "bwrap",
      "--ro-bind", "/", "/",
      "--bind", options.worktreePath, options.worktreePath,
      "--bind", "/tmp", "/tmp",
      "--die-with-parent",
    ];

    if (options.network === "deny") {
      wrapped.push("--unshare-net");
    }

    if (options.extraBinds) {
      for (const b of options.extraBinds) {
        wrapped.push("--bind", b, b);
      }
    }

    wrapped.push("--", ...command);
    return wrapped;
  }

  scrubEnvironment(
    rawEnv: NodeJS.ProcessEnv,
    allowlist?: string[]
  ): Record<string, string> {
    const scrubbed: Record<string, string> = {};
    const keysToCheck = allowlist ?? DEFAULT_SYSTEM_ALLOWLIST;
    for (const key of keysToCheck) {
      const val = rawEnv[key];
      if (val !== undefined && !isSensitiveEnvKey(key)) {
        scrubbed[key] = val;
      }
    }
    return scrubbed;
  }
}

export const BwrapSandbox = BwrapSandboxImpl;
export const bwrapSandbox = new BwrapSandboxImpl();
