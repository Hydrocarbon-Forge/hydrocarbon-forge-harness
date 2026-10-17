import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import * as Contracts from "../../../src/contracts/index.js";

export interface GovernorClientOptions {
  endpoint: string;
  model?: string;
  timeoutMs?: number;
  enableThinking?: boolean;
}

export interface GovernorIntakeResult {
  toolCalls: Contracts.GovernorTool[];
  decision?: Contracts.RoutingDecision;
  clarificationQuestion?: string;
  content: string;
}

const {
  checkGovernorHealth,
  callGovernorIntake,
  runGovernorSemanticLint,
} = (await import("../../../src/roles/governor.js" as any)) as {
  checkGovernorHealth: (endpoint: string, timeoutMs?: number) => Promise<boolean>;
  callGovernorIntake: (
    prompt: string,
    opts: GovernorClientOptions,
  ) => Promise<GovernorIntakeResult>;
  runGovernorSemanticLint: (
    plan: unknown,
    repoRoot: string,
    opts: GovernorClientOptions,
  ) => Promise<Contracts.Diagnostic[]>;
};

interface MockServerContext {
  server: http.Server;
  endpoint: string;
  lastRequest: {
    method?: string;
    url?: string;
    headers?: http.IncomingHttpHeaders;
    body?: any;
  };
}

function createMockOpenAIServer(
  handler?: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void,
): Promise<MockServerContext> {
  return new Promise((resolve) => {
    const ctx: MockServerContext = {
      server: null as any,
      endpoint: "",
      lastRequest: {},
    };

    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        let parsedBody: any = null;
        if (raw) {
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            parsedBody = raw;
          }
        }
        ctx.lastRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: parsedBody,
        };

        if (handler) {
          handler(req, res, parsedBody);
        } else {
          // Default response for /health
          if (req.url === "/health" || req.url === "/v1/models") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          // Default OpenAI completion response
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-mock",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      mode: "plan",
                      rationale: "Default plan routing",
                    }),
                  },
                },
              ],
            }),
          );
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      ctx.endpoint = `http://127.0.0.1:${addr.port}`;
      ctx.server = server;
      resolve(ctx);
    });
  });
}

