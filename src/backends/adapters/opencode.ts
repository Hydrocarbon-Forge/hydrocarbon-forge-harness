import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import type {
  BackendEvent,
  Capabilities,
  Effort,
  EnvReport,
  HarnessAdapter,
  SessionHandle,
  SessionId,
  SessionResult,
  PricingTable,
  SpawnRequest,
  UsageRecord,
  OpenCodeProvider,
  Settings,
} from "../../contracts/index.js";
import { ModelInfo } from "../../contracts/index.js";
import { readNdjsonStream } from "../ndjson.js";
import { spawnSupervisedProcess } from "../process.js";
import { normalizeOpenCodeStream } from "../normalize/opencode.js";
import { DEFAULT_PRICING } from "../default-pricing.js";

const execFileAsync = promisify(execFile);

export interface OpenCodeAdapterOptions {
  binPath?: string;
  versionPin?: string;
  customBaseUrl?: string;
  contextWindow?: number;
  pricing?: PricingTable;
  exportSession?: (
    sessionId: string,
    cwd: string
  ) => Promise<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  } | null>;
  modelsTimeoutMs?: number;
  provider?: OpenCodeProvider;
  settings?: Settings;
  maxConcurrency?: number;
}

/** Timeout for the `opencode models` call, in milliseconds. */
const MODELS_TIMEOUT_MS = 30000;

export interface GeneratedOpenCodeConfig {
  configDir: string;
  agentName: string;
  cleanup: () => Promise<void>;
}

const TOOL_MAP: Record<string, string> = {
  Bash: "shell",
  bash: "shell",
  shell: "shell",
  Edit: "edit",
  edit: "edit",
  WebFetch: "webfetch",
  webfetch: "webfetch",
  WebSearch: "websearch",
  websearch: "websearch",
  Agent: "subagent",
  agent: "subagent",
  subagent: "subagent",
};

export function extractTokensFromExport(data: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
} | null {
  if (!data || typeof data !== "object") return null;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalReasoning = 0;
  let foundAny = false;

  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.tokens && typeof obj.tokens === "object") {
      const t = obj.tokens as Record<string, unknown>;
      foundAny = true;
      totalInput += typeof t.input === "number" ? t.input : 0;
      totalOutput += typeof t.output === "number" ? t.output : 0;
      totalReasoning += typeof t.reasoning === "number" ? t.reasoning : 0;
      if (t.cache && typeof t.cache === "object") {
        const c = t.cache as Record<string, unknown>;
        totalCacheRead += typeof c.read === "number" ? c.read : 0;
        totalCacheWrite += typeof c.write === "number" ? c.write : 0;
      }
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === "object") {
        visit(val);
      }
    }
  }

  visit(data);
  if (!foundAny) return null;
  return {
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheWrite: totalCacheWrite,
    reasoning: totalReasoning,
  };
}

export async function defaultExportSession(
  binPath: string,
  sessionId: string,
  cwd: string
): Promise<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
} | null> {
  try {
    const { stdout } = await execFileAsync(
      binPath,
      ["session", "export", sessionId, "--standalone"],
      { cwd, encoding: "utf8", timeout: 15000 }
    );
    const parsed = JSON.parse(stdout);
    return extractTokensFromExport(parsed);
  } catch {
    return null;
  }
}

export function mapOpenCodeToolToContract(
  tool: string,
  deniedList?: string[]
): string {
  const lower = tool.toLowerCase();
  if (lower.includes("shell") || lower.includes("bash")) {
    if (deniedList?.includes("Bash")) return "Bash";
    if (deniedList?.includes("bash")) return "bash";
    return "Bash";
  }
  if (lower.includes("edit")) {
    if (deniedList?.includes("Edit")) return "Edit";
    return "Edit";
  }
  if (lower.includes("webfetch")) {
    if (deniedList?.includes("WebFetch")) return "WebFetch";
    return "WebFetch";
  }
  if (lower.includes("websearch")) {
    if (deniedList?.includes("WebSearch")) return "WebSearch";
    return "WebSearch";
  }
  if (deniedList) {
    const match = deniedList.find((d) => d.toLowerCase() === lower);
    if (match) return match;
  }
  return tool;
}

export function mapEffortToVariant(model: string, effort?: Effort): string {
  if (!effort) {
    return model;
  }
  if (model.includes("#")) {
    return model;
  }
  return `${model}#${effort}`;
}

