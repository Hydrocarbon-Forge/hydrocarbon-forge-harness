import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";

import * as Contracts from "../../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../../src/config/index.js";

export interface RouteRequestOptions {
  prompt: string;
  flags?: { mode?: "auto" | "solo" | "plan"; noGovernor?: boolean };
  settings: Contracts.Settings;
  repoRoot?: string;
}

export interface RouteOutcomeRecord {
  run_id: Contracts.RunId;
  task_id?: Contracts.TaskId;
  decision: Contracts.RoutingDecision;
  rule_matched: "flag" | "deterministic" | "governor" | "fallback";
  outcome?: "passed" | "failed" | "healed" | "replanned";
  cost_usd?: number;
  duration_ms?: number;
  timestamp: string;
}

const {
  routeRequest,
  resolveTaskRoute,
  appendRouteOutcome,
} = (await import("../../../src/roles/router.js" as any)) as {
  routeRequest: (opts: RouteRequestOptions) => Promise<Contracts.RoutingDecision>;
  resolveTaskRoute: (
    taskClass: Contracts.TaskClass,
    generation: number,
    settings: Contracts.Settings,
  ) => Contracts.Route;
  appendRouteOutcome: (record: RouteOutcomeRecord, ledgerDir?: string) => Promise<void>;
};

