import { describe, expect, it } from "vitest";

import { SUBSTRATE_SCAFFOLD, version } from "../src/index.js";

describe("scaffold smoke", () => {
  it("loads the package entry point", () => {
    expect(SUBSTRATE_SCAFFOLD).toBe(true);
    expect(typeof version).toBe("string");
  });
});
