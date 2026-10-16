import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
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
  SpawnRequest,
  UsageRecord,
} from "../../contracts/index.js";
import { readNdjsonStream } from "../ndjson.js";
import { spawnSupervisedProcess } from "../process.js";
import { normalizeOpenCodeStream } from "../normalize/opencode.js";

export interface OpenCodeAdapterOptions {
  binPath?: string;
  versionPin?: string;
  customBaseUrl?: string;
  contextWindow?: number;
}

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
};

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
    const action = TOOL_MAP[tool] ?? tool.toLowerCase();
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

  const agentContent = `---\n${frontmatter}---\n\n${req.prompt}\n`;
  const agentFilePath = resolve(agentsDir, `${agentName}.md`);
  writeFileSync(agentFilePath, agentContent, "utf8");

  let providerConfigPath: string | null = null;
  if (
    options?.customBaseUrl ||
    req.model.includes("llama") ||
    req.model.startsWith("local")
  ) {
    const providerConfig = {
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: options?.customBaseUrl ?? "http://127.0.0.1:8080/v1",
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

export class OpenCodeAdapter implements HarnessAdapter {
  readonly capabilities: Capabilities = {
    name: "opencode",
    version_pin: "2.0.21",
    effort: true,
    structured_output: false,
    budget_flag: false,
    cost_reported: true,
    resume: true,
    permission_denial_signal: "none",
    sandbox_flag: false,
    native_subagents_headless: false,
    max_concurrency: 2,
  };

  private readonly binPath: string;
  private readonly versionPin: string;
  private readonly options: OpenCodeAdapterOptions;

  constructor(options?: OpenCodeAdapterOptions) {
    this.options = options ?? {};
    this.binPath = options?.binPath ?? "opencode";
    this.versionPin = options?.versionPin ?? "2.0.21";
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
    const config = generateOpenCodeRunConfigSync(req, this.options);

    const modelWithVariant = mapEffortToVariant(req.model, req.effort);
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
