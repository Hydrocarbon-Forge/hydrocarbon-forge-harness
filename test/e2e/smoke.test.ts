import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSubstrate } from "./helpers/run-substrate.js";

describe("E2E Smoke Tests", () => {
  it("full solo run edits a file, verifies it and finishes with exit 0", () => {
    const res = runSubstrate({
      settings: {
        git: { auto_merge: true },
      },
      files: {
        "src/a.txt": "one\n",
      },
      scenario: {
        calls: [
          {
            edits: { "src/a.txt": "one\ntwo\n" },
            reply: "DONE",
          },
        ],
      },
      args: [
        "run",
        "--mode",
        "solo",
        "--verify",
        "grep -q two src/a.txt",
        "add a line two to src/a.txt",
      ],
    });

    try {
      expect(res.exitCode).toBe(0);
      const finishEv = [...res.events].reverse().find((e) => e.type === "run.finished");
      expect(finishEv).toBeDefined();
      expect((finishEv?.data as any)?.exit_code).toBe(0);
      expect(readFileSync(join(res.repoDir, "src/a.txt"), "utf8")).toBe("one\ntwo\n");
    } finally {
      res.cleanup();
    }
  });

  it("node dist/substrate.mjs --help exits 0 and prints usage", () => {
    const res = runSubstrate({
      args: ["--help"],
    });

    try {
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Usage");
    } finally {
      res.cleanup();
    }
  });
});
