#!/usr/bin/env node
// Export JSON Schemas from Appendix A zod contracts into contracts/<Name>.schema.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const contractsDir = path.join(root, "contracts");

const {
  RunId,
  TaskId,
  SessionId,
  BackendName,
  Effort,
  RoleName,
  TaskClass,
  PermissionMode,
  PauseReason,
  FailureClass,
  Command,
  Budget,
  Manifest,
  TaskSpecFrontmatter,
  VerifyResult,
  UsageRecord,
  WorkerReport,
  FailurePacket,
  Diagnostic,
  BackendEvent,
  Capabilities,
  SpawnRequest,
  SessionResult,
  SessionHandle,
  EnvReport,
  HarnessAdapter,
  Settings,
  Route,
  PricingTable,
  RunOptions,
  RunSummary,
  Engine,
  EngineEvent,
  ExecutionStrategy,
  RoutingDecision,
} = await import("../src/contracts/index.ts");

const CONTRACT_SCHEMAS = {
  RunId,
  TaskId,
  SessionId,
  BackendName,
  Effort,
  RoleName,
  TaskClass,
  PermissionMode,
  PauseReason,
  FailureClass,
  Command,
  Budget,
  Manifest,
  TaskSpecFrontmatter,
  VerifyResult,
  UsageRecord,
  WorkerReport,
  FailurePacket,
  Diagnostic,
  BackendEvent,
  Capabilities,
  SpawnRequest,
  SessionResult,
  SessionHandle,
  EnvReport,
  HarnessAdapter,
  Settings,
  Route,
  PricingTable,
  RunOptions,
  RunSummary,
  Engine,
  EngineEvent,
  ExecutionStrategy,
  RoutingDecision,
};

function zodToJsonSchema(zodSchema) {
  if (!zodSchema || !zodSchema._def) return { type: "object" };
  const def = zodSchema._def;
  const typeName = def.typeName;
  switch (typeName) {
    case "ZodString": {
      const s = { type: "string" };
      for (const check of def.checks || []) {
        if (check.kind === "regex") s.pattern = check.regex.source;
        if (check.kind === "min") s.minLength = check.value;
        if (check.kind === "max") s.maxLength = check.value;
      }
      return s;
    }
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNull":
      return { type: "null" };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodArray": {
      const arr = { type: "array", items: zodToJsonSchema(def.type) };
      if (def.minLength) arr.minItems = def.minLength.value;
      return arr;
    }
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties = {};
      const required = [];
      for (const [key, val] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(val);
        if (!val.isOptional?.()) required.push(key);
      }
      const obj = { type: "object", properties };
      if (required.length) obj.required = required;
      if (def.unknownKeys === "strict") obj.additionalProperties = false;
      return obj;
    }
    case "ZodRecord": {
      return {
        type: "object",
        additionalProperties: zodToJsonSchema(def.valueType),
      };
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const opts = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
      return { anyOf: opts.map(zodToJsonSchema) };
    }
    case "ZodOptional":
      return zodToJsonSchema(def.innerType);
    case "ZodNullable":
      return { anyOf: [zodToJsonSchema(def.innerType), { type: "null" }] };
    case "ZodDefault":
      return zodToJsonSchema(def.innerType);
    case "ZodEffects":
      return zodToJsonSchema(def.schema);
    default:
      return { type: "object" };
  }
}

export function exportAllSchemas(outDir = contractsDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, s] of Object.entries(CONTRACT_SCHEMAS)) {
    const jsonSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: name,
      ...zodToJsonSchema(s),
    };
    const target = path.join(outDir, `${name}.schema.json`);
    fs.writeFileSync(target, JSON.stringify(jsonSchema, null, 2) + "\n");
  }
  console.log(`Exported ${Object.keys(CONTRACT_SCHEMAS).length} schemas to ${outDir}`);
}

exportAllSchemas();