describe("Rules-First Router (src/roles/router.ts)", () => {
  let tempDir: string;
  let activeServer: http.Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "router-test-"));
  });

  afterEach(async () => {
    if (activeServer) {
      await new Promise((resolve) => activeServer!.close(resolve));
      activeServer = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeSettings(overrides: Partial<Contracts.Settings> = {}): Contracts.Settings {
    return {
      ...DEFAULT_SETTINGS,
      roles: {
        planner: { backend: "claude", model: "claude-sonnet-5-5", effort: "medium" },
        governor: {
          enabled: false,
          endpoint: "http://127.0.0.1:8080/v1",
          enable_thinking: false,
          timeout_s: 10,
        },
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
        expect(decision.rationale).toMatch(/explicit.*solo/i);
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
        expect(decision.rationale).toMatch(/explicit.*plan/i);
      });

      it("bypasses governor LLM when flags.noGovernor === true and falls to deterministic or fallback", async () => {
        const decision = await routeRequest({
          prompt: "Implement complex caching layer",
          flags: { noGovernor: true },
          settings: makeSettings({
            roles: {
              ...makeSettings().roles,
              governor: {
                enabled: true,
                endpoint: "http://127.0.0.1:8080/v1",
                enable_thinking: false,
                timeout_s: 10,
              },
            },
          }),
          repoRoot: tempDir,
        });

        // Bypassed governor, no deterministic match, falls to default plan
        expect(decision.mode).toBe("plan");
        expect(decision.rationale).toMatch(/default plan fallback/i);
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
          expect(decision.rationale).toMatch(/deterministic match/i);
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
        expect(decision.rationale).toMatch(/default plan fallback/i);
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

    describe("Step 3: Governor LLM", () => {
      it("calls governor intake when enabled and reachable, adopting its routing decision", async () => {
        let serverCalled = false;
        const server = http.createServer((req, res) => {
          serverCalled = true;
          if (req.url === "/health" || req.url === "/v1/models") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      mode: "solo",
                      task_class: "debug",
                      rationale: "Governor routed as localized debugging task",
                    }),
                  },
                },
              ],
            }),
          );
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        activeServer = server;
        const addr = server.address() as AddressInfo;
        const endpoint = `http://127.0.0.1:${addr.port}`;

        const decision = await routeRequest({
          prompt: "Investigate intermittent test failure in scheduler",
          settings: makeSettings({
            roles: {
              ...makeSettings().roles,
              governor: {
                enabled: true,
                endpoint,
                enable_thinking: false,
                timeout_s: 10,
              },
            },
          }),
          repoRoot: tempDir,
        });

        expect(serverCalled).toBe(true);
        expect(decision.mode).toBe("solo");
        expect(decision.task_class).toBe("debug");
        expect(decision.rationale).toBe("Governor routed as localized debugging task");
      });

      it("smoothly falls through to default plan fallback when governor is unreachable (A9, §6.3)", async () => {
        const decision = await routeRequest({
          prompt: "Build dashboard UI",
          settings: makeSettings({
            roles: {
              ...makeSettings().roles,
              governor: {
                enabled: true,
                endpoint: "http://127.0.0.1:59998", // unreachable port
                enable_thinking: false,
                timeout_s: 1,
              },
            },
          }),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
        expect(decision.rationale).toMatch(/default plan fallback/i);
      });

      it("smoothly falls through to default plan fallback when governor times out", async () => {
        const server = http.createServer(() => {
          // Hang
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        activeServer = server;
        const addr = server.address() as AddressInfo;
        const endpoint = `http://127.0.0.1:${addr.port}`;

        const decision = await routeRequest({
          prompt: "Build dashboard UI",
          settings: makeSettings({
            roles: {
              ...makeSettings().roles,
              governor: {
                enabled: true,
                endpoint,
                enable_thinking: false,
                timeout_s: 0.05, // very short timeout
              },
            },
          }),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
        expect(decision.rationale).toMatch(/default plan fallback/i);
      });
    });

    describe("Step 4: Default Fallback", () => {
      it("returns default plan routing when no earlier rules match", async () => {
        const decision = await routeRequest({
          prompt: "Implement complex microservice architecture",
          settings: makeSettings({
            roles: {
              ...makeSettings().roles,
              governor: { enabled: false, endpoint: "", enable_thinking: false, timeout_s: 10 },
            },
          }),
          repoRoot: tempDir,
        });

        expect(decision.mode).toBe("plan");
        expect(decision.planner_route).toBe("default");
        expect(decision.rationale).toMatch(/default plan fallback/i);
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

  describe("Route-to-Outcome Ledger (appendRouteOutcome)", () => {
    it("appends RouteOutcomeRecord as valid JSON line to ledger file", async () => {
      const ledgerDir = join(tempDir, "ledger");
      const record: RouteOutcomeRecord = {
        run_id: "r_ABCDEF234567",
        task_id: "T1",
        decision: {
          mode: "solo",
          task_class: "mechanical",
          rationale: "Deterministic single file match",
        },
        rule_matched: "deterministic",
        outcome: "passed",
        cost_usd: 0.005,
        duration_ms: 1250,
        timestamp: new Date().toISOString(),
      };

      await appendRouteOutcome(record, ledgerDir);

      const ledgerFile = join(ledgerDir, "routes.jsonl");
      expect(existsSync(ledgerFile)).toBe(true);

      const content = readFileSync(ledgerFile, "utf8").trim();
      const lines = content.split("\n");
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.run_id).toBe(record.run_id);
      expect(parsed.task_id).toBe("T1");
      expect(parsed.rule_matched).toBe("deterministic");
      expect(parsed.outcome).toBe("passed");
      expect(parsed.cost_usd).toBe(0.005);
    });

    it("appends multiple records consecutively without corruption", async () => {
      const ledgerDir = join(tempDir, "ledger");
      const record1: RouteOutcomeRecord = {
        run_id: "r_ABCDEF234567",
        decision: { mode: "plan", rationale: "Default fallback" },
        rule_matched: "fallback",
        timestamp: new Date().toISOString(),
      };
      const record2: RouteOutcomeRecord = {
        run_id: "r_ABCDEF234567",
        task_id: "T1",
        decision: { mode: "solo", rationale: "Flag" },
        rule_matched: "flag",
        outcome: "failed",
        timestamp: new Date().toISOString(),
      };

      await appendRouteOutcome(record1, ledgerDir);
      await appendRouteOutcome(record2, ledgerDir);

      const ledgerFile = join(ledgerDir, "routes.jsonl");
      const content = readFileSync(ledgerFile, "utf8").trim();
      const lines = content.split("\n");
      expect(lines.length).toBe(2);

      expect(JSON.parse(lines[0]).rule_matched).toBe("fallback");
      expect(JSON.parse(lines[1]).rule_matched).toBe("flag");
    });
  });
});
