import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lintPlan } from "../../../src/spec/linter.js";
import { parseManifest, parseTaskSpec, type ParsedPlan } from "../../../src/spec/parser.js";
import { sampleSettings } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../fixtures/spec/snake-plan");

// Loads a saved plan the same way the planner-retry loop does (roles/planner.ts),
// then runs the linter. No model is called.
function loadPlan(runDir: string): ParsedPlan {
  const manifestPath = path.join(runDir, "manifest.yaml");
  const rawManifest = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(rawManifest, manifestPath);
  const specs = new Map();
  for (const task of manifest.tasks) {
    const specPath = path.resolve(runDir, task.spec);
    const rawSpec = fs.readFileSync(specPath, "utf8");
    specs.set(task.id, parseTaskSpec(rawSpec, task.spec));
  }
  return { manifest, specs, rawManifest, manifestPath };
}

describe("planner lint of a saved plan", () => {
  it("the planner plan saved from run r_CQ4REXLQOAJM lints without errors", async () => {
    // The fixture directory is the repository root the lint resolves spec and contract paths against.
    const plan = loadPlan(FIXTURE);
    const result = await lintPlan(plan, FIXTURE, sampleSettings());
    const errors = result.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`);
    expect(errors).toEqual([]);
  });
});
