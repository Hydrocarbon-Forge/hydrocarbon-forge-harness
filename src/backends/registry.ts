import type {
  BackendName,
  HarnessAdapter,
  Settings,
} from "../contracts/index.js";
import { ClaudeAdapter, CLAUDE_FAMILY_IDS } from "./adapters/claude.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { AgyAdapter } from "./adapters/agy.js";
import { pricingTableFor } from "./pricing.js";

export type AdapterMap = Partial<Record<BackendName, HarnessAdapter>>;

/**
 * Model ids known without asking a harness: the model strings in settings.roles
 * and settings.routing (routes and route lists), the Claude 5 family ids, then the
 * settings price table keys, in that order. Deduplication happens in the Claude
 * adapter, first occurrence wins.
 */
function knownModelIds(settings: Settings): string[] {
  const ids: string[] = [];
  const { requested, ...roleEntries } = settings.roles;
  for (const role of [...Object.values(roleEntries), ...Object.values(requested ?? {})]) {
    if (role && typeof role.model === "string") {
      ids.push(role.model);
    }
  }
  for (const entry of Object.values(settings.routing)) {
    if (Array.isArray(entry)) {
      ids.push(...entry);
    } else if (entry && typeof entry.model === "string") {
      ids.push(entry.model);
    }
  }
  ids.push(...CLAUDE_FAMILY_IDS);
  if (settings.pricing.models) {
    ids.push(...Object.keys(settings.pricing.models));
  }
  return ids;
}

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
      knownModels: knownModelIds(settings),
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
      versionPin: agyConf?.["version_pin"],
      pricing: pricingTableFor(settings),
      maxConcurrency: agyConf?.["max_concurrency"],
    }),
  };
}
