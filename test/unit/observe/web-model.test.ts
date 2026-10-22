import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { artifactIndexOf, artifactKeyOf, artifactOfKey } from "../../../src/observe/artifacts.js";
import { engineSliceOf } from "../../../src/observe/engine-slice.js";
import { parseRef } from "../../../src/observe/runs-view.js";
import { LineTailer } from "../../../src/observe/tail.js";
import { transcriptSliceOf } from "../../../src/observe/transcripts.js";
import { fileOfRequest } from "../../../src/web/static.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "runs");

describe("web read model (design section 5)", () => {
  it("slices the engine journal by seq from a fixture, and reports completeness from the live flag", () => {
    const runDir = mkdtempSync(join(tmpdir(), "substrate-web-engine-"));
    copyFileSync(join(FIXTURES, "failed-partial.events.jsonl"), join(runDir, "events.jsonl"));
    const seqs = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    const last = seqs[seqs.length - 1];

    const page = engineSliceOf(runDir, "r_FAILEDRUN234", 2, 2, false);
    expect(page.events.map((e) => e.seq)).toEqual(seqs.filter((s) => s > 2).slice(0, 2));
    expect(page.next).toBe(page.events[page.events.length - 1].seq);
    expect(page.complete).toBe(false);

    const all = engineSliceOf(runDir, "r_FAILEDRUN234", 0, 1000, false);
    expect(all.next).toBe(last);
    expect(all.complete).toBe(true);
    expect(engineSliceOf(runDir, "r_FAILEDRUN234", 0, 1000, true).complete).toBe(false);
  });

  it("names artifacts only by opaque keys of files the run lists; a file outside the listing has no key", () => {
    const runDir = mkdtempSync(join(tmpdir(), "substrate-web-artifacts-"));
    mkdirSync(join(runDir, "packets", "verify"), { recursive: true });
    mkdirSync(join(runDir, "tasks"), { recursive: true });
    writeFileSync(join(runDir, "packets", "verify", "T1-g1-attempt1-0.out"), "all passed\n");
    writeFileSync(join(runDir, "packets", "T1-g1-attempt1.json"), "{}");
    writeFileSync(join(runDir, "tasks", "T1.md"), "# T1\n");
    writeFileSync(join(runDir, "secret.txt"), "not a run artifact");

    const index = artifactIndexOf(runDir);
    const verify = index.find((e) => e.path === join("packets", "verify", "T1-g1-attempt1-0.out"));
    expect(verify?.kind).toBe("verify_full");
    expect(verify?.label).toBe("verify output, task T1 g1 a1, command 1");
    expect(verify?.key).toBe(artifactKeyOf(join("packets", "verify", "T1-g1-attempt1-0.out")));
    expect(artifactOfKey(runDir, verify?.key ?? "")?.path).toBe(join("packets", "verify", "T1-g1-attempt1-0.out"));

    expect(artifactOfKey(runDir, artifactKeyOf("secret.txt"))).toBeUndefined();
    expect(artifactOfKey(runDir, "0".repeat(24))).toBeUndefined();
  });

  it("serves only files under the web root: no traversal, no listing, no symlink out", () => {
    const base = mkdtempSync(join(tmpdir(), "substrate-web-static-"));
    const root = join(base, "web");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    writeFileSync(join(base, "outside.txt"), "outside");

    expect(fileOfRequest(root, "/")).toBe(join(root, "index.html"));
    expect(fileOfRequest(root, "/assets/index.html")).toBe(join(root, "index.html"));
    expect(fileOfRequest(root, "/assets/../outside.txt")).toBeUndefined();
    expect(fileOfRequest(root, "/assets/%2e%2e/outside.txt")).toBeUndefined();
    expect(fileOfRequest(root, "/assets/%2e%2e%2foutside.txt")).toBeUndefined();
    expect(fileOfRequest(root, "/assets/")).toBeUndefined();
    expect(fileOfRequest(root, "/assets/%00index.html")).toBeUndefined();
    expect(fileOfRequest(root, "/other.html")).toBeUndefined();
  });

  it("keeps a torn last line back until its newline is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "substrate-web-tail-"));
    const file = join(dir, "events.jsonl");
    writeFileSync(file, '{"a":1}\n{"b"');
    const tailer = new LineTailer(file);
    expect(tailer.read()).toEqual(['{"a":1}']);
    writeFileSync(file, '{"a":1}\n{"b":2}\n', { flag: "w" });
    expect(tailer.read()).toEqual(['{"b":2}']);
  });

  it("numbers transcript lines from the header and pages them by index", () => {
    const runDir = mkdtempSync(join(tmpdir(), "substrate-web-transcript-"));
    mkdirSync(join(runDir, "transcripts"));
    const file = join(runDir, "transcripts", "sess-1.jsonl");
    const header = { type: "header", v: 1, session: "sess-1", role: "worker", task_id: "T1", generation: 1, attempt: 1, backend: "claude", model: "haiku", started_at: "2026-10-22T10:00:00.000Z" };
    const line = (text: string) => JSON.stringify({ ts: "2026-10-22T10:00:01.000Z", event: { type: "assistant.text", text } });
    writeFileSync(file, [JSON.stringify(header), line("a"), line("b"), line("c")].join("\n") + "\n");

    const first = transcriptSliceOf(file, -1, 2, false);
    expect(first.lines.map((l) => l.index)).toEqual([0, 1]);
    expect(first.lines[0].header?.session).toBe("sess-1");
    expect(first.next).toBe(1);
    expect(first.complete).toBe(false);

    const rest = transcriptSliceOf(file, 1, 10, false);
    expect(rest.lines.map((l) => l.index)).toEqual([2, 3]);
    expect(rest.complete).toBe(true);
  });

  it("parses only a ref of two plain identifiers", () => {
    expect(parseRef("3f9a0c1b2d4e~r_ABC123")).toEqual({ projectId: "3f9a0c1b2d4e", runId: "r_ABC123" });
    expect(parseRef("a/../b~c")).toBeUndefined();
    expect(parseRef("a~b~c")).toBeUndefined();
    expect(parseRef("~b")).toBeUndefined();
    expect(parseRef("noseparator")).toBeUndefined();
  });
});