describe("Governor Front Door (src/roles/governor.ts)", () => {
  let activeServer: http.Server | null = null;

  afterEach(async () => {
    if (activeServer) {
      await new Promise((resolve) => activeServer!.close(resolve));
      activeServer = null;
    }
  });

  describe("Health Check (checkGovernorHealth)", () => {
    it("returns true when endpoint responds with 200 within timeout", async () => {
      const mock = await createMockOpenAIServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
      activeServer = mock.server;

      const ok = await checkGovernorHealth(mock.endpoint, 2000);
      expect(ok).toBe(true);
    });

    it("returns false without throwing when endpoint returns 500 error", async () => {
      const mock = await createMockOpenAIServer((req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "server error" }));
      });
      activeServer = mock.server;

      const ok = await checkGovernorHealth(mock.endpoint, 2000);
      expect(ok).toBe(false);
    });

    it("returns false without throwing when endpoint connection is refused", async () => {
      // Connect to unused local port
      const ok = await checkGovernorHealth("http://127.0.0.1:59999", 500);
      expect(ok).toBe(false);
    });

    it("returns false when endpoint hangs past timeoutMs", async () => {
      const mock = await createMockOpenAIServer(() => {
        // Intentionally hang without responding
      });
      activeServer = mock.server;

      const ok = await checkGovernorHealth(mock.endpoint, 50);
      expect(ok).toBe(false);
    });
  });

  describe("Bounded Intake Calling (callGovernorIntake)", () => {
    it("invokes /v1/chat/completions with thinking explicitly disabled (enable_thinking: false)", async () => {
      let capturedBody: any = null;
      const mock = await createMockOpenAIServer((req, res, body) => {
        capturedBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    mode: "solo",
                    task_class: "mechanical",
                    rationale: "Simple change",
                  }),
                },
              },
            ],
          }),
        );
      });
      activeServer = mock.server;

      await callGovernorIntake("Fix typo in README.md", {
        endpoint: mock.endpoint,
        enableThinking: false,
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.chat_template_kwargs).toEqual(
        expect.objectContaining({ enable_thinking: false }),
      );
      expect(capturedBody.tools).toBeDefined();
      expect(capturedBody.tool_choice).toBe("auto");
      expect(capturedBody.response_format?.type).toBe("json_schema");
    });

    it("parses tool calls into GovernorIntakeResult.toolCalls", async () => {
      const mock = await createMockOpenAIServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "start_run",
                        arguments: JSON.stringify({
                          request: "Add JWT authentication",
                          mode: "plan",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      });
      activeServer = mock.server;

      const result = await callGovernorIntake("Build JWT auth", {
        endpoint: mock.endpoint,
      });

      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].name).toBe("start_run");
      if (result.toolCalls[0].name === "start_run") {
        expect(result.toolCalls[0].args.request).toBe("Add JWT authentication");
        expect(result.toolCalls[0].args.mode).toBe("plan");
      }
    });

    it("extracts structured routing decision from schema-constrained response", async () => {
      const mock = await createMockOpenAIServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    mode: "solo",
                    task_class: "mechanical",
                    rationale: "Single file rename",
                  }),
                },
              },
            ],
          }),
        );
      });
      activeServer = mock.server;

      const result = await callGovernorIntake("Rename utils.ts to helpers.ts", {
        endpoint: mock.endpoint,
      });

      expect(result.decision).toBeDefined();
      expect(result.decision?.mode).toBe("solo");
      expect(result.decision?.task_class).toBe("mechanical");
      expect(result.decision?.rationale).toBe("Single file rename");
    });

    it("extracts clarifying question from ask_user tool call", async () => {
      const mock = await createMockOpenAIServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_ask",
                      type: "function",
                      function: {
                        name: "ask_user",
                        arguments: JSON.stringify({
                          question: "Should we use sessionStorage or localStorage?",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      });
      activeServer = mock.server;

      const result = await callGovernorIntake("Store auth token", {
        endpoint: mock.endpoint,
      });

      expect(result.clarificationQuestion).toBe(
        "Should we use sessionStorage or localStorage?",
      );
    });

    it("handles timeout with AbortController without crashing", async () => {
      const mock = await createMockOpenAIServer(() => {
        // Hang
      });
      activeServer = mock.server;

      await expect(
        callGovernorIntake("Hanging request", {
          endpoint: mock.endpoint,
          timeoutMs: 50,
        }),
      ).rejects.toThrow();
    });
  });

  describe("Advisory Semantic Lint (runGovernorSemanticLint)", () => {
    it("enforces thinking enabled (enable_thinking: true) ONLY for advisory semantic lint", async () => {
      let capturedBody: any = null;
      const mock = await createMockOpenAIServer((req, res, body) => {
        capturedBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    diagnostics: [
                      {
                        code: "S001",
                        severity: "info",
                        message: "Task T1 description is ambiguous",
                        task: "T1",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        );
      });
      activeServer = mock.server;

      const diags = await runGovernorSemanticLint({ tasks: [] }, "/repo", {
        endpoint: mock.endpoint,
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.chat_template_kwargs).toEqual(
        expect.objectContaining({ enable_thinking: true }),
      );
      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe("S001");
    });

    it("evaluates S001-S004 checks and enforces all diagnostics have severity 'info' (strictly advisory)", async () => {
      const mockDiags = [
        { code: "S001", severity: "info", message: "Ambiguous spec requirement", task: "T1" },
        { code: "S002", severity: "info", message: "Missing error handling edge cases", task: "T1" },
        { code: "S003", severity: "info", message: "Mismatch between spec and contract stub", task: "T2" },
        { code: "S004", severity: "info", message: "Task scope spans too many files", task: "T2" },
      ];

      const mock = await createMockOpenAIServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({ diagnostics: mockDiags }),
                },
              },
            ],
          }),
        );
      });
      activeServer = mock.server;

      const diags = await runGovernorSemanticLint({}, "/repo", {
        endpoint: mock.endpoint,
      });

      expect(diags.length).toBe(4);
      for (const diag of diags) {
        expect(["S001", "S002", "S003", "S004"]).toContain(diag.code);
        expect(diag.severity).toBe("info");
      }
    });

    it("returns empty diagnostic list when no semantic flaws are detected", async () => {
      const mock = await createMockOpenAIServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({ diagnostics: [] }),
                },
              },
            ],
          }),
        );
      });
      activeServer = mock.server;

      const diags = await runGovernorSemanticLint({}, "/repo", {
        endpoint: mock.endpoint,
      });

      expect(diags).toEqual([]);
    });
  });
});
