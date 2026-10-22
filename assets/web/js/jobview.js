// The main pane for the selected job: the job header (request, models, status, branch, merged, tokens, cost, elapsed,
// Stop and Resume), the report ("What happened") of a job that ended, the actor bar, the selected actor's transcript
// or log, its attempt blocks (diff and verify), and the live line of the actor that is working.

import { api, ApiError } from "./api.js";
import { diffBlock, expandFolds, verifyBlock } from "./blocks.js";
import { renderEvent } from "./engine.js";
import { markdown } from "./md.js";
import { attemptsOf, isLive, jobOf, sessionsFor, state } from "./store.js";
import { renderItem, Feed } from "./transcript.js";
import { tokensOf } from "./items.js";
import { clear, el, errorMessage, fmtCost, fmtCount, fmtDuration, truncate } from "./util.js";
import { RUN_GLYPH, TASK_WORD } from "./glyphs.js";

const $ = (id) => document.getElementById(id);
const STOP_ARM_MS = 4000;
const TASK_REFRESH_MS = 2500;

const view = {
  ref: null,
  actor: null,
  feed: null,
  key: null,
  reportText: undefined,
  errorShown: null,
  stopArmedUntil: 0,
  facts: {},
  navigate: () => {},
  liveLabel: "",
};

const taskCache = new Map(); // "ref|task" -> { detail, at }
const taskLoading = new Set();
const taskLater = new Set();
const artifactCache = new Map(); // "ref|key" -> Promise<string>

/** Wires the pane's controls. `navigate(actor)` moves the selection (the router keeps the hash in step). */
export function initJobView({ navigate }) {
  view.navigate = navigate;
  $("pane-scroll").addEventListener("scroll", () => view.feed?.noteScroll());
  $("pane-more").addEventListener("click", () => view.feed?.loadEarlier());
  $("jump").addEventListener("click", () => {
    const scroller = $("pane-scroll");
    scroller.scrollTop = scroller.scrollHeight;
    view.feed?.noteScroll();
  });
  $("actor-up").addEventListener("click", () => moveActor("parent"));
  $("actor-prev").addEventListener("click", () => moveActor(-1));
  $("actor-next").addEventListener("click", () => moveActor(1));
}

/** The run's merged view: the summary with the detail's fields on top (the detail is the fresher one). */
export function runView(ref) {
  const summary = state.runs.get(ref);
  const detail = jobOf(ref).detail;
  if (!summary && !detail) return null;
  return { ...summary, ...(detail ?? {}) };
}

function artifactText(ref, key) {
  const cacheKey = `${ref}|${key}`;
  if (!artifactCache.has(cacheKey)) {
    const pending = api.artifactText(ref, key);
    pending.catch(() => artifactCache.delete(cacheKey));
    artifactCache.set(cacheKey, pending);
  }
  return artifactCache.get(cacheKey);
}

/** The actor a job opens on: its running worker, else the engine. */
export function defaultActor(ref) {
  const job = jobOf(ref);
  const running = [...job.sessions.values()].filter((s) => s.role === "worker" && s.ended_at === null).sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  if (isLive(ref) && running.length > 0) return { kind: "session", id: running[running.length - 1].session_id };
  return { kind: "engine" };
}

/** Every actor of a job in tree order: the Planner, the Engine, each task (and its attempts when retried), Integration, Repair. */
export function actorsOf(job) {
  const list = [{ kind: "planner" }, { kind: "engine" }];
  for (const id of job.tasks.keys()) {
    list.push({ kind: "task", id });
    const attempts = attemptsOf(job, id);
    if (attempts.length > 1) for (const a of attempts) list.push({ kind: "session", id: a.session_id });
  }
  if (job.events.some((e) => e.type.startsWith("integration."))) list.push({ kind: "integration" });
  if ([...job.sessions.values()].some((s) => s.role === "repair")) list.push({ kind: "repair" });
  return list;
}

/** The actor as the actor list names it: a task with a single attempt is listed as the task, not the attempt. */
function canonicalActor(job, actor) {
  if (!actor || actor.kind !== "session") return actor;
  const session = job.sessions.get(actor.id);
  if (session?.role === "worker" && session.task_id && attemptsOf(job, session.task_id).length <= 1) {
    return { kind: "task", id: session.task_id };
  }
  return actor;
}

