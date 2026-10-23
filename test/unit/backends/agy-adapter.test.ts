import { describe, it, expect, vi, afterEach } from "vitest";

import { buildAgyArgv, AgyAdapter } from "../../../src/backends/adapters/agy.js";
import { log } from "../../../src/util/log.js";
import type { PricingTable, SpawnRequest } from "../../../src/contracts/index.js";
import { spawnSupervisedProcess } from "../../../src/backends/process.js";

vi.mock("../../../src/backends/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/backends/process.js")>()),
  spawnSupervisedProcess: vi.fn(),
}));

const samplePricing: PricingTable = {
  asOf: "2026-10-16",
  sources: ["https://ai.google.dev/gemini-api/docs/pricing"],
  models: {
    "gemini-3.8-flash-low": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
      cache_read_per_mtok: 0.075,
    },
    "gemini-3.8-flash": {
      input_per_mtok: 0.75,
      output_per_mtok: 3.75,
      cache_read_per_mtok: 0.075,
    },
  },
};

const baseReq: SpawnRequest = {
  role: "worker",
  cwd: "/worktree/repo",
  prompt: "run task",
  model: "gemini-3.8-flash",
  permission: { allow: ["command"], deny: ["command"] },
};

describe("Agy Argument Builder: buildAgyArgv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the headless argv in the order S3 records", () => {
    const req: SpawnRequest = { ...baseReq, permission: { allow: [], deny: [] } };
    expect(buildAgyArgv(req)).toEqual([
      "-p",
      "run task",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--mode",
      "accept-edits",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "0s",
    ]);
  });

  it("does not pass --denial-tool: real agy has no deny-list flag, permissions live in settings.json (S3)", () => {
    const argv = buildAgyArgv({
      ...baseReq,
      permission: { allow: [], deny: ["command", "Bash"] },
    });
    expect(argv).not.toContain("--denial-tool");
    // The deny list is still not silently dropped: it is reported through stderr,
    // which is the capability's permission_denial_signal.
    expect(new AgyAdapter({ pricing: samplePricing }).capabilities.permission_denial_signal).toBe(
      "stderr"
    );
  });

  it("does not pass --sandbox, which S3 shows grants nothing to a headless run", () => {
    const adapter = new AgyAdapter({ pricing: samplePricing });
    const argv = buildAgyArgv(baseReq);
    expect(argv).not.toContain("--sandbox");
    expect(adapter.capabilities.sandbox_flag).toBe(false);
  });

  it("keeps --print-timeout 0s, verified on the installed binary with `agy --help`", () => {
    const argv = buildAgyArgv(baseReq);
    const idx = argv.indexOf("--print-timeout");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("0s");
  });

  it("passes the effort slugs agy 1.4.0 accepts", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const argv = buildAgyArgv({ ...baseReq, effort });
      const idx = argv.indexOf("--effort");
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe(effort);
    }
  });

  it("omits xhigh with one warn, no clamping", () => {
    const warnSpy = vi.spyOn(log, "warn");
    const argv = buildAgyArgv({ ...baseReq, effort: "xhigh" });
    expect(argv).not.toContain("--effort");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "agy: effort xhigh is not supported by agy 1.4.0; omitted"
    );
  });

  it("omits max with one warn, no clamping, even on a flash model", () => {
    const warnSpy = vi.spyOn(log, "warn");
    const argv = buildAgyArgv({
      ...baseReq,
      model: "gemini-3.8-flash-low",
      effort: "max",
    });
    expect(argv).not.toContain("--effort");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "agy: effort max is not supported by agy 1.4.0; omitted"
    );
  });

  it("combines system rules and the task prompt with the SYSTEM RULES / TASK labels", () => {
    const req: SpawnRequest = {
      ...baseReq,
      prompt: "run task",
      system_append: "Never touch git state.",
    };
    expect(buildAgyArgv(req)[1]).toBe(
      "SYSTEM RULES\nNever touch git state.\n\nTASK\nrun task"
    );
  });

  it("leaves the prompt as given when system_append is empty", () => {
    const req: SpawnRequest = { ...baseReq, system_append: "" };
    expect(buildAgyArgv(req)[1]).toBe("run task");
  });

  it("adds --conversation only when resuming", () => {
    const argv = buildAgyArgv({
      ...baseReq,
      session: { resume: "57faeed3-67d8-4487-ab3e-bd3021af5181" },
    });
    const idx = argv.indexOf("--conversation");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("57faeed3-67d8-4487-ab3e-bd3021af5181");

    expect(buildAgyArgv({ ...baseReq, session: { id: "sess-1" } })).not.toContain(
      "--conversation"
    );
  });
});

describe("Agy Version Pin: validateEnvironment", () => {
  afterEach(() => {
    vi.mocked(spawnSupervisedProcess).mockReset();
  });

  function mockVersionOutput(version: string): void {
    vi.mocked(spawnSupervisedProcess).mockReturnValue({
      wait: () => Promise.resolve({ exitCode: 0, stdoutTail: `${version}\n` }),
    } as never);
  }

  it("uses the settings versionPin when the installed binary matches it", async () => {
    mockVersionOutput("1.4.5");
    const adapter = new AgyAdapter({
      bin: process.execPath,
      pricing: samplePricing,
      versionPin: "1.4.5",
    });

    await expect(adapter.validateEnvironment()).resolves.toEqual({
      ok: true,
      version: "1.4.5",
      pin_matches: true,
      problems: [],
    });
  });

  it("reports a mismatch against the settings versionPin", async () => {
    mockVersionOutput("1.4.2");
    const adapter = new AgyAdapter({
      bin: process.execPath,
      pricing: samplePricing,
      versionPin: "1.4.5",
    });

    const report = await adapter.validateEnvironment();
    expect(report.ok).toBe(true);
    expect(report.pin_matches).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("expected 1.4.5");
    expect(report.problems[0]).toContain("found 1.4.2");
  });

  it("falls back to capabilities.version_pin when no versionPin is set", async () => {
    const adapter = new AgyAdapter({ bin: process.execPath, pricing: samplePricing });

    mockVersionOutput("1.4.2");
    await expect(adapter.validateEnvironment()).resolves.toMatchObject({
      pin_matches: true,
      problems: [],
    });

    mockVersionOutput("1.4.5");
    const report = await adapter.validateEnvironment();
    expect(report.pin_matches).toBe(false);
    expect(report.problems[0]).toContain("expected 1.4.2");
    expect(report.problems[0]).toContain("found 1.4.5");
    expect(adapter.capabilities.version_pin).toBe("1.4.2");
  });
});
