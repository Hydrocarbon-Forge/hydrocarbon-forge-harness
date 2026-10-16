import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Command } from "../../../src/contracts/index.js";
import {
  detectEcosystem,
  getDefaultVerify,
  type Ecosystem,
} from "../../../src/spec/ecosystem.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "substrate-eco-test-"));
}

describe("ecosystem: detectEcosystem", () => {
  it("detects node-ts when package.json is present", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), "{}");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("node-ts");
  });

  it("detects node-ts when tsconfig.json is present without package.json", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("node-ts");
  });

  it("detects python when pyproject.toml is present", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "pyproject.toml"), "");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("python");
  });

  it("detects python when setup.py is present", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "setup.py"), "");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("python");
  });

  it("detects python when requirements.txt is present", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "requirements.txt"), "");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("python");
  });

  it("detects python when Pipfile is present", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Pipfile"), "");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("python");
  });

  it("detects rust when Cargo.toml is present", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Cargo.toml"), "");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("rust");
  });

  it("detects go when go.mod is present", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "go.mod"), "");
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("go");
  });

  it("detects other when no ecosystem marker files exist", async () => {
    const dir = tempDir();
    const eco = await detectEcosystem(dir);
    expect(eco).toBe("other");
  });

  it("respects strict precedence: node-ts > python > rust > go > other", async () => {
    // node-ts over python
    const dir1 = tempDir();
    writeFileSync(join(dir1, "package.json"), "{}");
    writeFileSync(join(dir1, "requirements.txt"), "");
    expect(await detectEcosystem(dir1)).toBe("node-ts");

    // python over rust
    const dir2 = tempDir();
    writeFileSync(join(dir2, "pyproject.toml"), "");
    writeFileSync(join(dir2, "Cargo.toml"), "");
    expect(await detectEcosystem(dir2)).toBe("python");

    // rust over go
    const dir3 = tempDir();
    writeFileSync(join(dir3, "Cargo.toml"), "");
    writeFileSync(join(dir3, "go.mod"), "");
    expect(await detectEcosystem(dir3)).toBe("rust");
  });
});

describe("ecosystem: getDefaultVerify", () => {
  const ecosystems: Ecosystem[] = ["node-ts", "python", "rust", "go", "other"];

  it.each(ecosystems)("returns valid Command array for %s", (eco) => {
    const commands = getDefaultVerify(eco);
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);

    for (const cmd of commands) {
      // Validate schema
      expect(() => Command.parse(cmd)).not.toThrow();
      expect(typeof cmd.run).toBe("string");
      expect(cmd.run.length).toBeGreaterThan(0);
      expect(cmd.timeout_s).toBeGreaterThan(0);
    }
  });

  it("provides expected test runners in verify commands", () => {
    const nodeCmds = getDefaultVerify("node-ts");
    expect(nodeCmds.some((c) => c.run.includes("test") || c.run.includes("npm"))).toBe(true);

    const pyCmds = getDefaultVerify("python");
    expect(pyCmds.some((c) => c.run.includes("pytest") || c.run.includes("python"))).toBe(true);

    const rustCmds = getDefaultVerify("rust");
    expect(rustCmds.some((c) => c.run.includes("cargo test"))).toBe(true);

    const goCmds = getDefaultVerify("go");
    expect(goCmds.some((c) => c.run.includes("go test"))).toBe(true);
  });
});
