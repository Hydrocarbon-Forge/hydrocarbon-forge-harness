import type {
  BackendName,
  HarnessAdapter,
  Settings,
} from "../contracts/index.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { AgyAdapter } from "./adapters/agy.js";
import { pricingTableFor } from "./pricing.js";

export type AdapterMap = Partial<Record<BackendName, HarnessAdapter>>;

export function createAdapters(
  settings: Settings
): Record<"claude" | "opencode" | "agy", HarnessAdapter> {
  const claudeConf = settings.backends?.claude;
  const opencodeConf = settings.backends?.opencode;
  const agyConf = settings.backends?.agy;
  const opencodeExtra = opencodeConf?.["extra"] as
    | Record<string, unknown>
    | undefined;

  return {
    claude: new ClaudeAdapter({
      bin: claudeConf?.["bin"] ?? "claude",
      versionPin: claudeConf?.["version_pin"],
      maxConcurrency: claudeConf?.["max_concurrency"],
    }),
    opencode: new OpenCodeAdapter({
      binPath: opencodeConf?.["bin"] ?? "opencode",
      versionPin: opencodeConf?.["version_pin"],
      pricing: pricingTableFor(settings),
      customBaseUrl:
        typeof opencodeExtra?.customBaseUrl === "string"
          ? opencodeExtra.customBaseUrl
          : undefined,
    }),
    agy: new AgyAdapter({
      bin: agyConf?.["bin"] ?? "agy",
      pricing: pricingTableFor(settings),
      maxConcurrency: agyConf?.["max_concurrency"],
    }),
  };
}
