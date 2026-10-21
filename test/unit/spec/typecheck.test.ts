import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  typecheckContracts,
  type ContractTypecheckResult,
} from "../../../src/spec/typecheck.js";
import { createTempRepo } from "./fixtures.js";

describe("contract typecheck: typecheckContracts", () => {
  it("succeeds when contract files exist and typecheck command exits 0", async () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    const contractPath = join(repo, "src", "contracts", "index.ts");
    writeFileSync(contractPath, "export type Foo = string;\n", "utf8");

    const result = await typecheckContracts(repo, {
      files: ["src/contracts/index.ts"],
      typecheck: [{ run: "node -e 'process.exit(0)'", timeout_s: 10 }],
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].exit_code).toBe(0);
    expect(result.results[0].timed_out).toBe(false);
  });

  it("emits L019 error diagnostic when declared contract file is missing", async () => {
    const repo = createTempRepo();

    const result = await typecheckContracts(repo, {
      files: ["src/contracts/missing.ts"],
      typecheck: [{ run: "node -e 'process.exit(0)'", timeout_s: 10 }],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const diag = result.diagnostics.find((d) => d.code === "L019");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("error");
    expect(diag?.message).toContain("src/contracts/missing.ts");
  });

  it("emits L018 error diagnostic when typecheck command exits non-zero", async () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    const contractPath = join(repo, "src", "contracts", "index.ts");
    writeFileSync(contractPath, "export type Foo = string;\n", "utf8");

    const result = await typecheckContracts(repo, {
      files: ["src/contracts/index.ts"],
      typecheck: [
        {
          run: "node -e 'console.error(\"TS2304: Cannot find name\"); process.exit(1)'",
          timeout_s: 10,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const diag = result.diagnostics.find((d) => d.code === "L018");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("error");
    expect(diag?.message).toContain("exit");

    expect(result.results).toHaveLength(1);
    expect(result.results[0].exit_code).toBe(1);
    expect(result.results[0].stderr_tail).toContain("TS2304");
  });

  it("handles command timeout and marks timed_out with L018 diagnostic", async () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    const contractPath = join(repo, "src", "contracts", "index.ts");
    writeFileSync(contractPath, "export type Foo = string;\n", "utf8");

    const result = await typecheckContracts(repo, {
      files: ["src/contracts/index.ts"],
      typecheck: [
        {
          run: "node -e 'setTimeout(() => {}, 5000)'",
          timeout_s: 1, // 1 second timeout
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.results[0].timed_out).toBe(true);
    const diag = result.diagnostics.find((d) => d.code === "L018");
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe("error");
  });

  it("scrubs secrets and sensitive tokens from diagnostics and output tail", async () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    const contractPath = join(repo, "src", "contracts", "index.ts");
    writeFileSync(contractPath, "export type Foo = string;\n", "utf8");

    const dummyAwsKey = "AKIA1234567890ABCDEF";
    const result = await typecheckContracts(repo, {
      files: ["src/contracts/index.ts"],
      typecheck: [
        {
          run: `node -e 'console.error("Token: ${dummyAwsKey}"); process.exit(1)'`,
          timeout_s: 10,
        },
      ],
    });

    expect(result.ok).toBe(false);
    const combinedOutput = (result.results[0]?.stderr_tail ?? "") +
      (result.diagnostics[0]?.message ?? "");
    expect(combinedOutput).not.toContain(dummyAwsKey);
    expect(combinedOutput).toContain("[REDACTED]");
  });

  it("executes multiple commands in sequence and reports all results", async () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, "src", "contracts"), { recursive: true });
    const contractPath = join(repo, "src", "contracts", "index.ts");
    writeFileSync(contractPath, "export type Foo = string;\n", "utf8");

    const result = await typecheckContracts(repo, {
      files: ["src/contracts/index.ts"],
      typecheck: [
        { run: "node -e 'console.log(\"cmd 1\"); process.exit(0)'", timeout_s: 10 },
        { run: "node -e 'console.log(\"cmd 2\"); process.exit(0)'", timeout_s: 10 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].stdout_tail).toContain("cmd 1");
    expect(result.results[1].stdout_tail).toContain("cmd 2");
  });
});
