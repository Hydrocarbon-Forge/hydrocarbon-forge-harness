import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

// The static client (docs/design/web-ui.md, 4.6 and 5.2): `/` is assets/web/index.html and `/assets/<file>` is
// assets/web/<file>. The assets directory is found the way src/prompts/index.ts finds assets/ (next to this module,
// one or two levels up, so it works from src/ and from the bundle in dist/). A path that leaves the directory, by
// `..` or by a symlink, is not served.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** The directory of the client files: the first candidate that holds index.html. */
export function webRootOf(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "assets", "web"),
    path.join(here, "..", "assets", "web"),
    path.join(here, "..", "..", "assets", "web"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return fs.realpathSync(candidate);
  }
  throw new Error("web UI assets not found (assets/web/index.html)");
}

/** The file a request path names inside `root`, or undefined when the path is not a file the client may read. */
export function fileOfRequest(root: string, urlPath: string): string | undefined {
  let rel: string;
  if (urlPath === "/") {
    rel = "index.html";
  } else if (urlPath.startsWith("/assets/")) {
    try {
      rel = decodeURIComponent(urlPath.slice("/assets/".length));
    } catch {
      return undefined;
    }
  } else {
    return undefined;
  }
  if (rel.length === 0 || rel.includes("\0") || rel.endsWith("/")) return undefined;
  if (rel.split(/[\\/]/).some((segment) => segment === "..")) return undefined;
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return undefined;
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    return undefined;
  }
  if (!real.startsWith(fs.realpathSync(root) + path.sep)) return undefined;
  try {
    return fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Sends a client file, or a 404 (no directory listing). */
export function sendStatic(res: ServerResponse, root: string, urlPath: string): void {
  const file = fileOfRequest(root, urlPath);
  if (file === undefined) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(body);
}