function sameActor(a, b) {
  return a !== null && b !== null && a !== undefined && b !== undefined && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);
}

/** Shows a job and an actor in the pane. `ref` null shows the empty state. */
export function showJob(ref, actor) {
  $("job-empty").hidden = ref !== null;
  $("job").hidden = ref === null;
  if (ref === null) {
    view.ref = null;
    view.feed = null;
    return;
  }
  if (view.ref !== ref) {
    view.ref = ref;
    view.reportText = undefined;
    view.errorShown = null;
    buildHead();
  }
  view.actor = actor ?? defaultActor(ref);
  updateHead();
  buildActorBar();
  mountPane();
}

/** The job changed (a state patch, a detail refresh, or a catch-up). */
export function onJobChanged(ref) {
  if (ref !== view.ref) return;
  updateHead();
  buildActorBar();
  if (keyOf(jobOf(ref), view.actor) !== view.key) mountPane();
  else if (view.errorShown !== jobOf(ref).error) renderTop();
  if (view.actor && (view.actor.kind === "task" || view.actor.kind === "session")) refreshTask(ref, taskIdOf(view.actor));
}

/** New engine events for the job. */
export function onEngineChanged(ref) {
  if (ref !== view.ref || view.actor?.kind !== "engine") return;
  view.feed?.sync();
}

/** New transcript lines for a session of the job. */
export function onTranscriptChanged(ref) {
  if (ref !== view.ref || !view.actor) return;
  if (keyOf(jobOf(ref), view.actor) !== view.key) mountPane();
  else view.feed?.sync();
}

/** Once a second: the elapsed times and the live line. */
export function tickJobView() {
  if (view.ref === null) return;
  const run = runView(view.ref);
  if (run && view.facts.elapsed) view.facts.elapsed.textContent = fmtDuration(liveElapsed(run));
  const label = liveLabel(view.ref, view.actor);
  const live = $("live");
  live.hidden = label === "";
  if (label !== "" && live.dataset.text !== label) {
    live.dataset.text = label;
    live.replaceChildren(el("span", { class: "spin", "aria-hidden": "true" }), el("span", { text: label }));
  }
}

function liveElapsed(run) {
  if (run.live !== true) return run.elapsed_ms ?? 0;
  const started = Date.parse(run.started_at);
  return Number.isNaN(started) ? run.elapsed_ms ?? 0 : Date.now() - started;
}

function keyOf(job, actor) {
  if (!actor) return "";
  if (actor.kind === "engine") return "engine";
  if (actor.kind === "integration") return "integration";
  return sessionsFor(job, actor)
    .map((s) => s.session_id)
    .join(",");
}

function taskIdOf(actor) {
  if (actor.kind === "task") return actor.id;
  const session = jobOf(view.ref).sessions.get(actor.id);
  return session?.task_id ?? null;
}

function itemsOf(job, actor) {
  return sessionsFor(job, actor).flatMap((s) => job.cursors.get(s.session_id)?.items ?? []);
}

function buildHead() {
  const head = $("job-head");
  clear(head);
  view.facts = {};
  const request = el("h1", { class: "job-request", id: "job-request" });
  const more = el("button", {
    type: "button",
    class: "link small",
    hidden: true,
    text: "show full request",
    on: {
      click: () => {
        request.classList.toggle("open");
        updateHead();
      },
    },
  });
  view.facts.request = request;
  view.facts.more = more;
  const fact = (name, label) => {
    const dd = el("dd", { class: "fact-value", id: `fact-${name}` });
    view.facts[name] = dd;
    return el("div", { class: "fact" }, el("dt", { text: label }), dd);
  };
  const facts = el(
    "dl",
    { class: "facts" },
    fact("planner", "planner"),
    fact("worker", "worker"),
    fact("status", "status"),
    fact("branch", "branch"),
    fact("merged", "merged"),
    fact("tokens", "tokens"),
    fact("cost", "cost"),
    fact("elapsed", "elapsed"),
  );
  const stop = el("button", { type: "button", id: "btn-stop", class: "danger", text: "Stop" });
  const resume = el("button", { type: "button", id: "btn-resume", text: "Resume" });
  const message = el("span", { id: "action-msg", class: "action-msg", role: "status" });
  view.facts.message = message;
  const pause = el("p", { id: "pause-note", class: "notice warn", hidden: true });
  view.facts.pause = pause;
  const actions = el("div", { class: "job-actions" }, stop, resume, message);
  head.append(el("div", { class: "job-title" }, request, more), facts, pause, actions);
  // The button handlers were attached in initJobView, so the new buttons need them too.
  stop.addEventListener("click", onStop);
  resume.addEventListener("click", onResume);
  view.facts.stop = stop;
  view.facts.resume = resume;
}

