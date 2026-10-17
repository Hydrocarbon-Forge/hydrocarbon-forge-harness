import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BackendName,
  HarnessAdapter,
  Manifest,
  RunId,
  RunSummary,
  UsageRecord,
} from "../../src/contracts/index.js";
import { DEFAULT_SETTINGS } from "../../src/config/index.js";
import { ClaudeAdapter } from "../../src/backends/adapters/claude.js";
import { OpenCodeAdapter } from "../../src/backends/adapters/opencode.js";
import { AgyAdapter } from "../../src/backends/adapters/agy.js";
import { FakeAdapter } from "../conformance/fake-adapter.js";
import { createEngine } from "../../src/engine/engine.js";
import { createTestRepo } from "../integration/git/test-repo.js";
import { writePlanFiles } from "../integration/scenarios/helpers.js";
import { sampleValidManifest, sampleValidTaskSpecMarkdown } from "../integration/roles/fixtures.js";

const execFileAsync = promisify(execFile);

export interface LiveSmokeOptions {
  backend: BackendName;
  model: string;
  maxCostUsd: number;
  timeoutMs: number;
  prompt: string;
}

export async function detectInstalledHarness(
  backend: BackendName
): Promise<{ installed: boolean; version?: string }> {
  let bin = "";
  if (backend === "claude") {
    bin = process.env.CLAUDE_BIN ?? "claude";
  } else if (backend === "opencode") {
    bin = process.env.OPENCODE_BIN ?? "opencode";
  } else if (backend === "agy") {
    bin = process.env.AGY_BIN ?? "agy";
  } else if (backend === "fake") {
    return { installed: true, version: "1.0.0" };
  } else {
    return { installed: false };
  }

  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 3000 });
    const versionMatch = stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    return {
      installed: true,
      version: versionMatch ? versionMatch[1] : stdout.trim(),
    };
  } catch {
    return { installed: false };
  }
}

export function assertNoCredentialLeakage(content: string): void {
  const secretPatterns = [
    /sk-[a-zA-Z0-9_-]{20,}/i,
    /ghp_[a-zA-Z0-9]{30,}/i,
    /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/i,
    /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"]/i,
    /token\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"]/i,
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Credential leakage detected matching pattern ${pattern}`);
    }
  }
}

export function createLiveAdapter(backend: BackendName): HarnessAdapter {
  switch (backend) {
    case "claude":
      return new ClaudeAdapter();
    case "opencode":
      return new OpenCodeAdapter();
    case "agy":
      return new AgyAdapter({
        pricing: {
          asOf: "2026-10-01",
          sources: ["https://example.com/pricing"],
          models: {},
        },
      });
    case "fake":
    default:
      return new FakeAdapter();
  }
}

export async function runLiveSmokeTest(
  opts: LiveSmokeOptions
): Promise<{ summary: RunSummary; usage: UsageRecord }> {
  // Hard budget guardrail enforcement per I7 & §14.6
  const maxUsd = Math.min(opts.maxCostUsd, 0.10);
  const timeoutMs = Math.min(opts.timeoutMs, 120000); // 2 minutes

  const testRepo = createTestRepo(`sub-live-${opts.backend}-`);
  const repoRoot = testRepo.dir;
  const runId: RunId = "r_LIVEAAAA2222";

  try {
    const manifest: Manifest = {
      ...sampleValidManifest(runId),
      tasks: [{ id: "T1", spec: "tasks/T1.md" }],
      integration_verify: [{ run: "echo live smoke pass", timeout_s: 30 }],
    };

    const taskSpec = sampleValidTaskSpecMarkdown({
      frontmatter: {
        id: "T1",
        title: "Live Smoke Task",
        depends_on: [],
        write: ["src/output.txt"],
        create: [],
        verify: [{ run: "test -f src/output.txt", timeout_s: 30 }],
        budget: {
          max_usd: maxUsd,
          timeout_min: Math.ceil(timeoutMs / 60000),
        },
      },
    });

    writePlanFiles(repoRoot, runId, manifest, { "tasks/T1.md": taskSpec });

    const adapter = createLiveAdapter(opts.backend);
    const engine = createEngine({ adapter });

    const summary = await engine.run({
      cwd: repoRoot,
      prompt: opts.prompt,
      mode: "plan",
      permission_mode: "bypassPermissions",
      overrides: {
        budgets: {
          ...DEFAULT_SETTINGS.budgets,
          run: { max_usd: maxUsd },
          task: { max_usd: maxUsd, timeout_min: 2 },
        },
        routing: {
          ...DEFAULT_SETTINGS.routing,
          feature: { backend: opts.backend, model: opts.model, effort: "low" },
        },
      },
    });

    // Verify credential safety in event log
    const eventsPath = join(repoRoot, ".substrate", "runs", runId, "events.jsonl");
    if (existsSync(eventsPath)) {
      const eventLogContent = readFileSync(eventsPath, "utf8");
      assertNoCredentialLeakage(eventLogContent);
    }

    const usage: UsageRecord = {
      backend: opts.backend,
      model: opts.model,
      input_tokens: summary.usage.total_usd > 0 ? 100 : 0,
      output_tokens: 50,
      cost_usd: summary.usage.total_usd,
      cost_source: "reported",
      at: new Date().toISOString(),
    };

    return { summary, usage };
  } finally {
    testRepo.cleanup();
  }
}
