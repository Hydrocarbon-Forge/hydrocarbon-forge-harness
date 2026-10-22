import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

import type {
  BackendName,
  EngineEvent,
  HarnessAdapter,
  Route,
  RunId,
  Settings,
  SpawnRequest,
  TaskId,
  UsageRecord,
  UsageLedgerEntry,
} from "../contracts/index.js";
import { parseManifest, parseTaskSpec } from "../spec/index.js";
import { startHarnessSession } from "../backends/spawn.js";
import { appendUsage, ledgerPaths, toDelta, type UsageTotals } from "../ledger/usage.js";
import { capField, teeTranscript } from "../store/transcript.js";
import { EventStoreImpl } from "../store/event-store.js";
import { appendChatMessage, writeChatLine, type AmendmentSummary, type ChatLine } from "../store/chat.js";
import { writeInboxMessage } from "../store/inbox.js";
import { chatHistoryOf, type ChatMessageView } from "../observe/chat-view.js";
import { readJournal, recordOf, reduceEvents, requestOf, statusWordOf } from "../observe/run-observe.js";
import { plannerCharter } from "../charter/index.js";
import { assembleSystem, loadTemplate } from "../prompts/index.js";
import { render } from "../prompts/render.js";
import { resolvePlannerRoute } from "./router.js";
import { ingestPlanDraft, plannerSpawnBudgetUsd, sessionFailureMessage } from "./planner.js";
import { diffAmendment } from "../engine/amendment.js";
import type { EngineState } from "../engine/reducer.js";
import { isSubstrateProcess, processInfoOf } from "../util/process-control.js";
import { log } from "../util/log.js";

// The planner's chat turn (docs/design/web-ui.md, section 7). One detached process answers the queued messages of a
// run, one at a time, in order. It resumes the run's planner session when one was recorded (otherwise it starts a
// planner_chat session), gives the planner the job's state as a context pack, and reads the reply. When the planner
// wrote an amendment, the turn checks it with the plan lint and, when it passes, hands it to the engine's inbox. The
// engine applies it: live between actions, or on resume. The prompt text is assets/prompts/planner/chat.md.

const CHAT_LOCK_FILE = "chat-turn.lock";
const MANIFEST = "manifest.yaml";
const REPORT_FILE = "REPORT.md";
/** How many engine events, failures and earlier chat messages the planner is given. */
const EVENTS_IN_PACK = 30;
const FAILURES_IN_PACK = 3;
const HISTORY_IN_PACK = 10;
const DETAIL_CHARS = 200;
const HISTORY_TEXT_CHARS = 1000;
const REASON_MAX = 2000;
const NO_TEXT_REPLY = "(the planner gave no text reply)";
/** A chat turn is read-only for the repository: the same denials a planning session gets. */
const DENY_PERMISSIONS = ["git commit", "git push", "git checkout", "git reset", "subagents"];
/** Run states the engine refuses an amendment in (engine/amendment.ts, drainInbox). */
const CANNOT_AMEND = new Set(["FINISHED", "CANCELLED"]);
/**
 * Task states a resume puts back in the queue (engine/engine.ts, reopenData): what a stopped or failed run retries.
 * A chat summary of a run that is not live is taken with these tasks pending, since the engine applies it after the
 * reopen. A live run's tasks keep their states.
 */
const RETRIED_ON_RESUME = new Set<string>(["BLOCKED", "FAILED", "REPLANNING", "HEALING", "VERIFYING", "RUNNING", "SCOPE_CHECK"]);

/** The inputs of the context pack, read from the run directory. */
export interface ChatPackInput {
  charter: string;
  request: string;
  runState: string;
  amendmentDir: string;
  manifest: string;
  tasks: { id: string; title: string; state: string }[];
  failures: { task_id: string; failure_class: string; detail: string }[];
  report: string;
  events: EngineEvent[];
  history: { id: string; role: string; status: string; text: string }[];
  message: string;
}

function detailOf(data: unknown): string {
  return JSON.stringify(data ?? {}).slice(0, DETAIL_CHARS);
}

/**
 * The values of assets/prompts/planner/chat.md: the job's charter, request, manifest, task states, the last failures,
 * the report, the last engine events, the last chat messages and the message to answer. Pure: no file is read here.
 */
