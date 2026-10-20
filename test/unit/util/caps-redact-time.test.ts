import { describe, expect, it } from "vitest";

import * as Contracts from "../../../src/contracts/index.js";
import {
  HEAL_TAIL_MAX_BYTES,
  boundedMessage,
  capBytes,
  nowIsoTimestamp,
  redactSecrets,
  takeTail,
} from "../../../src/util/index.js";

describe("util byte caps and tails: keep the tail, flag truncation", () => {
  it("keeps whole output with truncated false under the cap", () => {
    expect(capBytes("hello", 100)).toEqual({ text: "hello", truncated: false });
    expect(takeTail("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("keeps the tail and sets truncated true over the cap", () => {
    const out = capBytes("hello world", 5);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe("world");
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(5);

    const tail = takeTail("abcdef", 3);
    expect(tail).toEqual({ text: "def", truncated: true });
  });

  it("measures in bytes and never splits past the cap", () => {
    const text = "a".repeat(100) + "TAIL";
    const capped = capBytes(text, 10);
    expect(capped.truncated).toBe(true);
    expect(capped.text.endsWith("TAIL")).toBe(true);
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(10);
  });

  it("heal-prompt tails are at most 8 KB per plan §9", () => {
    expect(HEAL_TAIL_MAX_BYTES).toBe(8192);
    const big = "x".repeat(HEAL_TAIL_MAX_BYTES + 100);
    const capped = capBytes(big, HEAL_TAIL_MAX_BYTES);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(HEAL_TAIL_MAX_BYTES);
  });

  it("zero or negative caps reject configuration instead of keeping everything", () => {
    expect(() => capBytes("hi", 0)).toThrow();
    expect(() => capBytes("hi", -1)).toThrow();
    expect(() => takeTail("hi", 0)).toThrow();
    expect(() => takeTail("hi", -5)).toThrow();
  });

  it("exact-cap output is not marked truncated", () => {
    expect(capBytes("12345", 5)).toEqual({ text: "12345", truncated: false });
  });
});

describe("util redaction: secrets never leak", () => {
  it("replaces secret patterns with a placeholder and passes through clean text", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
    const aws = "key AKIAIOSFODNN7EXAMPLE here";
    const redacted = redactSecrets(aws);
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).toContain("[REDACTED]");

    const github = "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here";
    expect(redactSecrets(github)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("redacts denylisted env values passed as extras", () => {
    const secret = "super-secret-value-123";
    const out = redactSecrets(`connect with ${secret} now`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
    expect(redactSecrets("nothing sensitive", [secret])).toBe("nothing sensitive");
  });

  it("handles overlapping patterns without crashing and stays bounded", () => {
    const overlapping = "AKIAIOSFODNN7EXAMPLEAKIAIOSFODNN7EXAMPLE";
    let out = "";
    expect(() => {
      out = redactSecrets(overlapping);
    }).not.toThrow();
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.length).toBeLessThanOrEqual(overlapping.length + 64);
  });

  it("never throws on binary or non-UTF8 input", () => {
    expect(() => redactSecrets("lone surrogate \uD800 end")).not.toThrow();
    expect(() => redactSecrets("\0\0binary\0bytes")).not.toThrow();
    expect(() => redactSecrets("")).not.toThrow();
    const nul = redactSecrets("\0");
    expect(typeof nul).toBe("string");
  });

  it("redacted output never contains the input secret itself", () => {
    const secrets = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "-----BEGIN PRIVATE KEY-----",
    ];
    for (const s of secrets) {
      const out = redactSecrets(`prefix ${s} suffix`, [s]);
      expect(out).not.toContain(s);
    }
  });
});

describe("util message bounds and labelled secrets", () => {
  it("masks sk- keys, bearer tokens and api key values, keeping the label", () => {
    const text =
      "provider rejected sk-test1234567890abcd; Authorization: Bearer abcdefgh12345678; api_key=hunter2hunter2 end";
    const out = redactSecrets(text);
    expect(out).not.toContain("sk-test1234567890abcd");
    expect(out).not.toContain("abcdefgh12345678");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).toContain("api_key=[REDACTED]");
  });

  it("does not mask ordinary words that contain sk", () => {
    expect(redactSecrets("disk-management-tool")).toBe("disk-management-tool");
  });

  it("boundedMessage is one line, trimmed, and at most 2000 characters", () => {
    expect(boundedMessage("  first line\n\n  second   line  ")).toBe("first line second line");
    expect(boundedMessage("x".repeat(2500)).length).toBe(2000);
    expect(boundedMessage("short")).toBe("short");
  });
});

describe("util time: ISO-8601 UTC timestamps", () => {
  it("emits ISO-8601 UTC ending in Z", () => {
    const ts = nowIsoTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(ts.endsWith("Z")).toBe(true);
    const parsed = Date.parse(ts);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(Math.abs(Date.now() - parsed)).toBeLessThan(5_000);
  });

  it("timestamps validate against UsageRecord.at and EngineEvent.ts", () => {
    const ts = nowIsoTimestamp();
    const UsageRecord = (
      Contracts as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean } }>
    ).UsageRecord;
    expect(
      UsageRecord.safeParse({
        backend: "claude",
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        cost_source: "reported",
        at: ts,
      }).success,
    ).toBe(true);
    const EngineEvent = (
      Contracts as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean } }>
    ).EngineEvent;
    expect(
      EngineEvent.safeParse({
        v: 1,
        seq: 1,
        ts,
        run_id: "r_ABCDEFGHIJKL",
        type: "run.created",
        data: {},
      }).success,
    ).toBe(true);
  });
});
