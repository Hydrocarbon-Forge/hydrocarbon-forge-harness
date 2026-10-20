// Live smoke (G5). Env: SUBSTRATE_LIVE=1 to run; SUBSTRATE_LIVE_RECORDS overrides the record file;
// SUBSTRATE_LIVE_MODEL_<HARNESS> (for example SUBSTRATE_LIVE_MODEL_OPENCODE) names the model for one harness and must be priced.
// SUBSTRATE_LIVE_OPENCODE_BASE_URL is required when that opencode model is a local llama.cpp route.
import { beforeAll, describe, expect, it } from "vitest";

import { createAdapters } from "../../src/backends/registry.js";
import { pricingTableFor } from "../../src/backends/pricing.js";
import {
  appendRecord,
  failureDetail,
  LIVE_HARNESSES,
  liveLocalSettings,
  liveModelOverride,
  pickPricedModel,
  probeSettings,
  requirePricedOverride,
  RUN_CAP_USD,
  runLive,
  type LiveHarness,
  type LiveRecord,
} from "./helpers.js";

const isLive = process.env.SUBSTRATE_LIVE === "1";

function record(partial: Pick<LiveRecord, "harness" | "status"> & Partial<LiveRecord>): LiveRecord {
  return {
    version: "unknown",
    model: "-",
    run_id: "-",
    exit_code: null,
    cost_usd: 0,
    ts: new Date().toISOString(),
    ...partial,
  };
}

describe("live smoke: one plan-mode run per installed harness (G5)", () => {
  for (const harness of LIVE_HARNESSES) {
    describe(harness, () => {
      if (!isLive) {
        beforeAll(() => {
          appendRecord(record({ harness, status: "skipped" }));
        });

        it("runs only with SUBSTRATE_LIVE=1", (ctx) => {
          ctx.skip();
        });
        return;
      }

      it(
        `runs a capped plan-mode run on the toy repo (${harness})`,
        async (ctx) => {
          const settings = await probeSettings();
          const adapter = createAdapters(settings)[harness as LiveHarness];

          // Behavior 1: a harness that does not validate is not installed and is not tested.
          const env = await adapter.validateEnvironment();
          if (!env.ok || env.version === undefined) {
            ctx.skip();
          }
          const version = env.version as string;

          // Edge case: the pin is checked before any model call or model listing.
          const pin = settings.backends?.[harness]?.version_pin ?? adapter.capabilities.version_pin;
          // Both checks: the installed version must equal the configured pin, and the adapter's own
          // comparison must agree (agy compares against its built-in pin and ignores backends.agy.version_pin).
          if (version !== pin || !env.pin_matches) {
            appendRecord(record({ harness, status: "failed", version }));
            expect.fail(
              `${harness} ${version} does not match its version_pin ${pin}; no model call was made`,
            );
          }

          // Behavior 2: the model. An SUBSTRATE_LIVE_MODEL_<HARNESS> override is used as named
          // (no listing) and must be priced. Otherwise the cheapest listed model, from the price
          // table. Both fail before any run when unpriced; the listing path also fails when empty.
          const pricing = pricingTableFor(settings);
          const override = liveModelOverride(harness);
          const model =
            override !== undefined
              ? requirePricedOverride(harness as LiveHarness, override, pricing.models, version)
              : pickPricedModel(
                  harness as LiveHarness,
                  adapter.listModels ? await adapter.listModels() : [],
                  pricing.models,
                  version,
                ).id;

          // Behavior 3 and 4: the built CLI, plan mode, the caps in settings. The run gets the
          // same price table as the pick, so the picked model's cost is known.
          // A local-route opencode model needs its endpoint in settings.local.json (see liveLocalSettings).
          const localSettings = liveLocalSettings(harness as LiveHarness, model, version);
          const result = runLive(harness as LiveHarness, model, pricing, localSettings);

          appendRecord({
            harness,
            version,
            model,
            run_id: result.runId ?? "-",
            status: result.passed ? "passed" : "failed",
            exit_code: result.exitCode,
            cost_usd: result.costUsd,
            ts: new Date().toISOString(),
          });

          const detail = failureDetail(result);
          expect(result.exitCode, (result.stderr || result.stdout) + detail).toBe(0);
          expect(result.status, detail).toBe("finished");
          expect(result.costKnown, "a ledger row has an unknown cost" + detail).toBe(true);
          expect(result.costUsd, detail).toBeLessThanOrEqual(RUN_CAP_USD);
        },
        700_000,
      );
    });
  }
});
