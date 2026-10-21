import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";

export interface RouteRequestOptions {
  prompt: string;
  flags?: { mode?: "auto" | "solo" | "plan"; planner?: boolean };
  settings: Contracts.Settings;
  repoRoot?: string;
}

const {
  routeRequest,
  resolveTaskRoute,
} = (await import("../../../src/roles/router.js" as any)) as {
  routeRequest: (opts: RouteRequestOptions) => Promise<Contracts.RoutingDecision>;
  resolveTaskRoute: (
    taskClass: Contracts.TaskClass,
    generation: number,
    settings: Contracts.Settings,
  ) => Contracts.Route;
};

describe("Rules-First Router (src/roles/router.ts)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "router-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeSettings(overrides: Partial<Contracts.Settings> = {}): Contracts.Settings {
    return {
      ...DEFAULT_SETTINGS,
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      },
      routing: {
        feature: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        mechanical: { backend: "claude", model: "claude-haiku-5-5", effort: "low" },
        escalation: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
      },
      ...overrides,
    };
  }

  describe("Decision Priority (routeRequest)", () => {
    describe("Step 1: Explicit Flags", () => {
      it("returns solo decision when flags.mode === 'solo' regardless of prompt", async () => {
        const decision = await routeRequest({
          prompt: "Build an entire distributed consensus engine",
          flags: { mode: "solo" },
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("solo");
        expect(decision.rationale).toBe("explicit mode flag");
      });

      it("returns plan decision when flags.mode === 'plan' even if prompt is mechanical", async () => {
        // Create file so deterministic rule would have matched if not for flag
        writeFileSync(join(tempDir, "utils.ts"), "export const x = 1;");

        const decision = await routeRequest({
          prompt: "fix typo in utils.ts",
          flags: { mode: "plan" },
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
        expect(decision.rationale).toBe("explicit mode flag");
      });

      it("routes a mechanical named-file request to solo in auto mode; a named planner no longer forces plan (R7.2 supersedes R6.4)", async () => {
        writeFileSync(join(tempDir, "utils.ts"), "export const x = 1;");

        const decision = await routeRequest({
          prompt: "fix typo in utils.ts",
          flags: { mode: "auto" },
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("solo");
        expect(decision.task_class).toBe("mechanical");
      });

    });

    describe("Step 2: Deterministic Rules (Named single existing file + mechanical verb)", () => {
      const MECHANICAL_VERBS = [
        "rename",
        "move",
        "delete",
        "remove",
        "bump",
        "format",
        "typo",
        "fix typo",
        "update dependency",
      ];

      it.each(MECHANICAL_VERBS)(
        "matches deterministic rule for verb '%s' and single existing file -> solo/mechanical",
        async (verb) => {
          writeFileSync(join(tempDir, "config.json"), "{}");

          const prompt = `${verb} config.json`;
          const decision = await routeRequest({
            prompt,
            settings: makeSettings(),
            repoRoot: tempDir,
          });

          expect(decision.mode).toBe("solo");
          expect(decision.task_class).toBe("mechanical");
          expect(decision.rationale).toBe("mechanical edit of a named file");
        },
      );

      it("does not match deterministic rule when named file does NOT exist in repo", async () => {
        const decision = await routeRequest({
          prompt: "rename nonexistent_file.ts to something_else.ts",
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        // Falls through to default fallback
        expect(decision.mode).toBe("plan");
        expect(decision.rationale).toBe("request is not a mechanical edit of a named file");
      });

      it("does not match deterministic rule when multiple files are mentioned", async () => {
        writeFileSync(join(tempDir, "fileA.ts"), "");
        writeFileSync(join(tempDir, "fileB.ts"), "");

        const decision = await routeRequest({
          prompt: "format fileA.ts and fileB.ts",
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
      });

      it("does not match deterministic rule when verb is non-mechanical", async () => {
        writeFileSync(join(tempDir, "auth.ts"), "");

        const decision = await routeRequest({
          prompt: "refactor and redesign architecture of auth.ts",
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
      });

      it("does not match deterministic rule when mechanical verb is present but no file is named", async () => {
        const decision = await routeRequest({
          prompt: "fix typo across codebase",
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
      });
    });

    describe("Step 3: Default Fallback", () => {
      it("returns default plan routing when no earlier rules match", async () => {
        const decision = await routeRequest({
          prompt: "Implement complex microservice architecture",
          settings: makeSettings(),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
        expect(decision.planner_route).toBe("default");
        expect(decision.rationale).toBe("request is not a mechanical edit of a named file");
      });
    });
  });

  describe("Route Resolution and Escalation (resolveTaskRoute)", () => {
    it("resolves generation 1 task route from configured settings.routing", () => {
      const settings = makeSettings();

      const mechanicalRoute = resolveTaskRoute("mechanical", 1, settings);
      expect(mechanicalRoute.model).toBe("claude-haiku-5-5");
      expect(mechanicalRoute.effort).toBe("low");

      const featureRoute = resolveTaskRoute("feature", 1, settings);
      expect(featureRoute.model).toBe("claude-sonnet-5-5");
      expect(featureRoute.effort).toBe("medium");
    });

    it("advances model to next tier along escalation chain for generation >= 2", () => {
      const settings = makeSettings();

      // Generation 2 advances from haiku to sonnet
      const g2Route = resolveTaskRoute("mechanical", 2, settings);
      expect(g2Route.model).toBe("claude-sonnet-5-5");

      // Generation 3 advances to opus
      const g3Route = resolveTaskRoute("mechanical", 3, settings);
      expect(g3Route.model).toBe("claude-opus-5-5");
    });

    it("clamps model at top tier when generation exceeds escalation chain length without error", () => {
      const settings = makeSettings();

      const g4Route = resolveTaskRoute("mechanical", 4, settings);
      expect(g4Route.model).toBe("claude-opus-5-5");

      const g10Route = resolveTaskRoute("mechanical", 10, settings);
      expect(g10Route.model).toBe("claude-opus-5-5");
    });

    it("supports local provider routing entry (opencode + llama.cpp)", () => {
      const settings = makeSettings({
        routing: {
          mechanical: { backend: "opencode", model: "llama-3.1-8b", effort: "low" },
          feature: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
          escalation: ["llama-3.1-8b", "claude-sonnet-5-5", "claude-opus-5-5"],
        },
      });

      const localRoute = resolveTaskRoute("mechanical", 1, settings);
      expect(localRoute.backend).toBe("opencode");
      expect(localRoute.model).toBe("llama-3.1-8b");
    });
  });
});
