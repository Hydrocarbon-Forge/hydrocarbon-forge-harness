import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import * as Contracts from "../../../src/contracts/index.js";

const EXPECTED = [
  "RunId",
  "TaskId",
  "SessionId",
  "BackendName",
  "Effort",
  "RoleName",
  "TaskClass",
  "PermissionMode",
  "PauseReason",
  "FailureClass",
  "Command",
  "Budget",
  "Manifest",
  "TaskSpecFrontmatter",
  "VerifyResult",
  "UsageRecord",
  "WorkerReport",
  "FailurePacket",
  "Diagnostic",
  "BackendEvent",
  "Capabilities",
  "SpawnRequest",
  "SessionResult",
  "SessionHandle",
  "EnvReport",
  "HarnessAdapter",
  "Settings",
  "Route",
  "PricingTable",
  "RunOptions",
  "RunSummary",
  "Engine",
  "EngineEvent",
  "ExecutionStrategy",
  "RoutingDecision",
];

function repoRoot(): string {
  // test/unit/contracts/*.test.ts -> repo root (three levels up)
  return join(import.meta.dirname, "..", "..", "..");
}

function contractsDir(): string {
  return join(repoRoot(), "contracts");
}

describe("export-schemas: one current JSON Schema per Appendix A declaration", () => {
  it("declares a zod schema for every name the export must cover", () => {
    for (const name of EXPECTED) {
      const v = (Contracts as unknown as Record<string, unknown>)[name] as {
        safeParse?: unknown;
      };
      expect(typeof v?.safeParse, `missing contract schema ${name}`).toBe("function");
    }
  });

  it("has one contracts/<Name>.schema.json per declaration", () => {
    const dir = contractsDir();
    expect(existsSync(dir), `contracts/ dir must exist (generated, committed)`).toBe(true);
    const files = readdirSync(dir);
    for (const name of EXPECTED) {
      expect(files, `missing contracts/${name}.schema.json`).toContain(`${name}.schema.json`);
    }
    // No renamed or extra schema files beyond Appendix A.
    const extras = files.filter(
      (f) => f.endsWith(".schema.json") && !EXPECTED.includes(f.replace(".schema.json", "")),
    );
    expect(extras).toEqual([]);
  });

  it("each generated schema is valid JSON with a schema body", () => {
    const dir = contractsDir();
    for (const name of EXPECTED) {
      const raw = readFileSync(join(dir, `${name}.schema.json`), "utf8");
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(raw);
      }, `${name}.schema.json must be valid JSON`).not.toThrow();
      const obj = parsed as Record<string, unknown>;
      expect(typeof obj, `${name}.schema.json must be an object`).toBe("object");
      const hasBody =
        "type" in obj ||
        "enum" in obj ||
        "properties" in obj ||
        "$ref" in obj ||
        "anyOf" in obj ||
        "allOf" in obj ||
        "oneOf" in obj;
      expect(hasBody, `${name}.schema.json must carry a JSON Schema body`).toBe(true);
    }
  });

  it("generated enum schemas carry their Appendix A literals", () => {
    const dir = contractsDir();
    const backend = JSON.parse(
      readFileSync(join(dir, "BackendName.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const body = JSON.stringify(backend);
    for (const literal of ["claude", "opencode", "agy", "fake"]) {
      expect(body).toContain(literal);
    }
    const strategy = JSON.parse(
      readFileSync(join(dir, "ExecutionStrategy.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(JSON.stringify(strategy)).toContain("direct");
    expect(JSON.stringify(strategy)).toContain("dispatcher");
  });

  it("export script exists for npm run export-schemas", () => {
    const script = join(repoRoot(), "scripts", "export-schemas.mjs");
    expect(existsSync(script), "scripts/export-schemas.mjs must exist").toBe(true);
    const body = readFileSync(script, "utf8");
    // The stub text must be gone: the real exporter regenerates every declaration.
    expect(body).not.toContain("not yet implemented");
    expect(body).toContain("schema");
  });
});