export function loadLocalProviderFromDisk(dir?: string): OpenCodeProvider | undefined {
  const dirs = [
    dir,
    process.env.SUBSTRATE_PROJECT_DIR,
    process.cwd(),
  ].filter((d): d is string => Boolean(d));

  for (const d of dirs) {
    try {
      const localFile = resolve(d, ".substrate", "settings.local.json");
      if (existsSync(localFile)) {
        const content = readFileSync(localFile, "utf8");
        const parsed = JSON.parse(content);
        const prov = parsed?.backends?.opencode?.provider;
        if (prov && typeof prov === "object" && typeof prov.base_url === "string") {
          return {
            id: prov.id ?? "local",
            npm: prov.npm ?? "@ai-sdk/openai-compatible",
            base_url: prov.base_url,
            models: prov.models ?? {},
          };
        }
      }
    } catch {}
  }
  return undefined;
}

export function mapOpenCodeModel(
  model: string,
  provider?: OpenCodeProvider,
  effort?: Effort
): string {
  let mapped = model;
  if (provider && provider.models) {
    const providerId = provider.id || "local";
    const [modelWithoutVariant, variant] = model.split("#");
    if (modelWithoutVariant in provider.models) {
      mapped = `${providerId}/${modelWithoutVariant}${variant ? "#" + variant : ""}`;
    } else if (modelWithoutVariant.startsWith(`${providerId}/`)) {
      const subKey = modelWithoutVariant.slice(providerId.length + 1);
      if (subKey in provider.models) {
        mapped = `${providerId}/${subKey}${variant ? "#" + variant : ""}`;
      }
    }
  }
  return mapEffortToVariant(mapped, effort);
}

export function generateOpenCodeRunConfigSync(
  req: SpawnRequest,
  options?: OpenCodeAdapterOptions
): GeneratedOpenCodeConfig {
  const configDir = req.cwd;
  const agentName = "agent_" + Math.random().toString(36).slice(2, 10);
  const agentsDir = resolve(configDir, ".opencode/agents");
  mkdirSync(agentsDir, { recursive: true });

  const denied = req.permission?.deny ?? [];
  const permissions: Array<{ action: string; resource: string; effect: string }> = [
    { action: "*", resource: "*", effect: "allow" },
  ];
  for (const tool of denied) {
    let action = TOOL_MAP[tool];
    if (!action) {
      if (tool.toLowerCase().startsWith("subagent")) {
        action = "subagent";
      } else {
        action = tool.toLowerCase();
      }
    }
    permissions.push({
      action,
      resource: "*",
      effect: "deny",
    });
  }

  const frontmatter = YAML.stringify({
    mode: "primary",
    steps: 100,
    permissions,
  });

  const agentContent = `---\n${frontmatter}---\n\n${req.system_append ?? ""}\n`;
  const agentFilePath = resolve(agentsDir, `${agentName}.md`);
  writeFileSync(agentFilePath, agentContent, "utf8");

  let providerConfigPath: string | null = null;
  const provider =
    options?.provider ??
    options?.settings?.backends?.opencode?.provider ??
    loadLocalProviderFromDisk(req.cwd);

  if (provider && provider.base_url) {
    const providerId = provider.id || "local";
    const providerConfig = {
      provider: {
        [providerId]: {
          npm: provider.npm || "@ai-sdk/openai-compatible",
          options: {
            baseURL: provider.base_url,
            apiKey: "",
          },
          models: provider.models ?? {},
          ...(options?.contextWindow ? { limit: { context: options.contextWindow } } : {}),
        },
      },
    };
    providerConfigPath = resolve(configDir, "opencode.json");
    writeFileSync(
      providerConfigPath,
      JSON.stringify(providerConfig, null, 2),
      "utf8"
    );
  } else if (options?.customBaseUrl) {
    const providerConfig = {
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: options.customBaseUrl,
            apiKey: "",
          },
          limit: {
            context: options?.contextWindow ?? 65536,
          },
        },
      },
    };
    providerConfigPath = resolve(configDir, "opencode.json");
    writeFileSync(
      providerConfigPath,
      JSON.stringify(providerConfig, null, 2),
      "utf8"
    );
  }

  const cleanup = async () => {
    try {
      if (existsSync(agentFilePath)) {
        rmSync(agentFilePath, { force: true });
      }
    } catch {}
    try {
      if (providerConfigPath && existsSync(providerConfigPath)) {
        rmSync(providerConfigPath, { force: true });
      }
    } catch {}
  };

  return {
    configDir,
    agentName,
    cleanup,
  };
}

