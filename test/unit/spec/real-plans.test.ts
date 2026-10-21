import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { ingestPlanDraft } from "../../../src/roles/planner.js";
import { createTempRepo } from "./fixtures.js";

// R12.3: the plans the planner really wrote in the owner's runs are lint fixtures. None of them has a
// blocker: each one is accepted by the same ingest the planner and a resume use. Each fixture is copied to
// a temporary run directory first, so the contract typecheck it names never runs inside the fixture tree.

const FIXTURES = resolve(__dirname, "../../fixtures/spec/real-plans");

describe("R12.3: real plans lint with no blocker", () => {
  const plans = readdirSync(FIXTURES).sort();

  it("the fixture set holds the 13 real plans of the owner's runs", () => {
    expect(plans.length).toBe(13);
  });

  it.each(plans)("%s is accepted by the ingest (no blocking diagnostic)", async (name) => {
    const runDir = mkdtempSync(join(tmpdir(), "substrate-real-plan-"));
    cpSync(join(FIXTURES, name), runDir, { recursive: true });
    const repo = createTempRepo();
    const res = await ingestPlanDraft({ runDir, repoRoot: repo, settings: DEFAULT_SETTINGS });
    expect(res.ok, res.ok ? "" : res.diagnostics.join("\n")).toBe(true);
  });
});
