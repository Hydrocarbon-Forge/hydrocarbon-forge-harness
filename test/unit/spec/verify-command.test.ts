import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { verifyBinaryOf } from "../../../src/spec/verify-command.js";
import { ruleL011 } from "../../../src/spec/rules.js";
import {
  createTempRepo,
  sampleManifest,
  sampleParsedPlan,
  sampleParsedTaskSpec,
  sampleSettings,
  sampleTaskSpecFrontmatter,
} from "./fixtures.js";

// R11.1 (known issue 24b): L011 takes the verify binary from the first command word, after assignments,
// and never parses a wrapper's quoted script. The evidence commands are read-only copies from live runs
// (paths scrubbed); their expected binary is the first column ("-" = no checkable command word).

const EVIDENCE = resolve(__dirname, "../../fixtures/verify-commands/evidence.tsv");
const rows = readFileSync(EVIDENCE, "utf8")
  .split("\n")
  .filter((l) => l.length > 0)
  .map((l) => {
    const [bin, cmd] = l.split("\t");
    return { bin: bin === "-" ? undefined : bin, cmd };
  });

let stubDir = "";
let savedPath: string | undefined;

/** A directory of executable stubs: the only place the PATH check finds these binaries. */
function stubs(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-verify-bin-"));
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(file, 0o755);
  }
  return dir;
}

beforeAll(() => {
  savedPath = process.env.PATH;
  const names = new Set<string>(["node", "npm", "sh", "bash", "mkdir", "env", "timeout", "nohup"]);
  for (const r of rows) if (r.bin !== undefined) names.add(r.bin);
  stubDir = stubs([...names]);
  process.env.PATH = stubDir;
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
});

/** L011 diagnostics for one verify command in a plan that sets up nothing. */
async function l011For(run: string, extra: { setup?: string[]; create?: string[] } = {}): Promise<string[]> {
  const repo = createTempRepo();
  const spec = sampleParsedTaskSpec({
    frontmatter: sampleTaskSpecFrontmatter({
      id: "T1",
      verify: [{ run, timeout_s: 10 }],
      ...(extra.create ? { create: extra.create } : {}),
    }),
  });
  const plan = sampleParsedPlan({
    manifest: sampleManifest({
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      setup: (extra.setup ?? []).map((run) => ({ run, timeout_s: 30 })),
    }),
    specs: [spec],
  });
  const diags = await ruleL011({ plan, repoRoot: repo, settings: sampleSettings(), options: {} } as any);
  return diags.map((d) => d.message);
}

describe("R11.1: the verify binary is the first command word", () => {
  it("the evidence table: each command yields its expected binary, and '-' yields none", () => {
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(verifyBinaryOf(r.cmd), r.cmd).toBe(r.bin);
    }
  });

  it("every evidence command passes L011 (no diagnostic) on a PATH that holds only the stubs", async () => {
    for (const r of rows) {
      expect(await l011For(r.cmd), r.cmd).toEqual([]);
    }
  });

  const synthetic: Array<[string, string | undefined]> = [
    ["FOO=1 node x.js", "node"],
    ['FOO="a b" BAR=$(echo hi) node x.js', "node"],
    ["d=$(mktemp -d) && node x", undefined],
    ["(cd a && node b)", undefined],
    ['bash -c "d=$(mktemp -d) && node x"', "bash"],
    ["env A=b node c", "env"],
    ["cd src && node --test", "cd"],
    ["node x | grep y", "node"],
    ["timeout 5 node x.js", "timeout"],
    ["`which node` --version", undefined],
    ['"node" x', undefined],
  ];
  it.each(synthetic)("%s names %s", (cmd, bin) => {
    expect(verifyBinaryOf(cmd)).toBe(bin);
  });

  it.each([
    ["FOO=1 node x.js"],
    ["d=$(mktemp -d) && node x"],
    ["(cd a && node b)"],
    ['bash -c "d=$(mktemp -d) && node x"'],
    ["env A=b node c"],
    ["cd src && node --test"],
    ["node x | grep y"],
  ])("L011 does not fire for %s", async (cmd) => {
    expect(await l011For(cmd)).toEqual([]);
  });

  it("the genuine missing binary still fires, and names the binary it looked for", async () => {
    const messages = await l011For("definitely-not-a-binary --x");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Verify binary 'definitely-not-a-binary' cannot be resolved on PATH");
  });

  it("a binary the plan's setup installs does not fire", async () => {
    expect(await l011For("made-by-setup --check", { setup: ["cp tools/x made-by-setup"] })).toEqual([]);
  });

  it("a binary named by a file the plan creates does not fire", async () => {
    expect(await l011For("made-by-task --check", { create: ["bin/made-by-task"] })).toEqual([]);
  });
});
