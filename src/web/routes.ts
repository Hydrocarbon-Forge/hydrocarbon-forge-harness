import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { artifactOfKey } from "../observe/artifacts.js";
import { chatHistoryOf } from "../observe/chat-view.js";
import { engineSliceOf } from "../observe/engine-slice.js";
import {
  detailOf,
  parseRef,
  projectOfId,
  projectRunsOf,
  projectViewsOf,
  RUN_STATUSES,
  runOfRef,
  summaryOf,
  type ProjectRun,
} from "../observe/runs-view.js";
import { listProjects } from "../store/projects.js";
import { taskDetailOf } from "../observe/task-view.js";
import { transcriptFileOf, transcriptSliceOf } from "../observe/transcripts.js";
import { usageReportOf } from "../observe/usage.js";
import { resumeRun, stopRun } from "./control.js";
import { ApiError, checkPostGuards, intParam, readJsonBody, sendError, sendJson } from "./http.js";
import { streamGlobal, streamRun, type StreamRegistry } from "./sse.js";
import { sendStatic } from "./static.js";

// The HTTP routes of the web server (docs/design/web-ui.md, 5.2). Each route reads the run through the observe layer;
// the two POST routes pass the guards first. A chat POST is not registered here (a later package adds it).

/** The API version a client checks; the health answer names it. */
export const API_VERSION = "1";

export interface RouteContext {
  env: NodeJS.ProcessEnv;
  webRoot: string;
  allowedHosts: ReadonlySet<string>;
  streams: StreamRegistry;
  startedAt: string;
}

function notFound(message: string): ApiError {
  return new ApiError("not_found", message);
}

/** A path segment, decoded. A segment that is not valid percent-encoding is a bad request. */
function segmentOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ApiError("bad_request", "a path segment is not valid percent-encoding");
  }
}

/** The run a ref names. A malformed ref is bad_request; an unknown project or run is not_found. */
function requireRun(env: NodeJS.ProcessEnv, ref: string): ProjectRun {
  if (parseRef(ref) === undefined) throw new ApiError("bad_request", "the ref must be <projectId>~<runId> with plain identifiers");
  const run = runOfRef(env, ref);
  if (run === undefined) throw notFound(`no run ${ref}`);
  return run;
}

function listRunsRoute(env: NodeJS.ProcessEnv, url: URL): ProjectRun[] {
  const status = url.searchParams.get("status") ?? undefined;
  if (status !== undefined && status !== "live" && status !== "past" && !(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError("bad_request", "status must be live, past, or a run status");
  }
  const limit = intParam(url.searchParams.get("limit"), 50, 1, 200, "limit");
  const project = url.searchParams.get("project") ?? undefined;
  const rows = projectRunsOf(env, project).filter((row) => {
    const live = row.record.process?.alive === true;
    if (status === "live") return live;
    if (status === "past") return !live;
    if (status !== undefined) return row.record.status === status;
    return true;
  });
  return rows.slice(0, limit);
}

async function postControl(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, ref: string, action: "stop" | "resume"): Promise<void> {
  checkPostGuards(req, ctx.allowedHosts);
  const body = (await readJsonBody(req)) as { answers?: unknown };
  const run = requireRun(ctx.env, ref);
  if (action === "stop") {
    sendJson(res, 202, stopRun(run, ref));
    return;
  }
  let answers: Record<string, string> | undefined;
  if (body.answers !== undefined) {
    const raw = body.answers;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === "string")) {
      throw new ApiError("bad_request", "answers must be an object of strings keyed by question id");
    }
    answers = raw as Record<string, string>;
  }
  sendJson(res, 202, await resumeRun(run, ref, answers));
}

