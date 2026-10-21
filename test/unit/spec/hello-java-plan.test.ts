import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lintPlan } from "../../../src/spec/linter.js";
import { parseManifest, parseTaskSpec, type ParsedPlan } from "../../../src/spec/parser.js";
import { sampleSettings } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// The plan of the real run r_R4DHU6I6DB37 ("make a hello world in java"), copied verbatim. Its
// integration_verify checks src/HelloWorld.java, which does not exist at the base commit; the
// run failed there before R7.11, after the worker had passed.
const FIXTURE = path.resolve(here, "../../fixtures/spec/hello-java-plan");

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

describe("R7.11: the hello-world plan that failed at the base check", () => {
  it("lints without errors", async () => {
    const plan = loadPlan(FIXTURE);
    const result = await lintPlan(plan, FIXTURE, sampleSettings());
    const errors = result.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`);
    expect(errors).toEqual([]);
  });
});