export function chatPackOf(input: ChatPackInput): Record<string, string> {
  return {
    charter: input.charter,
    request: input.request,
    run_state: input.runState,
    amendment_dir: input.amendmentDir,
    manifest: capField(input.manifest),
    task_states: input.tasks.map((t) => `- ${t.id} (${t.title}): ${t.state}`).join("\n"),
    failures: input.failures
      .slice(-FAILURES_IN_PACK)
      .map((f) => `- ${f.task_id}: ${f.failure_class}: ${capField(f.detail, DETAIL_CHARS)}`)
      .join("\n"),
    report: capField(input.report),
    events: input.events
      .slice(-EVENTS_IN_PACK)
      .map((e) => `${e.seq} ${e.ts} ${e.type} ${detailOf(e.data)}`)
      .join("\n"),
    history: input.history
      .slice(-HISTORY_IN_PACK)
      .map((m) => `${m.id} ${m.role} (${m.status}): ${capField(m.text, HISTORY_TEXT_CHARS)}`)
      .join("\n"),
    message: input.message,
  };
}

/**
 * The amendment directory a chat message left, as the inbox names it ("amendments/<chat_id>", relative to the run
 * directory), or undefined when the planner wrote no manifest there. A chat id that is not "c<n>" is never a path.
 */
export function detectAmendment(runDir: string, chatId: string): string | undefined {
  if (!/^c\d+$/.test(chatId)) return undefined;
  const rel = path.posix.join("amendments", chatId);
  return fs.existsSync(path.join(runDir, rel, MANIFEST)) ? rel : undefined;
}

const livePid = (pid: number): boolean => {
  const info = processInfoOf(pid);
  return info.alive && isSubstrateProcess(info.args);
};

function lockFileOf(runDir: string): string {
  return path.join(runDir, CHAT_LOCK_FILE);
}

function heldBy(file: string): { pid: number } | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    return typeof data.pid === "number" ? { pid: data.pid } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the run's chat-turn lock for `pid`. A lock held by a live Substrate process refuses (false). A lock whose
 * process is gone is stale and is taken over. A lock file that is still being written (no pid yet, touched in the
 * last few seconds) counts as held. `isAlive` is the pid check; the default reads the process table.
 */
export function takeTurnLock(runDir: string, pid: number, isAlive: (pid: number) => boolean = livePid): boolean {
  const file = lockFileOf(runDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, started_at: new Date().toISOString() }), { flag: "wx" });
      return true;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
    const holder = heldBy(file);
    const held =
      holder === undefined
        ? Date.now() - fs.statSync(file).mtimeMs < 5000
        : holder.pid !== pid && isAlive(holder.pid);
    if (held) return false;
    fs.rmSync(file, { force: true });
  }
  return false;
}

