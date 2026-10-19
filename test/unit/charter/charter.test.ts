import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";

import {
  readCharter,
  plannerCharter,
  plannerHistory,
} from "../../../src/charter/index.js";
import { charterCommand } from "../../../src/cli/commands/charter.js";
import type { CommandContext } from "../../../src/cli/commands/charter.js";

describe("Charter and Planner Context Unit Tests (R4.5)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-charter-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockContext(
    args: string[] = [],
    flags: Record<string, any> = {},
    stdin?: string
  ): {
    ctx: CommandContext;
    stdout: () => string;
    stderr: () => string;
  } {
    let out = "";
    let err = "";
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    }) as any;
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        err += chunk.toString();
        cb();
      },
    }) as any;

    const ctx: CommandContext = {
      cwd: tempDir,
      flags: flags as any,
      rawArgs: args,
      stdin,
      stdout,
      stderr,
    };

    return {
      ctx,
      stdout: () => out,
      stderr: () => err,
    };
  }

  describe("readCharter", () => {
    it("returns undefined when charter.md is missing", () => {
      expect(readCharter(tempDir)).toBeUndefined();
    });

    it("reads charter without frontmatter as undefined version", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(
        path.join(substrateDir, "charter.md"),
        "# Project Charter\n\nBuild reliable software.\n",
        "utf8"
      );

      const res = readCharter(tempDir);
      expect(res).toBeDefined();
      expect(res?.version).toBeUndefined();
      expect(res?.body).toBe("# Project Charter\n\nBuild reliable software.\n");
    });

    it("parses YAML frontmatter for version", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(
        path.join(substrateDir, "charter.md"),
        "---\nversion: v3\n---\n# Body here\n",
        "utf8"
      );

      const res = readCharter(tempDir);
      expect(res).toBeDefined();
      expect(res?.version).toBe("v3");
      expect(res?.body).toBe("# Body here\n");
    });
  });

  describe("cap at 4096 bytes (plannerCharter)", () => {
    it("returns (none) when charter is missing or empty", () => {
      expect(plannerCharter(tempDir)).toBe("(none)");

      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(path.join(substrateDir, "charter.md"), "   \n\n  ", "utf8");
      expect(plannerCharter(tempDir)).toBe("(none)");
    });

    it("charter exactly 4096 bytes is not truncated", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      const exactBody = "A".repeat(4096);
      fs.writeFileSync(path.join(substrateDir, "charter.md"), exactBody, "utf8");

      const res = plannerCharter(tempDir);
      expect(Buffer.byteLength(res, "utf8")).toBe(4096);
      expect(res).toBe(exactBody);
      expect(res).not.toContain("[truncated]");
    });

    it("charter over 4096 bytes is truncated to <= 4096 bytes with marker", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      const bigBody = "A".repeat(5000);
      fs.writeFileSync(path.join(substrateDir, "charter.md"), bigBody, "utf8");

      const res = plannerCharter(tempDir);
      expect(Buffer.byteLength(res, "utf8")).toBeLessThanOrEqual(4096);
      expect(res).toContain("[truncated]");
    });
  });

  describe("cap at 6144 bytes and version exclusion (plannerHistory)", () => {
    it("returns (none) when INDEX.md is missing or empty", () => {
      expect(plannerHistory(tempDir)).toBe("(none)");
    });

    it("reads last five summaries newest first and excludes older versions by default", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      const v1Archive = path.join(substrateDir, "archive", "v1");
      const v2Archive = path.join(substrateDir, "archive", "v2");
      fs.mkdirSync(v1Archive, { recursive: true });
      fs.mkdirSync(v2Archive, { recursive: true });

      // Create v1 runs (should be excluded by default since current version is v2)
      fs.writeFileSync(
        path.join(substrateDir, "charter.md"),
        "---\nversion: v2\n---\n# Charter\n",
        "utf8"
      );

      const v1RunId = "r_V1RUN0000001";
      fs.mkdirSync(path.join(v1Archive, v1RunId), { recursive: true });
      fs.writeFileSync(
        path.join(v1Archive, v1RunId, "summary.md"),
        "## Goal\n\nV1 run goal\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(v1Archive, "INDEX.md"),
        `- ${v1RunId} | finished | V1 run goal | 2026-10-19T10:00:00Z\n`,
        "utf8"
      );

      // Create 6 v2 runs (only last 5 should be read)
      const v2Lines: string[] = [];
      for (let i = 1; i <= 6; i++) {
        const id = `r_V2RUN000000${i}`;
        const dir = path.join(v2Archive, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "summary.md"),
          `## Goal\n\nV2 run ${i} goal\n`,
          "utf8"
        );
        v2Lines.push(`- ${id} | finished | V2 run ${i} goal | 2026-10-19T10:0${i}:00Z`);
      }
      fs.writeFileSync(path.join(v2Archive, "INDEX.md"), v2Lines.join("\n") + "\n", "utf8");

      // Default (current version v2 only):
      const histCurrent = plannerHistory(tempDir);
      // Older version v1 must be excluded
      expect(histCurrent).not.toContain("V1 run goal");
      // The 6th run was the first created, so last 5 are runs 2..6
      expect(histCurrent).toContain("V2 run 6 goal");
      expect(histCurrent).toContain("V2 run 2 goal");
      expect(histCurrent).not.toContain("V2 run 1 goal");

      // Verify newest is first: run 6 appears before run 2
      const idx6 = histCurrent.indexOf("V2 run 6 goal");
      const idx2 = histCurrent.indexOf("V2 run 2 goal");
      expect(idx6).toBeLessThan(idx2);

      // With historyAll: true, v1 is included
      const histAll = plannerHistory(tempDir, { historyAll: true });
      expect(histAll).toContain("V1 run goal");
      expect(histAll).toContain("V2 run 6 goal");
    });

    it("skips missing summary files without error", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      const v1Archive = path.join(substrateDir, "archive", "v1");
      fs.mkdirSync(v1Archive, { recursive: true });

      fs.writeFileSync(
        path.join(v1Archive, "INDEX.md"),
        [
          "- r_MISSING00001 | finished | Missing summary | 2026-10-19T10:00:00Z",
          "- r_PRESENT00002 | finished | Present summary | 2026-10-19T10:01:00Z",
        ].join("\n") + "\n",
        "utf8"
      );

      const presentDir = path.join(v1Archive, "r_PRESENT00002");
      fs.mkdirSync(presentDir, { recursive: true });
      fs.writeFileSync(
        path.join(presentDir, "summary.md"),
        "## Goal\n\nPresent summary goal\n",
        "utf8"
      );

      const hist = plannerHistory(tempDir);
      expect(hist).toContain("Present summary goal");
    });

    it("caps history at 6144 bytes in total with marker", () => {
      const substrateDir = path.join(tempDir, ".substrate");
      const v1Archive = path.join(substrateDir, "archive", "v1");
      fs.mkdirSync(v1Archive, { recursive: true });

      const runId = "r_HUGE00000001";
      const runDir = path.join(v1Archive, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const hugeSummary = "X".repeat(8000);
      fs.writeFileSync(path.join(runDir, "summary.md"), hugeSummary, "utf8");

      fs.writeFileSync(
        path.join(v1Archive, "INDEX.md"),
        `- ${runId} | finished | Huge summary | 2026-10-19T10:00:00Z\n`,
        "utf8"
      );

      const hist = plannerHistory(tempDir);
      expect(Buffer.byteLength(hist, "utf8")).toBeLessThanOrEqual(6144);
      expect(hist).toContain("[truncated]");
    });
  });

  describe("charter CLI command", () => {
    it("show: prints .substrate/charter.md or exits 2 if missing", async () => {
      const missing = createMockContext(["show"]);
      const codeMissing = await charterCommand.execute(missing.ctx);
      expect(codeMissing).toBe(2);
      expect(missing.stderr()).toContain("Error: no charter; create one with substrate charter set <file>");

      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(path.join(substrateDir, "charter.md"), "Standing charter\n", "utf8");

      const present = createMockContext(["show"]);
      const codePresent = await charterCommand.execute(present.ctx);
      expect(codePresent).toBe(0);
      expect(present.stdout()).toBe("Standing charter\n");
    });

    it("set: refuses empty input with exit 2", async () => {
      const emptyFile = path.join(tempDir, "empty.md");
      fs.writeFileSync(emptyFile, "   \n\n  ", "utf8");

      const mock = createMockContext(["set", emptyFile]);
      const code = await charterCommand.execute(mock.ctx);
      expect(code).toBe(2);
      expect(mock.stderr()).toContain("Error: charter content cannot be empty");
    });

    it("set: warns if charter exceeds 4096 bytes and keeps existing version", async () => {
      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(
        path.join(substrateDir, "charter.md"),
        "---\nversion: v4\n---\nInitial body\n",
        "utf8"
      );

      const bigFile = path.join(tempDir, "big.md");
      const bigContent = "B".repeat(5000);
      fs.writeFileSync(bigFile, bigContent, "utf8");

      const mock = createMockContext(["set", bigFile]);
      const code = await charterCommand.execute(mock.ctx);
      expect(code).toBe(0);
      expect(mock.stderr()).toContain("Warning: charter exceeds 4096 bytes and will be truncated when passed to the planner");

      const updated = readCharter(tempDir);
      expect(updated?.version).toBe("v4");
      expect(updated?.body.trim()).toBe(bigContent);
    });

    it("bump: validates ^v\\d+$ and keeps body while updating version", async () => {
      const substrateDir = path.join(tempDir, ".substrate");
      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(
        path.join(substrateDir, "charter.md"),
        "---\nversion: v1\n---\n# My Charter Body\n",
        "utf8"
      );

      // Invalid version format
      const invalid = createMockContext(["bump", "2.0"]);
      const codeInvalid = await charterCommand.execute(invalid.ctx);
      expect(codeInvalid).toBe(2);
      expect(invalid.stderr()).toContain("Error: invalid version format; must match ^v\\d+$");

      // Valid version bump
      const valid = createMockContext(["bump", "v2"]);
      const codeValid = await charterCommand.execute(valid.ctx);
      expect(codeValid).toBe(0);
      expect(valid.stdout()).toBe("charter now at v2\n");

      // Body preserved
      const bumped = readCharter(tempDir);
      expect(bumped?.version).toBe("v2");
      expect(bumped?.body.trim()).toBe("# My Charter Body");

      // Creates .substrate/archive/<version>/INDEX.md when not present
      const indexPath = path.join(substrateDir, "archive", "v2", "INDEX.md");
      expect(fs.existsSync(indexPath)).toBe(true);
    });
  });
});
