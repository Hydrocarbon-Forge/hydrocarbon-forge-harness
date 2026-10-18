import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import {
  OpenCodeAdapter,
  extractTokensFromExport,
  generateOpenCodeRunConfigSync,
  type OpenCodeAdapterOptions,
} from "../../../src/backends/adapters/opencode.js";
import { normalizeOpenCodeStream } from "../../../src/backends/normalize/opencode.js";
import type { SpawnRequest, BackendEvent } from "../../../src/contracts/index.js";

describe("OpenCode Adapter: Config Generation", () => {
  it("confirms the agent file body equals system_append", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-unit-cfg-"));
    try {
      const systemAppend = "You are an expert engineer.\nAlways write tests first.";
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "implement feature",
        model: "opencode/deepseek-v4.1-flash-free",
        system_append: systemAppend,
        permission: { allow: [], deny: [] },
        budget: { timeout_ms: 10000 },
      };

      const config = generateOpenCodeRunConfigSync(req);
      const agentFilePath = resolve(cwd, `.opencode/agents/${config.agentName}.md`);
      expect(existsSync(agentFilePath)).toBe(true);

      const content = readFileSync(agentFilePath, "utf8");
      const parts = content.split("---");
      expect(parts.length).toBeGreaterThanOrEqual(3);

      const body = parts.slice(2).join("---").trim();
      expect(body).toBe(systemAppend);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("confirms denying Agent yields a permissions entry with action: 'subagent', effect: 'deny'", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-unit-perm-"));
    try {
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "implement feature",
        model: "opencode/deepseek-v4.1-flash-free",
        permission: {
          allow: [],
          deny: ["Agent", "Bash", "Edit"],
        },
        budget: { timeout_ms: 10000 },
      };

      const config = generateOpenCodeRunConfigSync(req);
      const agentFilePath = resolve(cwd, `.opencode/agents/${config.agentName}.md`);
      const content = readFileSync(agentFilePath, "utf8");
      const parts = content.split("---");
      const frontmatter = YAML.parse(parts[1]);

      expect(frontmatter.permissions).toBeDefined();
      const subagentDenial = frontmatter.permissions.find(
        (p: { action: string; effect: string }) =>
          p.action === "subagent" && p.effect === "deny"
      );
      expect(subagentDenial).toBeDefined();
      expect(subagentDenial.resource).toBe("*");

      const shellDenial = frontmatter.permissions.find(
        (p: { action: string; effect: string }) =>
          p.action === "shell" && p.effect === "deny"
      );
      expect(shellDenial).toBeDefined();

      const editDenial = frontmatter.permissions.find(
        (p: { action: string; effect: string }) =>
          p.action === "edit" && p.effect === "deny"
      );
      expect(editDenial).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("maps subagent variants ('agent', 'subagent', 'subagents') to 'subagent'", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "opencode-unit-sub-"));
    try {
      const req: SpawnRequest = {
        role: "worker",
        cwd,
        prompt: "test subagents denial",
        model: "opencode/deepseek-v4.1-flash-free",
        permission: {
          allow: [],
          deny: ["agent", "subagent", "subagent_custom"],
        },
        budget: { timeout_ms: 10000 },
      };

      const config = generateOpenCodeRunConfigSync(req);
      const agentFilePath = resolve(cwd, `.opencode/agents/${config.agentName}.md`);
      const content = readFileSync(agentFilePath, "utf8");
      const parts = content.split("---");
      const frontmatter = YAML.parse(parts[1]);

      const subagentDenials = frontmatter.permissions.filter(
        (p: { action: string; effect: string }) =>
          p.action === "subagent" && p.effect === "deny"
      );
      // All variants mapped to "subagent"
      expect(subagentDenials.length).toBe(3);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("OpenCode Adapter: Spawn and Local Provider Requirements", () => {
  it("yields protocol error 'local provider needs backends.opencode.extra.base_url' when local model spawned without customBaseUrl", async () => {
    const adapter = new OpenCodeAdapter();
    const req: SpawnRequest = {
      role: "worker",
      cwd: "/tmp",
      prompt: "run local model",
      model: "local/llama-3.2",
      permission: { allow: [], deny: [] },
      budget: { timeout_ms: 5000 },
    };

    const handle = adapter.spawn(req);
    const events: BackendEvent[] = [];
    for await (const evt of handle.events) {
      events.push(evt);
    }

    const errEvt = events.find((e) => e.type === "error");
    expect(errEvt).toBeDefined();
    if (errEvt && errEvt.type === "error") {
      expect(errEvt.kind).toBe("protocol");
      expect(errEvt.message).toBe("local provider needs backends.opencode.extra.base_url");
    }

    const resultEvt = events.find((e) => e.type === "session.result");
    expect(resultEvt).toBeDefined();
    if (resultEvt && resultEvt.type === "session.result") {
      expect(resultEvt.ok).toBe(false);
    }

    const res = await handle.result();
    expect(res.ok).toBe(false);
  });
});

describe("OpenCode Adapter: Model Variant Stripping", () => {
  it("confirms the model in usage record strips #variant when step_finish occurs", async () => {
    async function* rawStream() {
      yield {
        type: "step_start",
        sessionID: "ses_strip_variant",
        part: { type: "step-start" },
      };
      yield {
        type: "step_finish",
        sessionID: "ses_strip_variant",
        part: {
          type: "step-finish",
          cost: 0.002,
          tokens: { input: 200, output: 50 },
        },
      };
    }

    const events: BackendEvent[] = [];
    for await (const evt of normalizeOpenCodeStream(rawStream(), {
      model: "opencode/deepseek-v4.1-flash-free#high",
    })) {
      events.push(evt);
    }

    const usageEvt = events.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    if (usageEvt && usageEvt.type === "usage") {
      expect(usageEvt.record.model).toBe("opencode/deepseek-v4.1-flash-free");
    }

    const resultEvt = events.find((e) => e.type === "session.result");
    expect(resultEvt).toBeDefined();
    if (resultEvt && resultEvt.type === "session.result") {
      expect(resultEvt.usage?.model).toBe("opencode/deepseek-v4.1-flash-free");
    }
  });

  it("confirms the model in usage record strips #variant when usageFallback is called", async () => {
    async function* rawStream() {
      yield {
        type: "step_start",
        sessionID: "ses_strip_fallback",
        part: { type: "step-start" },
      };
      yield {
        type: "text",
        sessionID: "ses_strip_fallback",
        part: { text: "done" },
      };
    }

    const events: BackendEvent[] = [];
    for await (const evt of normalizeOpenCodeStream(rawStream(), {
      model: "opencode/deepseek-v4.1-flash-free#low",
      usageFallback: async () => ({
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
    })) {
      events.push(evt);
    }

    const usageEvt = events.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    if (usageEvt && usageEvt.type === "usage") {
      expect(usageEvt.record.model).toBe("opencode/deepseek-v4.1-flash-free");
    }
  });
});

describe("OpenCode Adapter: Injected exportSession / usageFallback", () => {
  it("confirms a stream without step_finish calls the injected exportSession and reports its totals", async () => {
    async function* rawStream() {
      yield {
        type: "step_start",
        sessionID: "ses_injected_export",
        part: { type: "step-start" },
      };
      yield {
        type: "text",
        sessionID: "ses_injected_export",
        part: { text: "Task completed successfully" },
      };
    }

    const exportSessionMock = vi.fn(async (sid: string) => {
      expect(sid).toBe("ses_injected_export");
      return {
        input: 7500,
        output: 120,
        cacheRead: 500,
        cacheWrite: 25,
        reasoning: 80,
      };
    });

    const events: BackendEvent[] = [];
    for await (const evt of normalizeOpenCodeStream(rawStream(), {
      model: "opencode/deepseek-v4.1-flash-free",
      usageFallback: exportSessionMock,
    })) {
      events.push(evt);
    }

    expect(exportSessionMock).toHaveBeenCalledTimes(1);
    expect(exportSessionMock).toHaveBeenCalledWith("ses_injected_export");

    const usageEvt = events.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    if (usageEvt && usageEvt.type === "usage") {
      expect(usageEvt.cumulative).toBe(false);
      expect(usageEvt.record.input_tokens).toBe(7500);
      expect(usageEvt.record.output_tokens).toBe(120);
      expect(usageEvt.record.cache_read_tokens).toBe(500);
      expect(usageEvt.record.cache_write_tokens).toBe(25);
      expect(usageEvt.record.reasoning_tokens).toBe(80);
    }

    const resultEvt = events.find((e) => e.type === "session.result");
    expect(resultEvt).toBeDefined();
    if (resultEvt && resultEvt.type === "session.result") {
      expect(resultEvt.ok).toBe(true);
      expect(resultEvt.usage?.input_tokens).toBe(7500);
      expect(resultEvt.usage?.output_tokens).toBe(120);
    }
  });

  it("confirms a null exportSession yields cost_source: 'unknown' plus an error event of kind: 'protocol'", async () => {
    async function* rawStream() {
      yield {
        type: "step_start",
        sessionID: "ses_null_export",
        part: { type: "step-start" },
      };
      yield {
        type: "text",
        sessionID: "ses_null_export",
        part: { text: "No usage" },
      };
    }

    const exportSessionMock = vi.fn(async () => null);

    const events: BackendEvent[] = [];
    for await (const evt of normalizeOpenCodeStream(rawStream(), {
      model: "opencode/deepseek-v4.1-flash-free",
      usageFallback: exportSessionMock,
    })) {
      events.push(evt);
    }

    expect(exportSessionMock).toHaveBeenCalledTimes(1);

    const errEvt = events.find((e) => e.type === "error");
    expect(errEvt).toBeDefined();
    if (errEvt && errEvt.type === "error") {
      expect(errEvt.kind).toBe("protocol");
      expect(errEvt.message).toContain("opencode usage unavailable for session ses_null_export");
    }

    const usageEvt = events.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    if (usageEvt && usageEvt.type === "usage") {
      expect(usageEvt.cumulative).toBe(false);
      expect(usageEvt.record.cost_source).toBe("unknown");
      expect(usageEvt.record.input_tokens).toBe(0);
      expect(usageEvt.record.output_tokens).toBe(0);
    }

    const resultEvt = events.find((e) => e.type === "session.result");
    expect(resultEvt).toBeDefined();
    if (resultEvt && resultEvt.type === "session.result") {
      expect(resultEvt.ok).toBe(false);
    }
  });
});

describe("OpenCode Adapter: extractTokensFromExport", () => {
  it("accumulates tokens from multiple parts across a nested session export object", () => {
    const exportData = {
      id: "ses_export_1",
      messages: [
        {
          id: "msg_1",
          tokens: {
            input: 500,
            output: 25,
            reasoning: 10,
            cache: { read: 100, write: 5 },
          },
        },
        {
          id: "msg_2",
          parts: [
            {
              id: "prt_1",
              tokens: {
                input: 300,
                output: 40,
                reasoning: 15,
                cache: { read: 50, write: 0 },
              },
            },
          ],
        },
      ],
    };

    const tokens = extractTokensFromExport(exportData);
    expect(tokens).toEqual({
      input: 800,
      output: 65,
      cacheRead: 150,
      cacheWrite: 5,
      reasoning: 25,
    });
  });

  it("returns null when no tokens are found in export data or input is invalid", () => {
    expect(extractTokensFromExport({})).toBeNull();
    expect(extractTokensFromExport({ messages: [{ text: "hello" }] })).toBeNull();
    expect(extractTokensFromExport(null)).toBeNull();
    expect(extractTokensFromExport(undefined)).toBeNull();
    expect(extractTokensFromExport("not an object")).toBeNull();
  });
});