/** Releases the lock when this process holds it. */
export function releaseTurnLock(runDir: string, pid: number): void {
  if (heldBy(lockFileOf(runDir))?.pid === pid) fs.rmSync(lockFileOf(runDir), { force: true });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A failure the person reads as a chat note: what failed, in plain words. */
class ChatTurnFailure extends Error {}

export interface ChatTurnOptions {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  settings: Settings;
  adapters: Partial<Record<BackendName, HarnessAdapter>>;
  env: NodeJS.ProcessEnv;
}

interface Snapshot {
  events: EngineEvent[];
  state: EngineState;
  status: string;
  live: boolean;
}

function snapshotOf(opts: ChatTurnOptions): Snapshot {
  const events = readJournal(opts.runDir, opts.runId);
  const record = recordOf(opts.repoRoot, opts.runId, events);
  return {
    events,
    state: reduceEvents(opts.runId, events),
    status: statusWordOf(record),
    live: record.process?.alive === true,
  };
}

function nextQueued(runDir: string): ChatMessageView | undefined {
  return chatHistoryOf(runDir).find((m) => m.role === "user" && m.status === "queued");
}

function toLine(message: ChatMessageView): ChatLine {
  return { ...message, amendment: message.amendment as AmendmentSummary | null };
}

/**
 * Answers the run's queued chat messages in order (docs/design/web-ui.md, 7.9). Only one turn runs per run: a turn
 * that finds the lock held returns at once, and the holder answers what arrived meanwhile, since it checks the queue
 * again after it releases the lock.
 */
export async function runChatTurn(opts: ChatTurnOptions): Promise<void> {
  for (;;) {
    if (!takeTurnLock(opts.runDir, process.pid)) return;
    try {
      for (let next = nextQueued(opts.runDir); next !== undefined; next = nextQueued(opts.runDir)) {
        await answerMessage(opts, next);
      }
    } finally {
      releaseTurnLock(opts.runDir, process.pid);
    }
    if (nextQueued(opts.runDir) === undefined) return;
  }
}

async function answerMessage(opts: ChatTurnOptions, message: ChatMessageView): Promise<void> {
  const { runDir } = opts;
  writeChatLine(runDir, { ...toLine(message), status: "answering" });
  try {
    const before = snapshotOf(opts);
    const answer = await askPlanner(opts, message, before);
    const amendDir = detectAmendment(runDir, message.id);
    const judged = amendDir === undefined ? undefined : await judgeAmendment(opts, message.id, amendDir);
    appendChatMessage(runDir, {
      role: "planner",
      text: answer.text === "" ? NO_TEXT_REPLY : answer.text,
      status: "answered",
      reply_to: message.id,
      session_id: answer.sessionId,
      amendment: judged?.summary ?? null,
    });
    writeChatLine(runDir, { ...toLine(message), status: "answered" });
    if (judged !== undefined) {
      appendChatMessage(runDir, {
        role: "system",
        text: judged.note,
        status: judged.status,
        reply_to: message.id,
        session_id: null,
        amendment: null,
      });
    }
  } catch (err) {
    const reason = err instanceof ChatTurnFailure ? err.message : `The planner could not answer: ${errorText(err)}`;
    writeChatLine(runDir, { ...toLine(message), status: "failed" });
    appendChatMessage(runDir, {
      role: "system",
      text: `${reason}. Nothing was changed.`,
      status: "failed",
      reply_to: message.id,
      session_id: null,
      amendment: null,
    });
  }
}

/** The planner session the run recorded: the one that wrote its accepted plan, else the one a question paused. */
function plannerSessionIdOf(events: EngineEvent[]): string | undefined {
  for (const e of [...events].reverse()) {
    const id = (e.data as { planner_session_id?: unknown } | undefined)?.planner_session_id;
    if (e.type === "plan.produced" && typeof id === "string" && id !== "") return id;
  }
  for (const e of [...events].reverse()) {
    const id = (e.data as { session_id?: unknown } | undefined)?.session_id;
    if (e.type === "run.paused" && typeof id === "string" && id !== "") return id;
  }
  return undefined;
}

function taskTitlesOf(runDir: string, manifestText: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (manifestText === "") return titles;
  const manifestPath = path.join(runDir, MANIFEST);
  for (const task of parseManifest(manifestText, manifestPath).tasks) {
    try {
      titles.set(task.id, parseTaskSpec(fs.readFileSync(path.join(runDir, task.spec), "utf8"), task.spec).frontmatter.title);
    } catch {
      // A spec that does not parse has no title to show; the id stands alone.
    }
  }
  return titles;
}

function packOf(opts: ChatTurnOptions, message: ChatMessageView, snap: Snapshot): Record<string, string> {
  const { runDir, repoRoot } = opts;
  const manifestPath = path.join(runDir, MANIFEST);
  const manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
  const titles = taskTitlesOf(runDir, manifest);
  const ids = [...titles.keys()];
  for (const id of Object.keys(snap.state.tasks)) {
    if (!ids.includes(id)) ids.push(id);
  }
  const failures = snap.events
    .filter((e) => e.type === "task.failed")
    .map((e) => {
      const data = e.data as { task_id?: unknown; failure_class?: unknown; detail?: unknown };
      return {
        task_id: typeof data.task_id === "string" ? data.task_id : "(no task)",
        failure_class: typeof data.failure_class === "string" ? data.failure_class : "failed",
        detail: typeof data.detail === "string" ? data.detail : "",
      };
    });
  return chatPackOf({
    charter: plannerCharter(path.join(repoRoot, ".substrate")),
    request: requestOf(snap.events),
    runState: `${snap.status}; ${snap.live ? "live: the engine is running now" : "not live"}`,
    amendmentDir: path.posix.join("amendments", message.id),
    manifest,
    tasks: ids.map((id) => ({
      id,
      title: titles.get(id) ?? "",
      state: snap.state.tasks[id as TaskId]?.state ?? "not started",
    })),
    failures,
    report: fs.existsSync(path.join(runDir, REPORT_FILE)) ? fs.readFileSync(path.join(runDir, REPORT_FILE), "utf8") : "",
    events: snap.events,
    history: chatHistoryOf(runDir)
      .filter((m) => m.id !== message.id)
      .map((m) => ({ id: m.id, role: m.role, status: m.status, text: m.text })),
    message: message.text,
  });
}

function addTotals(totals: UsageTotals, record: UsageRecord): UsageTotals {
  return {
    input_tokens: totals.input_tokens + (record.input_tokens ?? 0),
    output_tokens: totals.output_tokens + (record.output_tokens ?? 0),
    cost_usd: totals.cost_usd + (record.cost_usd ?? 0),
  };
}

/**
 * Spends the planner once for the message: the planner session, resumed when the run recorded one, else new. Its
 * transcript goes to the run's transcripts. Throws ChatTurnFailure with the plain reason when it cannot answer.
 */
async function askPlanner(opts: ChatTurnOptions, message: ChatMessageView, snap: Snapshot): Promise<{ text: string; sessionId: string }> {
  const { runDir, settings, adapters } = opts;
  const route = resolvePlannerRoute(settings);
  const adapter = adapters[route.backend];
  if (adapter === undefined) {
    throw new ChatTurnFailure(`The planner could not be started: no harness is set up for ${route.backend}`);
  }
  const prompt = render(loadTemplate("planner/chat.md"), packOf(opts, message, snap));
  const recorded = plannerSessionIdOf(snap.events);
  const sessionId = recorded ?? randomUUID();
  const runCapUsd = settings.budgets?.run?.max_usd;
  const timeoutMin = settings.budgets?.task?.timeout_min;
  const request: SpawnRequest = {
    role: "planner",
    cwd: runDir,
    prompt,
    system_append: assembleSystem("planner", {}),
    model: route.model,
    ...(route.effort !== undefined ? { effort: route.effort } : {}),
    permission: { allow: [runDir], deny: DENY_PERMISSIONS },
    budget: {
      max_usd: plannerSpawnBudgetUsd(runCapUsd, snap.state.usage.total_usd),
      ...(timeoutMin ? { timeout_min: timeoutMin, timeout_ms: timeoutMin * 60 * 1000 } : {}),
    },
    session: recorded !== undefined ? { resume: recorded } : { id: sessionId },
  };

  let handle: Awaited<ReturnType<typeof startHarnessSession>>;
  try {
    handle = await startHarnessSession(adapter, request);
  } catch (err) {
    throw new ChatTurnFailure(`The planner could not be started: ${errorText(err)}`);
  }

  let totals: UsageTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  let sawUsage = false;
  let sessionTotals: UsageTotals | undefined;
  let harnessError: string | undefined;
  const meta = { role: "planner_chat" as const, task_id: null, generation: null, attempt: null, backend: route.backend, model: route.model };
  let res: Awaited<ReturnType<typeof handle.result>>;
  try {
    for await (const evt of teeTranscript(handle.events, runDir, meta, sessionId)) {
      if (evt.type === "error") harnessError = evt.message;
      if (evt.type === "usage" && evt.record) {
        sawUsage = true;
        const { delta, next } = toDelta(sessionTotals, evt.record, Boolean(evt.cumulative));
        sessionTotals = next;
        totals = addTotals(totals, delta);
      }
    }
    res = await handle.result();
  } catch (err) {
    throw new ChatTurnFailure(`The planner session failed: ${errorText(err)}`);
  }
  if (!sawUsage && res.usage) totals = addTotals(totals, res.usage);
  recordChatUsage(opts, route, totals);

  if (!res.ok || (res.exit_code !== null && res.exit_code !== 0)) {
    throw new ChatTurnFailure(sessionFailureMessage(res.exit_code, res.final_text, harnessError, route.backend));
  }
  return { text: res.final_text.trim(), sessionId: res.session_id || sessionId };
}

/**
 * The turn's cost: one line in the project ledger (and the global mirror), so `substrate usage` counts it. While the
 * run is not live its journal also gets a usage.recorded event, so the job totals count it. A live run's journal is
 * the engine's to write (its sequence numbers are the engine's), so a live run's chat cost is in the ledger only.
 */
function recordChatUsage(opts: ChatTurnOptions, route: Route, totals: UsageTotals): void {
  if (totals.input_tokens === 0 && totals.output_tokens === 0 && totals.cost_usd === 0) return;
  const at = new Date().toISOString();
  const record: UsageRecord = {
    backend: route.backend,
    model: route.model,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cost_usd: totals.cost_usd,
    cost_source: "computed",
    at,
  };
  const entry: UsageLedgerEntry = {
    v: 1,
    ts: at,
    project: opts.repoRoot,
    run_id: opts.runId,
    role: "planner_chat",
    backend: route.backend,
    model: route.model,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    cost_usd: record.cost_usd,
    cost_source: "computed",
  };
  try {
    appendUsage(entry, ledgerPaths({ projectRoot: opts.repoRoot, globalEnabled: opts.settings.usage?.global ?? true, env: opts.env }));
  } catch (err) {
    log.warn(`failed to append the chat turn's usage to the ledger: ${errorText(err)}`);
  }
  if (!snapshotOf(opts).live) {
    const store = new EventStoreImpl(opts.runId, { runDir: opts.runDir });
    const last = store.readAllSync().at(-1)?.seq ?? 0;
    store.appendSync({
      v: 1,
      seq: last + 1,
      ts: at,
      run_id: opts.runId,
      type: "usage.recorded",
      data: { record, role: "planner_chat" },
    });
  }
}

interface AmendmentJudgement {
  summary: AmendmentSummary;
  note: string;
  status: "answered" | "refused";
}

function truncate(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 3)}...` : text;
}

function listOf(ids: string[]): string {
  return ids.length > 0 ? ids.join(", ") : "none";
}

function readTextIn(dir: string, rel: string): string {
  const file = path.resolve(dir, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * Checks the amendment the planner wrote and, when it passes, queues it for the engine (docs/design/web-ui.md, 7.5-7.8).
 * The plan lint runs here on the amendment alone (blockers refuse it); the engine runs the same lint again when it
 * applies it. A finished or cancelled run takes no amendment. Nothing is written when the amendment is refused.
 */
async function judgeAmendment(opts: ChatTurnOptions, chatId: string, amendRel: string): Promise<AmendmentJudgement> {
  const { runDir, repoRoot, settings } = opts;
  const rejected = (reason: string, note: string): AmendmentJudgement => ({
    summary: { chat_id: chatId, outcome: "rejected", applied_at: null, added: [], changed: [], dropped: [], kept_started: [], reason },
    note,
    status: "refused",
  });

  const now = snapshotOf(opts);
  if (CANNOT_AMEND.has(now.state.state)) {
    const word = now.state.state === "CANCELLED" ? "cancelled" : "finished";
    return rejected(
      `the job is ${word}`,
      `The job is ${word} and cannot be amended. This reply is text only; start a follow-up job to make the change.`,
    );
  }
  if (!fs.existsSync(path.join(runDir, MANIFEST))) {
    return rejected("the run has no plan to amend", "Amendment refused: the run has no plan to amend. Nothing was changed.");
  }

  const amendDir = path.join(runDir, amendRel);
  const ingested = await ingestPlanDraft({ runDir: amendDir, repoRoot, settings });
  if (!ingested.ok) {
    const reason = truncate(`plan lint refused the amendment: ${ingested.diagnostics.join("; ")}`);
    return rejected(reason, `Amendment refused: ${reason}. Nothing was changed.`);
  }

  const currentRaw = (YAML.parse(fs.readFileSync(path.join(runDir, MANIFEST), "utf8")) ?? {}) as {
    tasks?: { id: string; spec: string }[];
  };
  const diff = diffAmendment(
    (currentRaw.tasks ?? []).map((t) => {
      const state = now.state.tasks[t.id as TaskId]?.state;
      const retried = !now.live && state !== undefined && RETRIED_ON_RESUME.has(state);
      return { id: t.id, text: readTextIn(runDir, t.spec), state: retried ? undefined : state };
    }),
    ingested.manifest.tasks.map((t) => ({ id: t.id, text: readTextIn(amendDir, t.spec) })),
  );

  writeInboxMessage(runDir, { kind: "amendment", chat_id: chatId, dir: amendRel });
  const described =
    `added ${listOf(diff.added)}; changed ${listOf(diff.changed)}; dropped ${listOf(diff.dropped)}; ` +
    `kept, already started and not changed: ${listOf(diff.kept_started)}`;
  return {
    summary: { chat_id: chatId, outcome: "pending", applied_at: null, ...diff, reason: null },
    note: now.live
      ? `Amendment queued: ${described}. The running job applies it between its actions.`
      : `Amendment ready: ${described}. Resume the job to apply it.`,
    status: "answered",
  };
}
