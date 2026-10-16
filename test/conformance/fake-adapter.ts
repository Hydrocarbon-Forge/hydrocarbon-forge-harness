import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BackendEvent,
  Capabilities,
  EnvReport,
  HarnessAdapter,
  SessionHandle,
  SessionResult,
  SpawnRequest,
  UsageRecord,
} from "../../src/contracts/index.js";
import { readNdjsonStream } from "../../src/backends/ndjson.js";
import { spawnSupervisedProcess } from "../../src/backends/process.js";
import type { FakeScenarioName } from "../fixtures/fake-harness/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "../fixtures/fake-harness/cli.ts");

export class FakeAdapter implements HarnessAdapter {
  readonly capabilities: Capabilities = {
    name: "fake",
    version_pin: "1.0.0",
    effort: true,
    structured_output: true,
    budget_flag: true,
    cost_reported: true,
    resume: true,
    permission_denial_signal: "event",
    sandbox_flag: true,
    native_subagents_headless: false,
    max_concurrency: 4,
  };

  async validateEnvironment(): Promise<EnvReport> {
    return {
      ok: true,
      version: "1.0.0",
      pin_matches: true,
      problems: [],
    };
  }

  spawn(req: SpawnRequest): SessionHandle {
    let scenario: FakeScenarioName = "success";

    if (req.session?.resume) {
      scenario = "resume";
    } else if (req.prompt.startsWith("scenario:")) {
      scenario = req.prompt.slice("scenario:".length) as FakeScenarioName;
    } else if (req.permission.deny && req.permission.deny.length > 0) {
      scenario = "soft_deny";
    } else if (req.prompt.includes("hang")) {
      scenario = "hang";
    } else if (req.prompt.includes("crash")) {
      scenario = "crash";
    } else if (req.prompt.includes("budget")) {
      scenario = "budget_overshoot";
    } else if (req.prompt.includes("rate_limit")) {
      scenario = "rate_limit";
    } else if (req.env?.FAKE_SCENARIO) {
      scenario = req.env.FAKE_SCENARIO as FakeScenarioName;
    }

    const sessionId =
      req.session?.resume ??
      req.session?.id ??
      "fake-session-" + Math.random().toString(36).slice(2, 10);

    const args = [cliPath, "--scenario", scenario, "--session-id", sessionId];

    if (req.session?.resume) {
      args.push("--resume", req.session.resume);
    }
    if (req.permission.deny && req.permission.deny.length > 0) {
      args.push("--denial-tool", req.permission.deny[0]);
    }

    const proc = spawnSupervisedProcess({
      command: process.execPath,
      args,
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.budget.timeout_ms,
    });

    const denials: Array<{ tool: string; reason?: string }> = [];
    if (scenario === "soft_deny") {
      denials.push({
        tool: req.permission.deny[0] ?? "Bash",
        reason: "Permission denied by policy",
      });
    }

    let defaultFinalText = "Task completed successfully.";
    let defaultOk = true;

    if (scenario === "soft_deny") {
      defaultFinalText = "Continuing despite tool denial.";
    } else if (scenario === "resume") {
      defaultFinalText = "Resumed session completed.";
    } else if (scenario === "budget_overshoot") {
      defaultFinalText = "Max budget exceeded";
      defaultOk = false;
    } else if (scenario === "rate_limit") {
      defaultFinalText = "Rate limit exceeded";
      defaultOk = false;
    } else if (scenario === "crash") {
      defaultFinalText = "";
      defaultOk = false;
    } else if (scenario === "hang") {
      defaultFinalText = "";
      defaultOk = false;
    }

    let defaultUsage: UsageRecord = {
      backend: "fake",
      model: req.model,
      input_tokens: defaultOk ? 10 : 0,
      output_tokens: defaultOk ? 5 : 0,
      cost_usd: defaultOk ? 0.0001 : 0,
      cost_source: "reported",
      at: new Date().toISOString(),
    };

    let observedFinalText: string | undefined;
    let observedOk: boolean | undefined;
    let observedUsage: UsageRecord | undefined;

    async function* generateEvents(): AsyncIterable<BackendEvent> {
      let startedYielded = false;
      let resultYielded = false;

      yield {
        type: "session.started",
        session_id: sessionId,
      };
      startedYielded = true;

      try {
        for await (const raw of readNdjsonStream<any>(proc.stdout)) {
          if (!raw || typeof raw !== "object") continue;

          if (raw.type === "system" && raw.subtype === "init") {
            // Started already emitted
          } else if (raw.type === "assistant" && raw.message) {
            const content = raw.message.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (item.type === "text" && typeof item.text === "string") {
                  yield {
                    type: "assistant.text",
                    text: item.text,
                  };
                } else if (item.type === "tool_use") {
                  yield {
                    type: "tool.call",
                    id:
                      item.id ??
                      "toolu_" + Math.random().toString(36).slice(2, 8),
                    name: item.name ?? "tool",
                    input_summary: JSON.stringify(item.input ?? {}),
                  };
                }
              }
            }
          } else if (raw.type === "user" && raw.message) {
            const content = raw.message.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (item.type === "tool_result") {
                  yield {
                    type: "tool.result",
                    id: item.tool_use_id ?? "toolu_unknown",
                    ok: !item.is_error,
                    output_summary: String(item.content ?? ""),
                  };
                }
              }
            }
          } else if (
            raw.type === "system" &&
            raw.subtype === "permission_denied"
          ) {
            yield {
              type: "permission.denied",
              tool: raw.tool_name ?? "unknown",
              ...(raw.message ? { reason: raw.message } : {}),
            };
          } else if (raw.type === "rate_limit_event") {
            if (raw.rate_limit_info?.status === "rejected") {
              yield {
                type: "error",
                kind: "rate_limit",
                message: "Rate limit exceeded",
              };
            }
          } else if (raw.type === "result") {
            observedFinalText = raw.result ?? "";
            observedOk = raw.subtype === "success" && !raw.is_error;
            if (raw.usage) {
              observedUsage = {
                backend: "fake",
                model: req.model,
                input_tokens: raw.usage.input_tokens ?? 0,
                output_tokens: raw.usage.output_tokens ?? 0,
                cost_usd: raw.total_cost_usd ?? 0,
                cost_source: "reported",
                at: new Date().toISOString(),
              };
            }
            if (Array.isArray(raw.permission_denials)) {
              for (const d of raw.permission_denials) {
                yield {
                  type: "permission.denied",
                  tool: d.tool_name ?? d.tool ?? "unknown",
                  ...(d.reason ? { reason: d.reason } : {}),
                };
              }
            }
            resultYielded = true;
            yield {
              type: "session.result",
              ok: observedOk,
              stop_reason: raw.stop_reason ?? (observedOk ? "completed" : "error"),
              final_text: observedFinalText ?? defaultFinalText,
              usage: observedUsage ?? defaultUsage,
              exit_code: observedOk ? 0 : 1,
            };
          }
        }
      } catch {
        // Stream ended or killed
      }

      const exitRes = await proc.wait();

      if (!resultYielded) {
        const ok =
          exitRes.exitCode === 0 &&
          !exitRes.killed &&
          !exitRes.timedOut &&
          (observedOk ?? defaultOk);
        yield {
          type: "session.result",
          ok,
          stop_reason:
            exitRes.killReason ?? (exitRes.timedOut ? "timeout" : "exit"),
          final_text: observedFinalText ?? defaultFinalText,
          usage: observedUsage ?? defaultUsage,
          exit_code: exitRes.exitCode,
        };
      }
    }

    const kill = async (
      reason: "budget" | "timeout" | "cancel"
    ): Promise<void> => {
      await proc.kill(reason);
    };

    const result = async (): Promise<SessionResult> => {
      const exitRes = await proc.wait();
      const ok =
        exitRes.exitCode === 0 &&
        !exitRes.killed &&
        !exitRes.timedOut &&
        (observedOk ?? defaultOk);

      const res: SessionResult = {
        ok,
        session_id: sessionId,
        final_text: observedFinalText ?? (ok ? defaultFinalText : ""),
        usage: observedUsage ?? defaultUsage,
        exit_code: exitRes.exitCode,
        denials,
      };

      if (exitRes.killReason) {
        res.killed_for = exitRes.killReason;
      }

      return res;
    };

    return {
      pid: proc.pid,
      events: generateEvents(),
      kill,
      result,
    };
  }
}
