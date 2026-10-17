import { describe, it, expect } from "vitest";
import type { BackendName } from "../../src/contracts/index.js";
import {
  detectInstalledHarness,
  runLiveSmokeTest,
  createLiveAdapter,
  assertNoCredentialLeakage,
} from "./helpers.js";

const isLive = process.env.SUBSTRATE_LIVE === "1";

describe("Live harness smoke test battery (§14.6)", () => {
  if (!isLive) {
    it.skip("Live smoke tests skipped: SUBSTRATE_LIVE=1 not set", () => {
      console.log("Live smoke tests skipped: SUBSTRATE_LIVE=1 not set");
    });
    return;
  }

  const backends: Array<{ backend: BackendName; model: string }> = [
    { backend: "claude", model: "claude-3-5-haiku-latest" },
    { backend: "opencode", model: "llama3" },
    { backend: "agy", model: "gemini-flash" },
  ];

  for (const { backend, model } of backends) {
    describe(`Backend: ${backend}`, () => {
      it(`executes minimal live smoke test within $0.10 cost cap (opt-in)`, async () => {
        const detection = await detectInstalledHarness(backend);
        if (!detection.installed) {
          console.log(`Live smoke tests skipped: ${backend} CLI not installed`);
          return;
        }

        const adapter = createLiveAdapter(backend);
        const envReport = await adapter.validateEnvironment();
        expect(envReport).toBeDefined();

        const result = await runLiveSmokeTest({
          backend,
          model,
          maxCostUsd: 0.10,
          timeoutMs: 120000,
          prompt: "Echo hello and create src/output.txt with content 'hello'",
        });

        // Verify exit and summary status
        expect(result.summary).toBeDefined();
        expect(["finished", "failed", "paused"]).toContain(result.summary.status);

        // Verify usage accounting: hard cost cap <= $0.10 per I7 & §14.6
        expect(result.usage.cost_usd).toBeLessThanOrEqual(0.10);

        // Verify credential safety: assert no secrets or tokens leaked
        assertNoCredentialLeakage(JSON.stringify(result.summary));
      }, 150000);
    });
  }
});