function artifactRoute(res: ServerResponse, ctx: RouteContext, ref: string, key: string): void {
  const run = requireRun(ctx.env, ref);
  if (!/^[0-9a-f]{24}$/.test(key)) throw notFound("no such artifact");
  const entry = artifactOfKey(run.record.runDir, key);
  if (entry === undefined) throw notFound("no such artifact");
  const runDir = fs.realpathSync(run.record.runDir);
  const file = fs.realpathSync(path.join(run.record.runDir, entry.path));
  if (!file.startsWith(runDir + path.sep)) throw notFound("no such artifact");
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": entry.contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Routes one request. Errors become the API's error shape; a stream is answered by its own writer. */
export async function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  try {
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
      if (method !== "GET" && method !== "HEAD") throw notFound("not found");
      sendStatic(res, ctx.webRoot, url.pathname);
      return;
    }
    const parts = url.pathname.split("/").slice(2).map((p, i) => (i === 0 ? p : segmentOf(p)));
    if (method === "GET") {
      await getRoute(req, res, ctx, url, parts);
      return;
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "runs" && (parts[2] === "stop" || parts[2] === "resume")) {
      await postControl(req, res, ctx, parts[1], parts[2]);
      return;
    }
    throw notFound("no such route");
  } catch (err) {
    sendError(res, err);
  }
}

async function getRoute(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, url: URL, parts: string[]): Promise<void> {
  const now = Date.now();
  if (parts.length === 1 && parts[0] === "health") {
    sendJson(res, 200, {
      ok: true,
      version: API_VERSION,
      pid: process.pid,
      started_at: ctx.startedAt,
      projects: listProjects(ctx.env).length,
    });
    return;
  }
  if (parts.length === 1 && parts[0] === "projects") {
    sendJson(res, 200, projectViewsOf(ctx.env));
    return;
  }
  if (parts.length === 1 && parts[0] === "stream") {
    streamGlobal(res, ctx.env, ctx.streams);
    return;
  }
  if (parts.length === 1 && parts[0] === "usage") {
    const since = url.searchParams.get("since") ?? undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new ApiError("bad_request", "since must be an ISO date");
    const project = url.searchParams.get("project") ?? undefined;
    const projectPath = project === undefined ? undefined : (projectOfId(ctx.env, project)?.path ?? project);
    sendJson(res, 200, usageReportOf(ctx.env, { project: projectPath, since }));
    return;
  }
  if (parts[0] !== "runs") throw notFound("no such route");
  if (parts.length === 1) {
    const rows = listRunsRoute(ctx.env, url);
    sendJson(res, 200, rows.map((row) => summaryOf(row, now)));
    return;
  }
  const ref = parts[1];
  if (parts.length === 2) {
    const run = requireRun(ctx.env, ref);
    sendJson(res, 200, detailOf(run, now));
    return;
  }
  const sub = parts[2];
  if (parts.length === 3 && sub === "stream") {
    requireRun(ctx.env, ref);
    streamRun(req, res, ctx.env, ref, ctx.streams);
    return;
  }
  if (parts.length === 3 && sub === "chat") {
    sendJson(res, 200, chatHistoryOf(requireRun(ctx.env, ref).record.runDir));
    return;
  }
  if (parts.length === 3 && sub === "engine") {
    const run = requireRun(ctx.env, ref);
    const after = intParam(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER, "after");
    const limit = intParam(url.searchParams.get("limit"), 500, 1, 1000, "limit");
    sendJson(res, 200, engineSliceOf(run.record.runDir, run.record.runId, after, limit, run.record.process?.alive === true));
    return;
  }
  if (parts.length === 4 && sub === "tasks") {
    const run = requireRun(ctx.env, ref);
    const detail = taskDetailOf(run, parts[3], now);
    if (detail === undefined) throw notFound(`no task ${parts[3]} in ${ref}`);
    sendJson(res, 200, detail);
    return;
  }
  if (parts.length === 4 && sub === "transcripts") {
    const run = requireRun(ctx.env, ref);
    const found = transcriptFileOf(run.record.runDir, parts[3]);
    if (found === undefined) throw notFound(`no session ${parts[3]} in ${ref}`);
    const after = intParam(url.searchParams.get("after"), -1, -1, Number.MAX_SAFE_INTEGER, "after");
    const limit = intParam(url.searchParams.get("limit"), 500, 1, 1000, "limit");
    const slice = transcriptSliceOf(found.file, after, limit, run.record.process?.alive === true);
    sendJson(res, 200, { session: found.session, ...slice });
    return;
  }
  if (parts.length === 4 && sub === "artifacts") {
    artifactRoute(res, ctx, ref, parts[3]);
    return;
  }
  throw notFound("no such route");
}