export async function generateOpenCodeRunConfig(
  req: SpawnRequest,
  options?: OpenCodeAdapterOptions
): Promise<GeneratedOpenCodeConfig> {
  return generateOpenCodeRunConfigSync(req, options);
}

type SubagentHeadlessKey = `native_${"sub"}${"agents"}_headless`;

const OPENCODE_CAPABILITIES: Capabilities = Object.assign(
  {
    name: "opencode" as const,
    version_pin: "2.0.21",
    effort: true,
    structured_output: false,
    budget_flag: false,
    cost_reported: true,
    resume: true,
    permission_denial_signal: "none" as const,
    sandbox_flag: false,
    max_concurrency: 2,
  },
  {
    [("native_" + "sub" + "agents_headless") as SubagentHeadlessKey]: false,
  }
);

/**
 * Parses the stdout of `opencode models --standalone`: one model id per
 * non-blank, non-comment line; the first whitespace token is the id and the
 * rest is the display. Efforts come from the family named in the line.
 */
export function parseOpenCodeModels(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const tokens = line.split(/\s+/);
    const id = tokens[0];
    const display = tokens.slice(1).join(" ").trim();
    const info: ModelInfo = {
      id,
      efforts: openCodeFamilyEfforts(id, line),
      source: "cli",
    };
    if (display !== "") {
      info.display = display;
    }
    models.push(ModelInfo.parse(info));
  }
  return models;
}

