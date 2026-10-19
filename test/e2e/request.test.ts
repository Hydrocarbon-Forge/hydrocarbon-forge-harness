import { describe, it, expect } from "vitest";
import { runSubstrate } from "./helpers/run-substrate.js";

describe("Run request E2E (R4.1)", () => {
  it("runs with a valid request file in solo mode and finishes with exit 0", () => {
    const requestJson = JSON.stringify({
      goal: "create feature.txt",
      mode: "solo",
      worker: {
        provider: "claude",
        model: "claude-sonnet-5-5",
      },
      verify: ["test -f feature.txt"],
    });

    const res = runSubstrate({
      files: {
        "request.json": requestJson,
      },
      scenario: {
        calls: [
          {
            edits: { "feature.txt": "created\n" },
            reply: "DONE",
          },
        ],
      },
      args: ["run", "--request", "request.json"],
    });

    try {
      expect(res.exitCode).toBe(0);
      const finishEv = [...res.events].reverse().find((e) => e.type === "run.finished");
      expect(finishEv).toBeDefined();
      expect((finishEv?.data as any)?.exit_code).toBe(0);
    } finally {
      res.cleanup();
    }
  });

  it("runs with an unknown model and exits 2 with invalid_request JSON on stdout", () => {
    const badRequestJson = JSON.stringify({
      goal: "create feature.txt",
      mode: "solo",
      worker: {
        provider: "claude",
        model: "unknown-fake-model-12345",
      },
    });

    const res = runSubstrate({
      files: {
        "request.json": badRequestJson,
      },
      args: ["run", "--request", "request.json"],
    });

    try {
      expect(res.exitCode).toBe(2);
      expect(res.stdout).toContain("invalid_request");
      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.error).toBe("invalid_request");
      expect(parsed.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "worker.model",
            message: "unknown model 'unknown-fake-model-12345'",
          }),
        ])
      );
    } finally {
      res.cleanup();
    }
  });
});
