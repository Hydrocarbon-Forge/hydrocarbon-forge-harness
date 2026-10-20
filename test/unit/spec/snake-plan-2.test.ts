import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lintPlan } from "../../../src/spec/linter.js";
import { parseManifest, parseTaskSpec, type ParsedPlan } from "../../../src/spec/parser.js";
import { sampleSettings } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// The attempt-2 drafts of run r_XDZHITGE25FD ("make a snake game"), copied verbatim
// except for the planner request, which is not kept.
const FIXTURE = path.resolve(here, "../../fixtures/spec/snake-plan-2");

function loadPlan(runDir: string): ParsedPlan {
  const manifestPath = path.join(runDir, "manifest.yaml");
  const rawManifest = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(rawManifest, manifestPath);
  const specs = new Map();
  for (const task of manifest.tasks) {
    specs.set(task.id, parseTaskSpec(fs.readFileSync(path.resolve(runDir, task.spec), "utf8"), task.spec));
  }
  return { manifest, specs, rawManifest, manifestPath };
}

describe("R7.7: the snake plan that the attempt-1 lints rejected", () => {
  it("lints without errors, and with no L012, L015 or L016 diagnostic", async () => {
    const plan = loadPlan(FIXTURE);
    const result = await lintPlan(plan, FIXTURE, sampleSettings());
    const errors = result.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`);
    expect(errors).toEqual([]);
    const attemptOneCodes = result.diagnostics.filter((d) => ["L012", "L015", "L016"].includes(d.code));
    expect(attemptOneCodes).toEqual([]);
  });
});
