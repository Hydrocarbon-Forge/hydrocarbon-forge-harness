import { describe, it, expect } from "vitest";
import { runSubstrate } from "./helpers/run-substrate.js";

// R6.7: settings keys that nothing read were removed from the strict schema. A settings file
// that still holds one must fail the load with exit 2 and name the key. A file without them runs.
describe("removed settings keys through the built CLI", () => {
  const removed: Array<[string, Record<string, unknown>]> = [
    ["git.branch_prefix", { git: { branch_prefix: "substrate/" } }],
    ["sandbox.network", { sandbox: { network: "deny" } }],
    ["hooks", { hooks: { stop: [{ command: "true" }] } }],
  ];

  for (const [key, settings] of removed) {
    it(`a settings file with ${key} exits 2 and names the key`, () => {
      const res = runSubstrate({ args: ["config", "get", "git.auto_merge"], settings });
      try {
        expect(res.exitCode).toBe(2);
        expect(res.stderr).toContain(key.split(".").pop() as string);
      } finally {
        res.cleanup();
      }
    });
  }

  it("a settings file without the removed keys still reads a key with exit 0", () => {
    const res = runSubstrate({ args: ["config", "get", "git.auto_merge"] });
    try {
      expect(res.exitCode).toBe(0);
      // R10.1: the default of git.auto_merge is true.
      expect(res.stdout).toContain("true");
    } finally {
      res.cleanup();
    }
  });
});
