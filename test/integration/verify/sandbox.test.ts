import { describe, expect, it } from "vitest";

import * as SandboxModule from "../../../src/verify/sandbox.js";
import type { BwrapSandbox, SandboxOptions } from "../../../src/verify/sandbox.js";

function getBwrapSandbox(): BwrapSandbox {
  const mod = SandboxModule as any;
  if (mod.BwrapSandbox) {
    if (typeof mod.BwrapSandbox === "function") {
      try {
        return new mod.BwrapSandbox();
      } catch {
        return mod.BwrapSandbox;
      }
    }
    return mod.BwrapSandbox;
  }
  if (mod.bwrapSandbox) return mod.bwrapSandbox;
  return mod as BwrapSandbox;
}

describe("verify: BwrapSandbox - availability", () => {
  it("detects whether bwrap is available on the system without throwing", async () => {
    const sandbox = getBwrapSandbox();
    const available = await sandbox.isAvailable();
    expect(typeof available).toBe("boolean");
    // On Linux systems with bubblewrap installed, this should return true
    if (process.platform === "linux") {
      expect(available).toBe(true);
    }
  });
});

describe("verify: BwrapSandbox - wrapCommand arguments", () => {
  it("wraps command with read-only root, writable worktree, writable tmp, and die-with-parent", () => {
    const sandbox = getBwrapSandbox();
    const options: SandboxOptions = {
      worktreePath: "/home/user/project/.substrate/worktrees/task-1",
      network: "deny",
    };

    const wrapped = sandbox.wrapCommand(["npm", "test"], options);

    expect(wrapped[0]).toMatch(/bwrap$/);

    // Read-only root
    const roBindIndex = wrapped.indexOf("--ro-bind");
    expect(roBindIndex).toBeGreaterThanOrEqual(0);
    expect(wrapped[roBindIndex + 1]).toBe("/");
    expect(wrapped[roBindIndex + 2]).toBe("/");

    // Writable worktree only
    expect(wrapped).toContain("--bind");
    const worktreeBindIdx = wrapped.findIndex(
      (arg, i) => arg === "--bind" && wrapped[i + 1] === options.worktreePath && wrapped[i + 2] === options.worktreePath,
    );
    expect(worktreeBindIdx).toBeGreaterThanOrEqual(0);

    // Writable /tmp (either bind or tmpfs)
    const hasWritableTmp =
      (wrapped.includes("--bind") && wrapped.includes("/tmp")) ||
      (wrapped.includes("--tmpfs") && wrapped.includes("/tmp"));
    expect(hasWritableTmp).toBe(true);

    // die-with-parent
    expect(wrapped).toContain("--die-with-parent");

    // Network deny: includes --unshare-net
    expect(wrapped).toContain("--unshare-net");

    // End of options marker followed by target command
    const dashDashIndex = wrapped.indexOf("--");
    expect(dashDashIndex).toBeGreaterThan(0);
    expect(wrapped.slice(dashDashIndex + 1)).toEqual(["npm", "test"]);
  });

  it("omits --unshare-net when network is 'allow'", () => {
    const sandbox = getBwrapSandbox();
    const options: SandboxOptions = {
      worktreePath: "/path/to/worktree",
      network: "allow",
    };

    const wrapped = sandbox.wrapCommand(["npm", "install"], options);
    expect(wrapped).not.toContain("--unshare-net");

    const dashDashIndex = wrapped.indexOf("--");
    expect(wrapped.slice(dashDashIndex + 1)).toEqual(["npm", "install"]);
  });

  it("includes extraBinds when specified in SandboxOptions", () => {
    const sandbox = getBwrapSandbox();
    const options: SandboxOptions = {
      worktreePath: "/path/to/worktree",
      network: "deny",
      extraBinds: ["/home/user/.npm"],
    };

    const wrapped = sandbox.wrapCommand(["npm", "test"], options);

    const extraBindIdx = wrapped.findIndex(
      (arg, i) => (arg === "--bind" || arg === "--ro-bind") && wrapped[i + 1] === "/home/user/.npm",
    );
    expect(extraBindIdx).toBeGreaterThanOrEqual(0);
  });
});

describe("verify: BwrapSandbox - scrubEnvironment", () => {
  it("strips sensitive tokens and API keys while preserving allowlisted system variables", () => {
    const sandbox = getBwrapSandbox();

    const dirtyEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "secret-key",
      OPENAI_API_KEY: "secret-key-2",
      AWS_SECRET_ACCESS_KEY: "secret-key-3",
      GITHUB_TOKEN: "ghp_1234567890",
      SUBSTRATE_TOKEN: "sub_token",
      SOME_RANDOM_VARIABLE: "random",
    };

    const scrubbed = sandbox.scrubEnvironment(dirtyEnv);

    expect(scrubbed["PATH"]).toBe("/usr/bin:/bin");
    expect(scrubbed["HOME"]).toBe("/home/user");
    expect(scrubbed["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(scrubbed["OPENAI_API_KEY"]).toBeUndefined();
    expect(scrubbed["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(scrubbed["GITHUB_TOKEN"]).toBeUndefined();
    expect(scrubbed["SUBSTRATE_TOKEN"]).toBeUndefined();
  });

  it("respects custom allowlist when explicitly provided", () => {
    const sandbox = getBwrapSandbox();

    const rawEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      MY_ALLOWED_VAR: "allowed_val",
      FORBIDDEN_VAR: "forbidden_val",
      ANTHROPIC_API_KEY: "secret",
    };

    const scrubbed = sandbox.scrubEnvironment(rawEnv, ["PATH", "MY_ALLOWED_VAR"]);

    expect(scrubbed["PATH"]).toBe("/usr/bin");
    expect(scrubbed["MY_ALLOWED_VAR"]).toBe("allowed_val");
    expect(scrubbed["FORBIDDEN_VAR"]).toBeUndefined();
    expect(scrubbed["ANTHROPIC_API_KEY"]).toBeUndefined();
  });
});