function updateHead() {
  if (view.ref === null || !view.facts.request) return;
  const run = runView(view.ref);
  const job = jobOf(view.ref);
  if (!run) {
    view.facts.request.textContent = job.error ? `Could not load this job: ${job.error}` : "Loading the job...";
    return;
  }
  const request = job.detail?.request ?? run.request ?? "";
  const long = request.includes("\n") || request.length > 120;
  const open = view.facts.request.classList.contains("open");
  const firstLine = request.split("\n")[0];
  view.facts.request.textContent = long && !open ? `${truncate(firstLine, 120)}` : request;
  view.facts.more.hidden = !long;
  view.facts.more.textContent = open ? "show less" : "show full request";
  view.facts.request.classList.toggle("clamped", long && !open);
  const model = (c) => (c ? `${c.provider} ${c.model}${c.effort ? ` (${c.effort})` : ""}` : "-");
  view.facts.planner.textContent = model(run.planner);
  view.facts.worker.textContent = model(run.worker);
  const glyph = RUN_GLYPH[run.status] ?? "?";
  view.facts.status.textContent = `${glyph} ${run.status_word ?? run.status}`;
  view.facts.status.dataset.status = run.status;
  view.facts.branch.textContent = run.branch ?? "-";
  view.facts.merged.textContent = run.merged === true ? "yes" : run.merged === false ? "no" : "-";
  const usage = run.usage;
  view.facts.tokens.textContent = usage ? `in ${fmtCount(usage.input_tokens)} / out ${fmtCount(usage.output_tokens)}` : "-";
  view.facts.cost.textContent = fmtCost(usage);
  view.facts.elapsed.textContent = fmtDuration(liveElapsed(run));
  const live = run.live === true;
  view.facts.stop.disabled = !live;
  view.facts.stop.textContent = Date.now() < view.stopArmedUntil ? "Confirm stop" : "Stop";
  view.facts.resume.disabled = live || run.status === "finished";
  const questions = run.pause_question;
  view.facts.pause.hidden = !questions;
  view.facts.pause.textContent = questions ? `Paused with questions: ${questions}. Answer them with substrate resume in the CLI.` : "";
  if (job.detail && job.detail.report_text !== view.reportText) {
    view.reportText = job.detail.report_text;
    renderReport(run, job.detail.report_text);
  }
}

/** The report of a job that ended, as "What happened". Failed jobs open it. */
function renderReport(run, text) {
  const slot = $("report-slot");
  clear(slot);
  if (!text || run.live) return;
  const failed = run.status === "failed" || run.status === "stopped" || run.status === "interrupted";
  const body = el("div", { class: "report-body" }, markdown(text));
  slot.append(
    el(
      "details",
      { class: failed ? "report failed" : "report", open: failed },
      el("summary", { text: "What happened" }),
      body,
    ),
  );
}

async function onStop() {
  const ref = view.ref;
  if (!ref) return;
  if (Date.now() >= view.stopArmedUntil) {
    view.stopArmedUntil = Date.now() + STOP_ARM_MS;
    view.facts.message.textContent = "Press Stop again to end the job.";
    updateHead();
    setTimeout(() => {
      if (Date.now() >= view.stopArmedUntil) {
        view.facts.message.textContent = "";
        updateHead();
      }
    }, STOP_ARM_MS + 50);
    return;
  }
  view.stopArmedUntil = 0;
  view.facts.message.textContent = "Stopping...";
  try {
    await api.stop(ref);
    view.facts.message.textContent = "Stopping. The job ends within a few seconds.";
  } catch (err) {
    view.facts.message.textContent = `Could not stop: ${errorMessage(err)}`;
  }
  updateHead();
}

