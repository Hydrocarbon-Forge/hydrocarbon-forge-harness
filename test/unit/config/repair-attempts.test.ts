import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../../../src/config/index.js";
import { Settings } from "../../../src/contracts/index.js";

// R12.4: `integration.repair_attempts` is an integer from 0 to 5; the default is 2 (config/index.ts).

function withRepairAttempts(value: unknown) {
  return Settings.safeParse({ ...DEFAULT_SETTINGS, integration: { repair_attempts: value } });
}

describe("integration.repair_attempts (R12.4)", () => {
  it("defaults to 2", () => {
    expect(DEFAULT_SETTINGS.integration?.repair_attempts).toBe(2);
  });

  it("accepts every integer from 0 to 5", () => {
    for (const n of [0, 1, 2, 3, 4, 5]) {
      expect(withRepairAttempts(n).success, String(n)).toBe(true);
    }
  });

  it("rejects 6, a negative value, and a fraction", () => {
    for (const bad of [6, -1, 1.5, "2"]) {
      expect(withRepairAttempts(bad).success, String(bad)).toBe(false);
    }
  });

  it("rejects an unknown key under integration", () => {
    expect(
      Settings.safeParse({ ...DEFAULT_SETTINGS, integration: { repair_attempts: 2, extra: true } }).success,
    ).toBe(false);
  });
});
