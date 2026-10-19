import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scriptPath = path.resolve("scripts/docs-check.mjs");
const cleanRoot = path.resolve("test/fixtures/docs-check/clean");
const badRoot = path.resolve("test/fixtures/docs-check/bad");
const RULES = ["DOC-FLAG", "DOC-CMD", "DOC-ENV", "DOC-KEY"];

function run(args: string[]) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      status: err.status,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
    };
  }
}

/** Violation lines of one rule: `RULE path:line message`, anchored at the start of the line. */
function violationLines(stdout: string, rule: string): string[] {
  return stdout.split("\n").filter((l) => new RegExp(`^${rule} \\S+:\\d+ `).test(l));
}

describe("docs-check script: new DOC-* rules", () => {
  it("clean fixture exits 0 with OK and no DOC-* violation lines", () => {
    const res = run(["--root", cleanRoot]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("OK");
    for (const rule of RULES) {
      expect(violationLines(res.stdout, rule)).toEqual([]);
    }
  });

  it("clean fixture accepts --model=<id>, the substrate/runs/ path and a wildcard settings key", () => {
    const res = run(["--root", cleanRoot]);
    expect(res.status).toBe(0);
    // The README holds `--model=<id>` and `substrate/runs/`; neither may be reported.
    expect(res.stdout).not.toMatch(/DOC-FLAG .*model/);
    expect(res.stdout).not.toMatch(/DOC-CMD .*runs/);
    // The config table holds `backends.*.bin`; a key with a `*` segment is skipped.
    expect(res.stdout).not.toMatch(/DOC-KEY .*backends/);
  });

  it("bad fixture exits 1 with exactly one violation line per rule", () => {
    const res = run(["--root", badRoot]);
    expect(res.status).toBe(1);
    for (const rule of RULES) {
      expect(violationLines(res.stdout, rule)).toHaveLength(1);
    }
    expect(res.stdout).toMatch(/^FAIL: 4 violation\(s\)$/m);
  });

  it("bad fixture reports each violation at the right file and line", () => {
    const res = run(["--root", badRoot]);
    expect(violationLines(res.stdout, "DOC-FLAG")[0]).toMatch(/^DOC-FLAG README\.md:3 .*--worktree/);
    expect(violationLines(res.stdout, "DOC-CMD")[0]).toMatch(/^DOC-CMD README\.md:5 .*nosuch/);
    expect(violationLines(res.stdout, "DOC-ENV")[0]).toMatch(/^DOC-ENV README\.md:7 .*SUBSTRATE_MISSING_VAR/);
    expect(violationLines(res.stdout, "DOC-KEY")[0]).toMatch(/^DOC-KEY docs\/reference\/config\.md:5 .*git\.missing_key/);
  });

  it("prints a per-rule check count before the closing verdict", () => {
    const res = run(["--root", badRoot]);
    for (const rule of RULES) {
      expect(res.stdout).toMatch(new RegExp(`^  ${rule} checks: \\d+$`, "m"));
    }
  });

  it("produces byte-identical output on repeated runs", () => {
    const first = run(["--root", badRoot]);
    const second = run(["--root", badRoot]);
    expect(second.stdout).toBe(first.stdout);
  });
});

describe("docs-check script: DOC-CMD command sources", () => {
  it("counts a command module beside the dispatcher only when the dispatcher loads it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "docs-check-cmd-"));
    try {
      cpSync(cleanRoot, root, { recursive: true });
      const command = (name: string) =>
        `export const ${name}Command = {\n  name: "${name}",\n  description: "fixture",\n};\n`;
      writeFileSync(path.join(root, "src", "cli", "loaded.ts"), command("loaded"));
      writeFileSync(path.join(root, "src", "cli", "orphan.ts"), command("orphan"));
      appendFileSync(path.join(root, "src", "cli", "dispatcher.ts"), "\nawait import(`./loaded.js`);\n");
      appendFileSync(path.join(root, "README.md"), "\n```\nsubstrate loaded\nsubstrate orphan\n```\n");

      const res = run(["--root", root]);
      expect(res.status).toBe(1);
      const lines = violationLines(res.stdout, "DOC-CMD");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("orphan");
      expect(res.stdout).not.toMatch(/DOC-CMD .*loaded/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