async function onResume() {
  const ref = view.ref;
  if (!ref) return;
  view.facts.message.textContent = "Resuming...";
  try {
    await api.resume(ref);
    view.facts.message.textContent = "Resuming. The job shows as running once the planner or engine starts.";
  } catch (err) {
    view.facts.message.textContent = `Could not resume: ${errorMessage(err)}`;
  }
  updateHead();
}

function labelOf(job, actor) {
  switch (actor.kind) {
    case "planner":
      return { title: "Planner", meta: runView(view.ref)?.planner ? `${runView(view.ref).planner.provider} ${runView(view.ref).planner.model}` : "" };
    case "engine":
      return { title: "Engine", meta: "the substrate worker: plain code that sequences tasks and checks them" };
    case "integration":
      return { title: "Integration", meta: "merges the passed tasks and runs the plan's final checks" };
    case "repair":
      return { title: "Repair", meta: "tries to fix a failed final check without loosening it" };
    case "task": {
      const row = job.tasks.get(actor.id);
      const attempts = attemptsOf(job, actor.id);
      const latest = attempts[attempts.length - 1];
      const where = latest ? `g${latest.generation} a${latest.attempt}` : "";
      return {
        title: `Task ${actor.id}${row ? ` ${truncate(row.title, 60)}` : ""}`,
        meta: [row ? TASK_WORD[row.state] ?? row.state : "", where].filter(Boolean).join(" | "),
      };
    }
    case "session": {
      const s = job.sessions.get(actor.id);
      if (!s) return { title: "Session", meta: actor.id };
      if (s.role === "worker") return { title: `Task ${s.task_id} g${s.generation} a${s.attempt}`, meta: `${s.backend} ${s.model}` };
      if (s.role === "repair") return { title: "Repair attempt", meta: `${s.backend} ${s.model}` };
      return { title: s.role === "planner_chat" ? "Planner chat turn" : "Planner", meta: `${s.backend} ${s.model}` };
    }
    default:
      return { title: actor.kind, meta: "" };
  }
}

function buildActorBar() {
  if (!view.actor || view.ref === null) return;
  const job = jobOf(view.ref);
  const label = labelOf(job, view.actor);
  $("actor-title").textContent = label.title;
  $("actor-meta").textContent = label.meta;
  $("actor-up").disabled = view.actor.kind !== "session" && view.actor.kind !== "task";
  const list = actorsOf(job);
  const index = list.findIndex((a) => sameActor(a, canonicalActor(job, view.actor)));
  $("actor-prev").disabled = index <= 0;
  $("actor-next").disabled = index < 0 || index >= list.length - 1;
}

/** Moves to the previous, next or parent actor (the `[`, `]` and `^` keys). */
export function moveActor(step) {
  if (view.ref === null || !view.actor) return;
  const job = jobOf(view.ref);
  if (step === "parent") {
    if (view.actor.kind === "session") {
      const s = job.sessions.get(view.actor.id);
      if (s?.task_id && job.tasks.has(s.task_id)) view.navigate({ kind: "task", id: s.task_id });
    } else if (view.actor.kind === "task") {
      return;
    }
    return;
  }
  const list = actorsOf(job);
  const index = list.findIndex((a) => sameActor(a, canonicalActor(job, view.actor)));
  const target = list[index + step];
  if (target) view.navigate(target);
}

function mountPane() {
  if (view.ref === null || !view.actor) return;
  const ref = view.ref;
  const actor = view.actor;
  const job = jobOf(ref);
  view.key = keyOf(job, actor);
  const scroller = $("pane-scroll");
  const container = $("pane-feed");
  const isIntegration = actor.kind === "integration";
  container.hidden = isIntegration;
  $("pane-more").hidden = true;
  view.feed = isIntegration
    ? null
    : new Feed({
        scroller,
        container,
        more: $("pane-more"),
        getItems: () => (actor.kind === "engine" ? jobOf(ref).events : itemsOf(jobOf(ref), actor)),
        render: actor.kind === "engine" ? renderEvent : renderItem,
        onPending: showPending,
      });
  view.feed?.reset();
  renderTop();
  renderBottom();
  // A live actor follows its newest output; a finished one opens at the top, where its work starts.
  scroller.scrollTop = isLive(ref) && actor.kind !== "integration" ? scroller.scrollHeight : 0;
  showPending(0);
  tickJobView();
}