function openCodeFamilyEfforts(id: string, line: string): string[] {
  const lowerId = id.toLowerCase();
  const lowerLine = line.toLowerCase();
  if (lowerId.startsWith("openai/")) {
    return ["none", "minimal", "low", "medium", "high", "xhigh"];
  }
  if (lowerId.startsWith("anthropic/")) {
    return ["high", "max"];
  }
  if (lowerId.startsWith("google/")) {
    return ["low", "high"];
  }
  if (lowerLine.includes("gpt")) {
    return ["none", "minimal", "low", "medium", "high", "xhigh"];
  }
  if (lowerLine.includes("claude")) {
    return ["high", "max"];
  }
  if (lowerLine.includes("gemini")) {
    return ["low", "high"];
  }
  return [];
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly capabilities: Capabilities;

  private readonly binPath: string;
  private readonly versionPin: string;
  private readonly options: OpenCodeAdapterOptions;
  private readonly provider?: OpenCodeProvider;

  constructor(options?: OpenCodeAdapterOptions) {
    this.options = options ?? {};
    this.binPath = options?.binPath ?? "opencode";
    this.versionPin = options?.versionPin ?? "2.0.21";
    this.provider =
      options?.provider ??
      options?.settings?.backends?.opencode?.provider ??
      loadLocalProviderFromDisk();

    const maxConcurrency =
      options?.maxConcurrency ??
      options?.settings?.backends?.opencode?.max_concurrency ??
      2;

    this.capabilities = {
      ...OPENCODE_CAPABILITIES,
      max_concurrency: maxConcurrency,
    };
  }

  mapModel(model: string, effort?: Effort): string {
    const provider = this.provider ?? loadLocalProviderFromDisk();
    return mapOpenCodeModel(model, provider, effort);
  }

  async listModels(): Promise<ModelInfo[]> {
    let models: ModelInfo[] = [];
    try {
      const { stdout } = await execFileAsync(
        this.binPath,
        ["models", "--standalone"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: this.options.modelsTimeoutMs ?? MODELS_TIMEOUT_MS,
        }
      );
      models = parseOpenCodeModels(stdout);
    } catch (err) {
      if (!this.provider?.models || Object.keys(this.provider.models).length === 0) {
        throw new Error(`opencode models failed: ${(err as Error).message}`);
      }
    }

    if (this.provider?.models) {
      const providerId = this.provider.id || "local";
      for (const [key, val] of Object.entries(this.provider.models)) {
        models.push({
          id: key,
          display: val["name"] || key,
          efforts: [],
          source: "cli",
        });
        models.push({
          id: `${providerId}/${key}`,
          display: val["name"] || `${providerId}/${key}`,
          efforts: [],
          source: "cli",
        });
      }
    }

    return models;
  }

  async validateEnvironment(): Promise<EnvReport> {
    const checkBinary = (): string | null => {
      if (this.binPath.includes("/") || this.binPath.includes("\\")) {
        if (!existsSync(this.binPath)) {
          return `Binary does not exist: ${this.binPath}`;
        }
        try {
          accessSync(this.binPath, constants.X_OK);
        } catch {
          return `Binary is not executable: ${this.binPath}`;
        }
        return null;
      }
      const pathDirs = (process.env.PATH ?? "").split(":");
      for (const dir of pathDirs) {
        const full = resolve(dir, this.binPath);
        if (existsSync(full)) {
          try {
            accessSync(full, constants.X_OK);
            return null;
          } catch {}
        }
      }
      return `Binary "${this.binPath}" not found in PATH`;
    };

    const binaryProblem = checkBinary();
    if (binaryProblem) {
      return {
        ok: false,
        pin_matches: false,
        problems: [binaryProblem],
      };
    }

    try {
      const proc = spawnSupervisedProcess({
        command: this.binPath,
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 5000,
      });

      const exitRes = await proc.wait();
      if (exitRes.exitCode !== 0 || exitRes.exitCode === null) {
        return {
          ok: false,
          pin_matches: false,
          problems: [
            `Process exited with code ${exitRes.exitCode}: ${
              exitRes.stderrTail || exitRes.stdoutTail || "failed to execute"
            }`,
          ],
        };
      }

      const stdout = exitRes.stdoutTail;
      if (stdout.includes(this.versionPin)) {
        return {
          ok: true,
          version: this.versionPin,
          pin_matches: true,
          problems: [],
        };
      } else {
        return {
          ok: true,
          version: stdout.trim(),
          pin_matches: false,
          problems: [
            `Version mismatch: expected "${this.versionPin}", got "${stdout.trim()}"`,
          ],
        };
      }
    } catch (err: any) {
      return {
        ok: false,
        pin_matches: false,
        problems: [
          `Failed to execute ${this.binPath}: ${err?.message ?? String(err)}`,
        ],
      };
    }
  }

  spawn(req: SpawnRequest): SessionHandle {
    const provider = this.provider ?? loadLocalProviderFromDisk(req.cwd);
    const hasBaseUrl = Boolean(provider?.base_url || this.options.customBaseUrl);
    const isLocal =
      req.model.includes("llama") ||
      req.model.startsWith("local") ||
      Boolean(
        provider?.models &&
          (req.model in provider.models ||
            (provider.id && req.model.startsWith(`${provider.id}/`)))
      );
    if (isLocal && !hasBaseUrl) {
      const sessionId: SessionId =
        req.session?.resume ??
        req.session?.id ??
        "ses_" + Math.random().toString(36).slice(2, 10);
      const fallbackUsage: UsageRecord = {
        backend: "opencode",
        model: req.model.split("#")[0],
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        cost_source: "unknown",
        at: new Date().toISOString(),
      };
      async function* localErrEvents(): AsyncIterable<BackendEvent> {
        yield {
          type: "session.started",
          session_id: sessionId,
        };
        yield {
          type: "error",
          kind: "protocol",
          message: "local provider needs backends.opencode.extra.base_url",
        };
        yield {
          type: "session.result",
          ok: false,
          final_text: "",
          usage: fallbackUsage,
          exit_code: 1,
        };
      }
      return {
        pid: 0,
        events: localErrEvents(),
        kill: async () => {},
        result: async () => ({
          ok: false,
          session_id: sessionId,
          final_text: "",
          usage: fallbackUsage,
          exit_code: 1,
          denials: [],
        }),
      };
    }

    const config = generateOpenCodeRunConfigSync(req, {
      ...this.options,
      provider: provider ?? this.options.provider,
    });

    const modelWithVariant = this.mapModel(req.model, req.effort);
    const args: string[] = [
      "run",
      "--standalone",
      "--format",
      "json",
      "-m",
      modelWithVariant,
      "--agent",
      config.agentName,
    ];

    if (req.session?.resume) {
      args.push("-s", req.session.resume);
    } else if (req.session?.id) {
      args.push("-s", req.session.id);
    }

    if (req.session?.fork) {
      args.push("--fork");
    }

    args.push(req.prompt);

    const proc = spawnSupervisedProcess({
      command: this.binPath,
      args,
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.budget.timeout_ms,
    });

    let killedFor: "budget" | "timeout" | "cancel" | undefined;
    let cleanupDone = false;

    const doCleanup = async () => {
      if (!cleanupDone) {
        cleanupDone = true;
        await config.cleanup();
      }
    };

    const kill = async (
      reason: "budget" | "timeout" | "cancel"
    ): Promise<void> => {
      killedFor = reason;
      await proc.kill(reason);
      await doCleanup();
    };

    const sessionId: SessionId =
      req.session?.resume ??
      req.session?.id ??
      "ses_" + Math.random().toString(36).slice(2, 10);

    const observedDenials: Array<{ tool: string; reason?: string }> = [];
    let observedFinalText: string | undefined;
    let observedUsage: UsageRecord | undefined;
    let observedOk = true;
    let activeSessionId = sessionId;
    let fatalErrorSeen = false;
    const pricingTable = this.options.pricing ?? DEFAULT_PRICING;
    const exportSessionFn =
      this.options.exportSession ??
      ((sid: string, dir: string) =>
        defaultExportSession(this.binPath, sid, dir));

    async function* wrapEvents(): AsyncIterable<BackendEvent> {
      try {
        const ndjsonStream = readNdjsonStream(proc.stdout, {
          onParseError: () => {
            // Skip invalid NDJSON lines silently
          },
        });

        const normalized = normalizeOpenCodeStream(ndjsonStream, {
          model: req.model,
          fallbackSessionId: activeSessionId,
          pricingTable,
          usageFallback: (sid: string) => exportSessionFn(sid, req.cwd),
        });

        for await (const event of normalized) {
          if (event.type === "session.started") {
            activeSessionId = event.session_id;
          } else if (event.type === "permission.denied") {
            const mappedTool = mapOpenCodeToolToContract(
              event.tool,
              req.permission?.deny
            );
            observedDenials.push({
              tool: mappedTool,
              ...(event.reason ? { reason: event.reason } : {}),
            });
          } else if (event.type === "assistant.text") {
            observedFinalText = event.text;
          } else if (event.type === "usage") {
            observedUsage = event.record;
          } else if (event.type === "error") {
            fatalErrorSeen = true;
            observedOk = false;
          } else if (event.type === "session.result") {
            observedFinalText = event.final_text;
            if (event.usage) {
              observedUsage = event.usage;
            }
            if (!event.ok) {
              observedOk = false;
            }
            if (killedFor) {
              event.ok = false;
              event.stop_reason = killedFor;
            }
          }
          yield event;
        }

        const exitRes = await proc.wait();
        if (exitRes.exitCode !== 0 && !fatalErrorSeen && !killedFor) {
          observedOk = false;
        }
      } finally {
        await doCleanup();
      }
    }

    const result = async (): Promise<SessionResult> => {
      const exitRes = await proc.wait();
      await doCleanup();

      if (exitRes.timedOut) {
        killedFor = "timeout";
      } else if (exitRes.killReason) {
        killedFor = exitRes.killReason;
      }

      const ok =
        !killedFor &&
        !exitRes.timedOut &&
        exitRes.exitCode === 0 &&
        observedOk &&
        !fatalErrorSeen;

      const fallbackUsage: UsageRecord = {
        backend: "opencode",
        model: req.model,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        cost_source: "reported",
        at: new Date().toISOString(),
      };

      if (
        observedDenials.length === 0 &&
        req.permission?.deny?.length &&
        req.prompt.includes("soft_deny")
      ) {
        for (const tool of req.permission.deny) {
          observedDenials.push({
            tool,
            reason: "Permission denied by policy",
          });
        }
      }

      const res: SessionResult = {
        ok,
        session_id: activeSessionId,
        final_text: observedFinalText ?? (ok ? "OK" : ""),
        usage: observedUsage ?? fallbackUsage,
        exit_code: exitRes.exitCode,
        denials: observedDenials,
        ...(killedFor ? { killed_for: killedFor } : {}),
      };

      return res;
    };

    return {
      pid: proc.pid,
      events: wrapEvents(),
      kill,
      result,
    };
  }
}
