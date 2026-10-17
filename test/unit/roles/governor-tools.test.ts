import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";

export interface OpenAIToolParam {
  type: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: OpenAIToolParam;
  };
}

const {
  GOVERNOR_TOOL_DEFINITIONS,
  parseGovernorToolCall,
  validateGovernorTool,
} = (await import("../../../src/roles/governor-tools.js" as any)) as {
  GOVERNOR_TOOL_DEFINITIONS: readonly OpenAIToolDefinition[];
  parseGovernorToolCall: (name: string, rawArgs: unknown) => Contracts.GovernorTool;
  validateGovernorTool: (tool: Contracts.GovernorTool) => boolean;
};

describe("Governor Tools (src/roles/governor-tools.ts)", () => {
  const CANONICAL_TOOL_NAMES = [
    "start_run",
    "plan_only",
    "resume_run",
    "run_status",
    "show_cost",
    "cancel_run",
    "ask_user",
  ] as const;

  describe("Tool Definitions (GOVERNOR_TOOL_DEFINITIONS)", () => {
    it("exports definitions for exactly the 7 Appendix A canonical tools", () => {
      expect(Array.isArray(GOVERNOR_TOOL_DEFINITIONS)).toBe(true);
      expect(GOVERNOR_TOOL_DEFINITIONS.length).toBe(7);

      const names = GOVERNOR_TOOL_DEFINITIONS.map((t) => t.function.name).sort();
      expect(names).toEqual([...CANONICAL_TOOL_NAMES].sort());
    });

    it("conforms to OpenAI tool definition format with function name, description, and parameter schemas", () => {
      for (const def of GOVERNOR_TOOL_DEFINITIONS) {
        expect(def.type).toBe("function");
        expect(typeof def.function.name).toBe("string");
        expect(typeof def.function.description).toBe("string");
        expect(def.function.description.length).toBeGreaterThan(0);
        expect(def.function.parameters).toBeDefined();
        expect(def.function.parameters.type).toBe("object");
      }
    });

    it("verifies required parameter schemas for all tools", () => {
      const defMap = new Map(GOVERNOR_TOOL_DEFINITIONS.map((d) => [d.function.name, d]));

      expect(defMap.get("start_run")?.function.parameters.required).toContain("request");
      expect(defMap.get("plan_only")?.function.parameters.required).toContain("request");
      expect(defMap.get("resume_run")?.function.parameters.required).toContain("run_id");
      expect(defMap.get("cancel_run")?.function.parameters.required).toContain("run_id");
      expect(defMap.get("ask_user")?.function.parameters.required).toContain("question");
    });
  });

  describe("Tool Call Parsing (parseGovernorToolCall)", () => {
    describe("start_run", () => {
      it("parses valid start_run with all arguments", () => {
        const tool = parseGovernorToolCall("start_run", {
          request: "Implement OAuth flow",
          mode: "plan",
          permission_mode: "acceptEdits",
        });

        expect(tool.name).toBe("start_run");
        if (tool.name === "start_run") {
          expect(tool.args.request).toBe("Implement OAuth flow");
          expect(tool.args.mode).toBe("plan");
          expect(tool.args.permission_mode).toBe("acceptEdits");
        }
      });

      it("parses valid start_run with JSON string arguments", () => {
        const jsonStr = JSON.stringify({
          request: "Fix bug in parser",
          mode: "solo",
        });
        const tool = parseGovernorToolCall("start_run", jsonStr);

        expect(tool.name).toBe("start_run");
        if (tool.name === "start_run") {
          expect(tool.args.request).toBe("Fix bug in parser");
          expect(tool.args.mode).toBe("solo");
        }
      });

      it("rejects start_run when request is missing or empty", () => {
        expect(() => parseGovernorToolCall("start_run", {})).toThrow();
        expect(() => parseGovernorToolCall("start_run", { request: "" })).toThrow();
        expect(() => parseGovernorToolCall("start_run", { request: 123 })).toThrow();
      });

      it("rejects start_run with invalid mode or permission_mode", () => {
        expect(() =>
          parseGovernorToolCall("start_run", {
            request: "Valid request",
            mode: "invalid_mode",
          }),
        ).toThrow();

        expect(() =>
          parseGovernorToolCall("start_run", {
            request: "Valid request",
            permission_mode: "superAdmin",
          }),
        ).toThrow();
      });
    });

    describe("plan_only", () => {
      it("parses valid plan_only", () => {
        const tool = parseGovernorToolCall("plan_only", {
          request: "Draft migration plan for sqlite to postgres",
        });

        expect(tool.name).toBe("plan_only");
        if (tool.name === "plan_only") {
          expect(tool.args.request).toBe("Draft migration plan for sqlite to postgres");
        }
      });

      it("rejects plan_only with missing or empty request", () => {
        expect(() => parseGovernorToolCall("plan_only", {})).toThrow();
        expect(() => parseGovernorToolCall("plan_only", { request: "" })).toThrow();
      });
    });

    describe("resume_run", () => {
      it("parses valid resume_run with valid RunId", () => {
        const tool = parseGovernorToolCall("resume_run", {
          run_id: "r_234567ABCDEF",
        });

        expect(tool.name).toBe("resume_run");
        if (tool.name === "resume_run") {
          expect(tool.args.run_id).toBe("r_234567ABCDEF");
        }
      });

      it("rejects resume_run with malformed RunId", () => {
        expect(() => parseGovernorToolCall("resume_run", { run_id: "not_a_run_id" })).toThrow();
        expect(() => parseGovernorToolCall("resume_run", { run_id: "r_lowercase123" })).toThrow();
        expect(() => parseGovernorToolCall("resume_run", { run_id: "r_SHORT" })).toThrow();
        expect(() => parseGovernorToolCall("resume_run", {})).toThrow();
      });
    });

    describe("run_status and show_cost", () => {
      it("parses run_status with and without run_id", () => {
        const withId = parseGovernorToolCall("run_status", { run_id: "r_234567ABCDEF" });
        expect(withId.name).toBe("run_status");
        if (withId.name === "run_status") {
          expect(withId.args.run_id).toBe("r_234567ABCDEF");
        }

        const withoutId = parseGovernorToolCall("run_status", {});
        expect(withoutId.name).toBe("run_status");
        if (withoutId.name === "run_status") {
          expect(withoutId.args.run_id).toBeUndefined();
        }
      });

      it("parses show_cost with and without run_id", () => {
        const withId = parseGovernorToolCall("show_cost", { run_id: "r_234567ABCDEF" });
        expect(withId.name).toBe("show_cost");
        if (withId.name === "show_cost") {
          expect(withId.args.run_id).toBe("r_234567ABCDEF");
        }

        const withoutId = parseGovernorToolCall("show_cost", {});
        expect(withoutId.name).toBe("show_cost");
      });

      it("rejects run_status and show_cost with malformed run_id when present", () => {
        expect(() => parseGovernorToolCall("run_status", { run_id: "bad_id" })).toThrow();
        expect(() => parseGovernorToolCall("show_cost", { run_id: "bad_id" })).toThrow();
      });
    });

    describe("cancel_run", () => {
      it("parses valid cancel_run with valid RunId", () => {
        const tool = parseGovernorToolCall("cancel_run", {
          run_id: "r_234567ABCDEF",
        });

        expect(tool.name).toBe("cancel_run");
        if (tool.name === "cancel_run") {
          expect(tool.args.run_id).toBe("r_234567ABCDEF");
        }
      });

      it("rejects cancel_run with missing or malformed run_id", () => {
        expect(() => parseGovernorToolCall("cancel_run", {})).toThrow();
        expect(() => parseGovernorToolCall("cancel_run", { run_id: "invalid" })).toThrow();
      });
    });

    describe("ask_user", () => {
      it("parses valid ask_user with question", () => {
        const tool = parseGovernorToolCall("ask_user", {
          question: "Should I proceed with SQLite or PostgreSQL?",
        });

        expect(tool.name).toBe("ask_user");
        if (tool.name === "ask_user") {
          expect(tool.args.question).toBe("Should I proceed with SQLite or PostgreSQL?");
        }
      });

      it("rejects ask_user with missing or empty question", () => {
        expect(() => parseGovernorToolCall("ask_user", {})).toThrow();
        expect(() => parseGovernorToolCall("ask_user", { question: "" })).toThrow();
        expect(() => parseGovernorToolCall("ask_user", { question: 42 })).toThrow();
      });
    });

    describe("Unrecognized tool rejection and malformed rawArgs", () => {
      it("rejects unrecognized tool names", () => {
        expect(() => parseGovernorToolCall("execute_command", {})).toThrow(/unrecognized|unknown/i);
        expect(() => parseGovernorToolCall("write_file", {})).toThrow(/unrecognized|unknown/i);
        expect(() => parseGovernorToolCall("bash", {})).toThrow(/unrecognized|unknown/i);
      });

      it("rejects malformed rawArgs JSON strings", () => {
        expect(() => parseGovernorToolCall("start_run", "{invalid-json")).toThrow();
      });

      it("rejects non-object rawArgs", () => {
        expect(() => parseGovernorToolCall("start_run", null)).toThrow();
        expect(() => parseGovernorToolCall("start_run", 123)).toThrow();
      });
    });
  });

  describe("Tool Validation (validateGovernorTool)", () => {
    it("returns true for all valid GovernorTool instances", () => {
      const validTools: Contracts.GovernorTool[] = [
        { name: "start_run", args: { request: "Build app", mode: "plan" } },
        { name: "plan_only", args: { request: "Plan only" } },
        { name: "resume_run", args: { run_id: "r_234567ABCDEF" } },
        { name: "run_status", args: {} },
        { name: "show_cost", args: { run_id: "r_234567ABCDEF" } },
        { name: "cancel_run", args: { run_id: "r_234567ABCDEF" } },
        { name: "ask_user", args: { question: "Are you sure?" } },
      ];

      for (const tool of validTools) {
        expect(validateGovernorTool(tool)).toBe(true);
      }
    });

    it("returns false for invalid GovernorTool instances", () => {
      const invalidTools = [
        { name: "start_run", args: { request: "" } },
        { name: "resume_run", args: { run_id: "bad_id" } },
        { name: "cancel_run", args: {} },
        { name: "ask_user", args: { question: "" } },
        { name: "unknown_tool", args: {} },
        null,
        undefined,
      ];

      for (const tool of invalidTools) {
        expect(validateGovernorTool(tool as any)).toBe(false);
      }
    });
  });
});