/** The "Jump to latest" pill counts output that arrives while a live job is read above its end. */
function showPending(count) {
  const pill = $("jump");
  pill.hidden = count === 0 || view.ref === null || !isLive(view.ref);
  pill.textContent = `Jump to latest (${count} new)`;
}

function renderTop() {
  if (view.ref === null || !view.actor) return;
  const ref = view.ref;
  const job = jobOf(ref);
  const detail = job.detail;
  const top = $("pane-top");
  clear(top);
  view.errorShown = job.error;
  if (job.error) top.append(el("p", { class: "notice err", text: `Could not refresh this job (${job.error}). Retrying...` }));
  const actor = view.actor;
  if (actor.kind === "planner") {
    const files = (detail?.artifacts ?? []).filter((a) => a.kind === "plan_file" || a.kind === "spec");
    if (files.length > 0) top.append(artifactList("Plan files", files));
  } else if (actor.kind === "engine") {
    const logs = (detail?.artifacts ?? []).filter((a) => a.kind === "progress_log");
    if (logs.length > 0) top.append(artifactList("Progress log", logs));
  } else if (actor.kind === "integration") {
    top.append(integrationBlock(job, detail));
  } else if (actor.kind === "task" || actor.kind === "session") {
    const taskId = taskIdOf(actor);
    const cached = taskId ? taskCache.get(`${ref}|${taskId}`)?.detail : undefined;
    if (cached?.spec_markdown) {
      top.append(el("details", { class: "spec" }, el("summary", { text: "Task spec" }), markdown(cached.spec_markdown)));
    }
  }
}

function artifactList(title, artifacts) {
  const list = el("div", { class: "artifact-list" }, el("h3", { text: title }));
  for (const artifact of artifacts) {
    const body = el("div", { class: "artifact-body" });
    let loaded = false;
    const details = el(
      "details",
      {
        class: "artifact",
        on: {
          toggle: async () => {
            if (!details.open || loaded) return;
            loaded = true;
            body.textContent = "loading...";
            try {
              const text = await artifactText(view.ref, artifact.key);
              body.replaceChildren(artifact.kind === "plan_file" || artifact.kind === "spec" || artifact.kind === "report" ? markdown(text) : el("pre", { class: "out", text: text || "(empty)" }));
            } catch (err) {
              loaded = false;
              body.textContent = `Could not load ${artifact.label}: ${errorMessage(err)}`;
            }
          },
        },
      },
      el("summary", { text: `${artifact.label} (${artifact.bytes} bytes)` }),
      body,
    );
    list.append(details);
  }
  return list;
}

function integrationBlock(job, detail) {
  const block = el("div", { class: "integration" });
  const integration = detail?.integration;
  const verdict = integration?.verdict ?? "pending";
  block.append(el("p", { class: "integration-verdict" }, "Verdict: ", el("strong", { text: verdict.replace(/_/g, " ") })));
  if (integration?.repairs?.length) {
    block.append(el("p", { class: "dim", text: `Repair attempts: ${integration.repairs.map((r) => `${r.attempt} ${r.outcome}`).join(", ")}` }));
  }
  const verify = (detail?.artifacts ?? []).filter((a) => a.kind === "verify_full" && !a.label.includes(", task "));
  if (verify.length > 0) block.append(artifactList("Integration verify output", verify));
  const lines = job.events.filter((e) => e.type.startsWith("integration.") || e.type.startsWith("bisect."));
  for (const event of lines) block.append(renderEvent(event));
  return block;
}

