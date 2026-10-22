// The fetch wrappers of the web API (docs/design/web-ui.md, 5.0 and 5.2). Paths are relative, so the page works on
// whatever host and port the browser opened. Every POST sends the guard headers the server requires.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** A network failure (the service is not answering) is an ApiError with status 0. */
async function send(method, path, body) {
  const headers = { Accept: "application/json" };
  const init = { method, headers, cache: "no-store" };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["X-Substrate-UI"] = "1";
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, "unreachable", `Service unreachable, retrying... (${err.message || "network error"})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const code = data?.error?.code ?? "http";
    const message = data?.error?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message);
  }
  return data;
}

const enc = encodeURIComponent;

function runPath(ref) {
  return `api/runs/${enc(ref)}`;
}

export const api = {
  health: () => send("GET", "api/health"),
  projects: () => send("GET", "api/projects"),
  runs: (limit = 200) => send("GET", `api/runs?limit=${limit}`),
  run: (ref) => send("GET", runPath(ref)),
  task: (ref, taskId) => send("GET", `${runPath(ref)}/tasks/${enc(taskId)}`),
  engine: (ref, after, limit = 500) => send("GET", `${runPath(ref)}/engine?after=${after}&limit=${limit}`),
  transcript: (ref, session, after, limit = 500) =>
    send("GET", `${runPath(ref)}/transcripts/${enc(session)}?after=${after}&limit=${limit}`),
  chat: (ref) => send("GET", `${runPath(ref)}/chat`),
  usage: (since) => send("GET", `api/usage?since=${enc(since)}`),
  postChat: (ref, message) => send("POST", `${runPath(ref)}/chat`, { message }),
  stop: (ref) => send("POST", `${runPath(ref)}/stop`, {}),
  resume: (ref) => send("POST", `${runPath(ref)}/resume`, {}),
  /** An artifact's body as text (logs, verify output, patches, specs, reports). */
  artifactText: async (ref, key) => {
    const res = await fetch(`${runPath(ref)}/artifacts/${enc(key)}`, { cache: "no-store" });
    if (!res.ok) throw new ApiError(res.status, "http", `HTTP ${res.status}`);
    return res.text();
  },
};

export const streamUrls = {
  global: () => "api/stream",
  job: (ref) => `${runPath(ref)}/stream`,
};
