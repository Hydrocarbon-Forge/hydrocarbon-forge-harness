import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { RunId, Settings, TaskId } from "../contracts/index.js";
import type { EngineState, TaskState } from "./reducer.js";
import type { TypedEmit } from "./emit.js";
import { getRunBranch } from "../git/index.js";
import { commitContractStubs, ingestPlanDraft } from "../roles/planner.js";
import { parseManifest, typecheckContracts } from "../spec/index.js";
import { appendSystemChat, type AmendmentSummary } from "../store/chat.js";
import { consumeInboxFile, pendingInbox } from "../store/inbox.js";

// W5a (docs/design/web-ui.md, 6.2 and 7): the planner may write an amendment, a full plan in
// runs/<id>/amendments/<chat_id>/. The engine validates it with the plan lint (blockers only), diffs it against
// the run's tasks by id, and applies it: added and changed tasks are pending, dropped tasks are abandoned, and a
// task whose work has started is never changed. Applied amendments reach the scheduler through the same state
// events the plan uses. The inbox (store/inbox.ts) is drained between actions by the effects loop, and on resume.

const MANIFEST = "manifest.yaml";
const REASON_MAX = 2000;

/** Tasks an amendment may add, change or drop: none of them has started a worker. */
const NOT_STARTED = new Set<TaskState>(["PENDING", "READY", "ABANDONED"]);

export interface AmendmentTaskText {
  id: string;
  /** The spec file's text: a change is a different text. */
  text: string;
  state?: TaskState;
}

export interface AmendmentDiff {
  added: string[];
  changed: string[];
  dropped: string[];
  kept_started: string[];
}

/**
 * The diff of an amendment against the run's tasks, by task id (docs/design/web-ui.md, 7.4). An id the run does not
 * have is added. An id whose work has started is kept: its spec is not compared and the amendment cannot change it.
 * A task that has not started and whose spec text differs is changed. A task that has not started and is absent from
 * the amendment is dropped. A task that has started and is absent is simply not touched (it is not reported).
 */
export function diffAmendment(current: AmendmentTaskText[], amended: { id: string; text: string }[]): AmendmentDiff {
  const before = new Map(current.map((t) => [t.id, t]));
  const named = new Set(amended.map((t) => t.id));
  const diff: AmendmentDiff = { added: [], changed: [], dropped: [], kept_started: [] };

  for (const task of amended) {
    const prior = before.get(task.id);
    if (prior === undefined) {
      diff.added.push(task.id);
    } else if (!NOT_STARTED.has(prior.state ?? "PENDING")) {
      diff.kept_started.push(task.id);
    } else if (prior.text !== task.text) {
      diff.changed.push(task.id);
    }
  }
  for (const task of current) {
    const state = task.state ?? "PENDING";
    if (!named.has(task.id) && (state === "PENDING" || state === "READY")) {
      diff.dropped.push(task.id);
    }
  }

  const byId = (a: string, b: string) => a.localeCompare(b);
  return {
    added: diff.added.sort(byId),
    changed: diff.changed.sort(byId),
    dropped: diff.dropped.sort(byId),
    kept_started: diff.kept_started.sort(byId),
  };
}

/** A task an applied amendment adds or changes, with the dependencies and write sets the state needs. */
export interface AmendedTask {
  id: string;
  depends_on: string[];
  write: string[];
  create: string[];
}

export type AmendmentOutcome =
  | { outcome: "rejected"; reason: string }
  | {
      outcome: "applied";
      added: string[];
      changed: string[];
      dropped: string[];
      kept_started: string[];
      warning_count: number;
      tasks: AmendedTask[];
      commit_sha?: string;
    };

export interface AmendmentRequest {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  settings: Settings;
  state: EngineState;
  /** The amendment directory, absolute and inside the run directory. */
  amendDir: string;
}