/** The task rows and attempts for the bottom of a task or session: the diff, the verify output and the report. */
function renderBottom() {
  if (view.ref === null || !view.actor) return;
  const bottom = $("pane-bottom");
  clear(bottom);
  const actor = view.actor;
  if (actor.kind !== "task" && actor.kind !== "session") return;
  const ref = view.ref;
  const taskId = taskIdOf(actor);
  if (!taskId) return;
  const sessionId = actor.kind === "session" ? actor.id : latestSession(ref, taskId);
  const cached = taskCache.get(`${ref}|${taskId}`);
  if (!cached) {
    bottom.append(el("p", { class: "dim", text: "Loading the attempt..." }));
    refreshTask(ref, taskId);
    return;
  }
  const attempt = cached.detail.attempts.find((a) => a.session_id === sessionId);
  if (!attempt) {
    const live = isLive(ref);
    bottom.append(el("p", { class: "dim", text: live ? "This attempt has not reported yet. Its diff and verify output appear when it ends." : "No report for this attempt." }));
    return;
  }
  const report = attempt.report;
  const head = el("div", { class: "attempt-head" });
  if (report) {
    const passed = report.status === "passed";
    head.append(el("span", { class: passed ? "badge ok" : "badge err", text: passed ? "passed" : `failed${report.failure_class ? `: ${report.failure_class}` : ""}` }));
    if (report.files_changed?.length) head.append(el("span", { class: "dim", text: ` ${report.files_changed.length} file(s) changed` }));
    bottom.append(head);
    if (!passed && report.failure_class) bottom.append(el("p", { class: "notice err", text: `Failed (${report.failure_class}). ${report.denials?.length ? `Denied: ${report.denials.join("; ")}` : ""}` }));
  }
  if (attempt.patch) {
    const slot = el("div", { class: "diff-slot" }, el("p", { class: "dim", text: "loading the diff..." }));
    bottom.append(el("h3", { text: "Changes" }), slot);
    artifactText(ref, attempt.patch.key)
      .then((text) => slot.replaceChildren(text.trim() ? diffBlock(text) : el("p", { class: "dim", text: "The patch is empty." })))
      .catch((err) => slot.replaceChildren(el("p", { class: "notice err", text: `Could not load the diff: ${errorMessage(err)}` })));
  } else {
    bottom.append(el("p", { class: "dim", text: "No patch for this attempt." }));
  }
  for (const v of attempt.verify ?? []) {
    bottom.append(verifyBlock(v, { loadFull: (key) => artifactText(ref, key) }));
  }
}

function latestSession(ref, taskId) {
  const attempts = attemptsOf(jobOf(ref), taskId);
  return attempts.length > 0 ? attempts[attempts.length - 1].session_id : undefined;
}

/** Loads a task's detail (its attempts, reports and patches) in the background and redraws the bottom when it arrives. */
function refreshTask(ref, taskId) {
  if (!taskId) return;
  const key = `${ref}|${taskId}`;
  const cached = taskCache.get(key);
  if (taskLoading.has(key)) return;
  if (cached && Date.now() - cached.at < TASK_REFRESH_MS) {
    // A change inside the throttle window is picked up when the window closes.
    if (!taskLater.has(key)) {
      taskLater.add(key);
      setTimeout(() => {
        taskLater.delete(key);
        refreshTask(ref, taskId);
      }, TASK_REFRESH_MS - (Date.now() - cached.at) + 20);
    }
    return;
  }
  taskLoading.add(key);
  api
    .task(ref, taskId)
    .then((detail) => {
      taskCache.set(key, { detail, at: Date.now() });
      if (view.ref === ref && view.actor && taskIdOf(view.actor) === taskId) {
        renderTop();
        renderBottom();
      }
    })
    .catch((err) => {
      if (!(err instanceof ApiError) || err.status !== 404) taskCache.set(key, { detail: { attempts: [], spec_markdown: null }, at: Date.now() });
    })
    .finally(() => taskLoading.delete(key));
}

function liveLabel(ref, actor) {
  if (!ref || !actor || !isLive(ref)) return "";
  const job = jobOf(ref);
  if (actor.kind === "engine") {
    const run = runView(ref);
    return run ? `Engine running for ${fmtDuration(liveElapsed(run))} | s stops the job` : "";
  }
  if (!["planner", "repair", "task", "session"].includes(actor.kind)) return "";
  const open = sessionsFor(job, actor).filter((s) => job.cursors.get(s.session_id)?.ended !== true && s.ended_at === null);
  if (open.length === 0) return "";
  const session = open[open.length - 1];
  const cursor = job.cursors.get(session.session_id);
  const started = cursor?.stats.startMs ?? Date.parse(session.started_at);
  const elapsed = Number.isNaN(started) ? 0 : Date.now() - started;
  const tokens = cursor ? tokensOf(cursor) : 0;
  return `Working ${fmtDuration(elapsed)} | ${fmtCount(tokens)} tokens | s stops the job`;
}

/** Expands every fold in the pane (the `e` key). */
export function expandAll() {
  expandFolds($("pane-scroll"));
}

/** The shown job and actor, for the keyboard and the router. */
export function currentSelection() {
  return { ref: view.ref, actor: view.actor };
}
