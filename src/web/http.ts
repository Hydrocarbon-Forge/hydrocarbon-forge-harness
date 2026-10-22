import type { IncomingMessage, ServerResponse } from "node:http";

// The HTTP helpers of the web server (docs/design/web-ui.md, 5.0): JSON responses, the error shape, the POST guards
// and the request body cap. The guards are availability guards for a browser tab, not authentication (DECISIONS A6).

export type ErrorCode =
  | "bad_request"
  | "unsupported"
  | "guard_failed"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unsupported: 415,
  guard_failed: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

/** An error the API answers with: its status and code, and a message a person reads. */
export class ApiError extends Error {
  readonly status: number;

  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

export const BODY_CAP_BYTES = 64 * 1024;

/** A JSON answer. GET answers are not cached (5.0). */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Answers an error: an ApiError as its own status, anything else as 500 with the message only. */
export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: "internal", message } });
}

/**
 * The guards of a state-changing request (5.0): the body is JSON (415 otherwise), the X-Substrate-UI header is 1
 * (403 otherwise), and the Host header names the loopback hostname the server listens on (403 otherwise).
 */
export function checkPostGuards(req: IncomingMessage, allowedHosts: ReadonlySet<string>): void {
  const host = req.headers.host ?? "";
  if (!allowedHosts.has(host)) {
    throw new ApiError("guard_failed", "the Host header must name localhost");
  }
  if (req.headers["x-substrate-ui"] !== "1") {
    throw new ApiError("guard_failed", "the X-Substrate-UI: 1 header is required");
  }
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported", "the request body must be application/json");
  }
}

/** The request body parsed as JSON. A body over the cap or not JSON is bad_request. An empty body is an empty object. */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_CAP_BYTES) {
        reject(new ApiError("bad_request", "the request body is larger than 64 KB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (err) => reject(err));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new ApiError("bad_request", "the request body is not valid JSON"));
      }
    });
  });
}

/** An integer query value within bounds, or the default when the parameter is absent. */
export function intParam(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null || value === "") return fallback;
  if (!/^-?\d+$/.test(value)) throw new ApiError("bad_request", `${name} must be a whole number`);
  const n = Number(value);
  if (n < min || n > max) throw new ApiError("bad_request", `${name} must be from ${min} to ${max}`);
  return n;
}
