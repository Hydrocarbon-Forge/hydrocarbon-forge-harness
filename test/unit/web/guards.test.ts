import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";

import { ApiError, checkPostGuards, intParam } from "../../../src/web/http.js";

function requestWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

// The server names its own bound port in the Host header; the test takes whatever port the process id stands for.
const PORT = String(process.pid);
const HOSTS = new Set(["localhost", `localhost:${PORT}`]);
const GOOD = { host: `localhost:${PORT}`, "x-substrate-ui": "1", "content-type": "application/json" };

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof ApiError ? err.code : "other";
  }
}

describe("web POST guards and query parameters (design section 5.0)", () => {
  it("accepts a request with the loopback Host, the UI header and a JSON body", () => {
    expect(codeOf(() => checkPostGuards(requestWith(GOOD), HOSTS))).toBeUndefined();
  });

  it("refuses another Host, a missing UI header, and a body that is not JSON", () => {
    expect(codeOf(() => checkPostGuards(requestWith({ ...GOOD, host: "evil.example" }), HOSTS))).toBe("guard_failed");
    expect(codeOf(() => checkPostGuards(requestWith({ ...GOOD, "x-substrate-ui": "0" }), HOSTS))).toBe("guard_failed");
    expect(codeOf(() => checkPostGuards(requestWith({ ...GOOD, "content-type": "text/plain" }), HOSTS))).toBe("unsupported");
  });

  it("reads integers within bounds and refuses anything else as bad_request", () => {
    expect(intParam("5", 50, 1, 200, "limit")).toBe(5);
    expect(intParam(null, 50, 1, 200, "limit")).toBe(50);
    expect(codeOf(() => intParam("0", 50, 1, 200, "limit"))).toBe("bad_request");
    expect(codeOf(() => intParam("5x", 50, 1, 200, "limit"))).toBe("bad_request");
  });
});