function truncate(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 3)}...` : text;
}

function readText(dir: string, rel: string): string {
  const file = path.resolve(dir, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** True when `rel`, joined to `dir`, stays inside `dir`. */
function insideDir(dir: string, rel: string): boolean {
  const target = path.resolve(dir, rel);
  const back = path.relative(dir, target);
  return back !== "" && !back.startsWith("..") && !path.isAbsolute(back);
}

/**
 * Validates and applies one amendment. Nothing is written when the amendment is refused, so a refusal leaves the run
 * as it was. An applied amendment writes its contract stubs (through the L2 route: typecheck, then commit on the run
 * branch), its spec files for the tasks it adds or changes, and the run's manifest last. Errors while writing are
 * reported as a refusal; the caller records it.
 */
export async function applyAmendment(req: AmendmentRequest): Promise<AmendmentOutcome> {
  const { runDir, amendDir } = req;
  if (!fs.existsSync(path.join(runDir, MANIFEST))) {
    return { outcome: "rejected", reason: "the run has no plan to amend" };
  }

  const ingested = await ingestPlanDraft({ runDir: amendDir, repoRoot: req.repoRoot, settings: req.settings });
  if (!ingested.ok) {
    return { outcome: "rejected", reason: truncate(`plan lint refused the amendment: ${ingested.diagnostics.join("; ")}`) };
  }

  const currentText = fs.readFileSync(path.join(runDir, MANIFEST), "utf8");
  const currentManifest = parseManifest(currentText, path.join(runDir, MANIFEST));
  const currentRaw = (YAML.parse(currentText) ?? {}) as { tasks?: { id: string; spec: string }[] };
  const amendRaw = (YAML.parse(fs.readFileSync(path.join(amendDir, MANIFEST), "utf8")) ?? {}) as {
    tasks?: { id: string; spec: string }[];
  };
  const currentEntries = currentRaw.tasks ?? [];
  const amendEntries = amendRaw.tasks ?? [];

  const diff = diffAmendment(
    currentEntries.map((t) => ({ id: t.id, text: readText(runDir, t.spec), state: req.state.tasks[t.id as TaskId]?.state })),
    ingested.manifest.tasks.map((t) => ({ id: t.id, text: readText(amendDir, t.spec) })),
  );

  for (const task of ingested.manifest.tasks) {
    if (!insideDir(runDir, task.spec)) {
      return { outcome: "rejected", reason: `task spec path resolves outside the run directory: ${task.spec}` };
    }
  }

  // Contract changes follow the L2 route (src/engine/replan.ts, runL2): typecheck the amended stubs, then commit
  // them on the run branch. Only a change to the contracts takes that route.
  const contracts = ingested.manifest.contracts;
  const contractsChanged =
    JSON.stringify(currentManifest.contracts) !== JSON.stringify(contracts) ||
    contracts.files.some((file) => readText(amendDir, file) !== readText(runDir, file));
  if (contractsChanged) {
    if (contracts.files.some((file) => !insideDir(runDir, file))) {
      return { outcome: "rejected", reason: "a contract file path resolves outside the run directory" };
    }
    const typecheck = await typecheckContracts(amendDir, contracts, { cwd: amendDir });
    if (!typecheck.ok) {
      return {
        outcome: "rejected",
        reason: truncate(`the amended contracts do not typecheck: ${typecheck.diagnostics.map((d) => d.message).join("; ")}`),
      };
    }
  }

  let commitSha: string | undefined;
  try {
    if (contractsChanged) {
      for (const file of contracts.files) {
        const target = path.resolve(runDir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.resolve(amendDir, file), target);
      }
      commitSha = await commitContractStubs(req.repoRoot, req.runId, getRunBranch(req.runId), contracts, runDir);
    }

    // Specs of the tasks the amendment adds or changes; a started task's spec is never written.
    const written = new Set([...diff.added, ...diff.changed]);
    for (const task of ingested.manifest.tasks) {
      if (!written.has(task.id)) continue;
      const target = path.resolve(runDir, task.spec);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.resolve(amendDir, task.spec), target);
    }

    // The manifest: the amendment's tasks, with a kept task's entry as the run has it, plus the run's tasks the
    // amendment left out that are not dropped (started or skipped ones keep their place).
    const kept = new Set(diff.kept_started);
    const currentById = new Map(currentEntries.map((t) => [t.id, t]));
    const dropped = new Set(diff.dropped);
    const tasks: { id: string; spec: string }[] = amendEntries.map((entry) =>
      kept.has(entry.id) ? (currentById.get(entry.id) ?? entry) : entry
    );
    const named = new Set(amendEntries.map((entry) => entry.id));
    for (const entry of currentEntries) {
      if (!named.has(entry.id) && !dropped.has(entry.id)) tasks.push(entry);
    }
    fs.writeFileSync(path.join(runDir, MANIFEST), YAML.stringify({ ...amendRaw, tasks }), "utf8");
  } catch (err: any) {
    return { outcome: "rejected", reason: truncate(`the amendment could not be written: ${err?.message ?? String(err)}`) };
  }

  const tasks: AmendedTask[] = [...diff.added, ...diff.changed].map((id) => {
    const spec = ingested.plan.specs.get(id as TaskId);
    return {
      id,
      depends_on: (spec?.frontmatter.depends_on ?? []) as string[],
      write: spec?.frontmatter.write ?? [],
      create: spec?.frontmatter.create ?? [],
    };
  });

  return {
    outcome: "applied",
    ...diff,
    warning_count: ingested.warnings.length,
    tasks,
    ...(commitSha !== undefined ? { commit_sha: commitSha } : {}),
  };
}

export interface InboxDrainOptions {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  settings: Settings;
  /** `resume` when the drain runs in a resume, `live` otherwise (run.amended applied_at). */
  appliedAt: "live" | "resume";
  getState: () => EngineState;
  /** False while a merge or an exclusive action runs: the amendment waits, since it moves the run branch. */
  mayChange: () => boolean;
  emit: TypedEmit;
}

function list(ids: string[]): string {
  return ids.length > 0 ? ids.join(", ") : "none";
}

/**
 * Processes the run's pending inbox messages oldest first (docs/design/web-ui.md, 6.2). Every processed message is
 * recorded as run.message and moved to inbox/consumed/. A chat message only records its arrival. An amendment is
 * applied when the run is executing and no merge or exclusive action is in flight; a finished or cancelled run
 * refuses it; any other state leaves it, and the drain stops there so messages keep their order. Returns true when
 * an amendment was applied, so the caller can release the tasks it made ready.
 */
export async function drainInbox(opts: InboxDrainOptions): Promise<boolean> {
  let applied = false;

  const refuse = (chatId: string, reason: string, file: string, appliedAt: "live" | "resume"): void => {
    opts.emit("run.amended", {
      chat_id: chatId,
      outcome: "rejected",
      applied_at: appliedAt,
      added: [],
      changed: [],
      dropped: [],
      kept_started: [],
      warning_count: 0,
      reason,
    });
    const amendment: AmendmentSummary = {
      chat_id: chatId,
      outcome: "rejected",
      applied_at: appliedAt,
      added: [],
      changed: [],
      dropped: [],
      kept_started: [],
      reason,
    };
    appendSystemChat(opts.runDir, {
      text: `Amendment refused: ${reason}`,
      status: "refused",
      reply_to: chatId,
      amendment,
    });
    consumeInboxFile(opts.runDir, file);
  };

  for (const entry of pendingInbox(opts.runDir)) {
    if (entry.message === undefined) {
      appendSystemChat(opts.runDir, {
        text: `A message could not be read and was not applied: ${entry.error ?? "unknown error"}`,
        status: "refused",
        reply_to: null,
        amendment: null,
      });
      consumeInboxFile(opts.runDir, entry.file);
      continue;
    }
    const message = entry.message;
    if (message.kind === "chat") {
      opts.emit("run.message", { message_id: entry.n, kind: "chat", chat_id: message.chat_id });
      consumeInboxFile(opts.runDir, entry.file);
      continue;
    }

    const phase = opts.getState().state;
    const appliedAt = opts.appliedAt;
    if (phase === "FINISHED" || phase === "CANCELLED") {
      opts.emit("run.message", { message_id: entry.n, kind: "amendment", chat_id: message.chat_id });
      refuse(message.chat_id, phase === "FINISHED" ? "job finished" : "job cancelled", entry.file, appliedAt);
      continue;
    }
    if (phase !== "EXECUTING" || !opts.mayChange()) break;

    opts.emit("run.message", { message_id: entry.n, kind: "amendment", chat_id: message.chat_id });
    const amendDir = path.resolve(opts.runDir, message.dir);
    if (!insideDir(opts.runDir, message.dir)) {
      refuse(message.chat_id, "the amendment directory is outside the run directory", entry.file, appliedAt);
      continue;
    }
    let result: AmendmentOutcome;
    try {
      result = await applyAmendment({
        runId: opts.runId,
        repoRoot: opts.repoRoot,
        runDir: opts.runDir,
        settings: opts.settings,
        state: opts.getState(),
        amendDir,
      });
    } catch (err: any) {
      result = { outcome: "rejected", reason: truncate(`the amendment could not be applied: ${err?.message ?? String(err)}`) };
    }
    if (result.outcome === "rejected") {
      refuse(message.chat_id, result.reason, entry.file, appliedAt);
      continue;
    }

    if (result.commit_sha !== undefined) {
      opts.emit("contracts.committed", { commit_sha: result.commit_sha });
    }
    opts.emit("run.amended", {
      chat_id: message.chat_id,
      outcome: "applied",
      applied_at: appliedAt,
      added: result.added,
      changed: result.changed,
      dropped: result.dropped,
      kept_started: result.kept_started,
      warning_count: result.warning_count,
      tasks: result.tasks,
    });
    const amendment: AmendmentSummary = {
      chat_id: message.chat_id,
      outcome: "applied",
      applied_at: appliedAt,
      added: result.added,
      changed: result.changed,
      dropped: result.dropped,
      kept_started: result.kept_started,
      reason: null,
    };
    const warnings = result.warning_count === 1 ? "1 lint warning" : `${result.warning_count} lint warnings`;
    appendSystemChat(opts.runDir, {
      text:
        `Amendment applied (${appliedAt}): added ${list(result.added)}; changed ${list(result.changed)}; ` +
        `dropped ${list(result.dropped)}; kept, already started and not changed: ${list(result.kept_started)}. ${warnings}.`,
      status: "answered",
      reply_to: message.chat_id,
      amendment,
    });
    consumeInboxFile(opts.runDir, entry.file);
    applied = true;
  }

  return applied;
}
