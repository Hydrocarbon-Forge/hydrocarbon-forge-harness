// The page: boots the streams and the views, owns the selection, and keeps the status line and the theme.
// Module map: api.js (fetch), stream.js (SSE), store.js (model), sync.js (catch-up), sidebar.js, jobview.js,
// transcript.js, engine.js, chat.js, keys.js, router.js, and the blocks (md.js, blocks.js, items.js, glyphs.js).

import { openGlobalStream, openJobStream } from "./stream.js";
import { onChatChanged, showChat, initChat } from "./chat.js";
import { defaultActor, initJobView, onEngineChanged, onJobChanged, onTranscriptChanged, showJob, tickJobView, moveActor, expandAll, currentSelection } from "./jobview.js";
import { initKeys } from "./keys.js";
import { listenHash, parseHash, writeHash } from "./router.js";
import { initSidebar, renderSidebar, tickSidebar } from "./sidebar.js";
import { actorPath, applyChat, applyEngine, applyStatePatch, applyTranscript, emit, isLive, jobOf, on, putRun, state } from "./store.js";
import { catchUp, loadLists, loadUsage, scheduleCatchUp } from "./sync.js";
import { el, storeGet, storeSet } from "./util.js";

const $ = (id) => document.getElementById(id);
const THEMES = ["system", "light", "dark"];
let jobStream = null;
let jobStreamRef = null;
let renderQueued = false;
let statusQueued = false;

// ---------- theme ----------

function applyTheme(mode) {
  if (mode === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  $("btn-theme").textContent = `theme: ${mode}`;
}

function toggleTheme() {
  const current = storeGet("substrate.ui.theme") || "system";
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  storeSet("substrate.ui.theme", next);
  applyTheme(next);
}

// ---------- drawer (under 720 px) ----------

function openDrawer(open) {
  $("sidebar").classList.toggle("open", open);
  $("scrim").hidden = !open;
  $("btn-drawer").setAttribute("aria-expanded", String(open));
}

// ---------- selection ----------

function select(ref, actor, options = {}) {
  if (ref === null) {
    state.selected = null;
    closeJobStream();
    showJob(null, null);
    showChat(null);
    scheduleRender();
    return;
  }
  const sameJob = jobStreamRef === ref;
  if (!sameJob) openJob(ref);
  const chosen = actor ?? defaultActor(ref);
  state.selected = { ref, actor: chosen };
  if (!options.fromHash) writeHash(ref, chosen, sameJob);
  showJob(ref, chosen);
  if (!sameJob) showChat(ref);
  openDrawer(false);
  scheduleRender();
}

function closeJobStream() {
  if (jobStream) jobStream.close();
  jobStream = null;
  jobStreamRef = null;
}

/** Opens the stream of a job and loads its state. The stream's open event starts a catch-up. */
function openJob(ref) {
  closeJobStream();
  const job = jobOf(ref);
  jobStreamRef = ref;
  job.streamState = "connecting";
  void catchUp(ref);
  jobStream = openJobStream(ref, {
    onOpen: () => {
      job.streamState = "open";
      void catchUp(ref);
      emit("status");
    },
    onEngine: (event) => applyEngine(ref, event),
    onTranscript: (session, line) => applyTranscript(ref, session, line),
    onChat: (message) => applyChat(ref, message),
    onState: (patch) => {
      applyStatePatch(ref, patch);
      scheduleCatchUp(ref);
    },
    onEnded: () => {
      job.streamState = "ended";
      jobStream = null;
      jobStreamRef = null;
      emit("status");
    },
    onDown: () => {
      job.streamState = "reconnecting";
      emit("status");
    },
    isLive: () => isLive(ref),
  });
}

// ---------- rendering ----------

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSidebar();
  });
}

function scheduleStatus() {
  if (statusQueued) return;
  statusQueued = true;
  requestAnimationFrame(() => {
    statusQueued = false;
    renderStatus();
  });
}

function renderStatus() {
  const running = [...state.runs.values()].filter((r) => r.live).length;
  const connection =
    state.conn === "open" ? "connected" : state.conn === "down" ? "Service unreachable, retrying..." : "connecting...";
  const usage = state.usage;
  let cost = "cost today: -";
  if (usage) cost = usage.cost_source === "unknown" && usage.cost_usd === 0 ? "cost today: unknown" : `cost today: $${usage.cost_usd.toFixed(2)}`;
  if (usage && usage.unknown_cost_rows > 0) cost += ` (${usage.unknown_cost_rows} unpriced)`;
  const parts = [
    "localhost",
    el("span", { id: "conn", class: "conn", "data-state": state.conn, text: connection }),
    `${running} running`,
    `${state.projects.length} project${state.projects.length === 1 ? "" : "s"}`,
    cost,
  ];
  $("status-text").replaceChildren(...parts.flatMap((p, i) => (i === 0 ? [p] : [" · ", p])));
  $("status-text").append(el("span", { class: "hint", text: "  ? shortcuts" }));
}

// ---------- boot ----------

function boot() {
  applyTheme(storeGet("substrate.ui.theme") || "system");
  initSidebar({ select: (ref, actor) => select(ref, actor) });
  initJobView({ navigate: (actor) => select(currentSelection().ref, actor) });
  initChat();
  initKeys({
    focusChat: () => $("chat-input").focus(),
    expandAll,
    moveActor,
    openEngine: () => select(currentSelection().ref, { kind: "engine" }),
    toggleTheme,
    openHelp: () => {
      if (!$("help").open) $("help").showModal();
    },
    stop: () => $("btn-stop")?.click(),
    resume: () => $("btn-resume")?.click(),
    focusSelected: () => document.querySelector('#side-list [aria-current="true"]')?.focus(),
    openDrawer,
  });
  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-drawer").addEventListener("click", () => openDrawer(!$("sidebar").classList.contains("open")));
  $("scrim").addEventListener("click", () => openDrawer(false));
  $("btn-help").addEventListener("click", () => $("help").showModal());
  $("help-close").addEventListener("click", () => $("help").close());

  on("runs", () => {
    scheduleRender();
    scheduleStatus();
    if (state.selected && !jobStream && isLive(state.selected.ref)) openJob(state.selected.ref);
  });
  on("job", ({ ref }) => {
    onJobChanged(ref);
    if (state.selected?.ref === ref) scheduleRender();
  });
  on("engine", ({ ref }) => onEngineChanged(ref));
  on("transcript", ({ ref }) => onTranscriptChanged(ref));
  on("chat", ({ ref }) => onChatChanged(ref));
  on("status", () => scheduleStatus());

  const openGlobal = () =>
    openGlobalStream({
      onOpen: () => {
        state.conn = "open";
        emit("status");
        emit("runs");
      },
      onRun: (row) => putRun(row),
      onProject: (project) => {
        const others = state.projects.filter((p) => p.id !== project.id);
        state.projects = [...others, project];
        emit("runs");
      },
      onDown: () => {
        state.conn = "down";
        emit("status");
        emit("runs");
      },
    });
  openGlobal();

  listenHash((ref, actor, options) => {
    const current = state.selected;
    // The hash we just wrote comes back as a hashchange: the selection is already there.
    if (current && ref === current.ref && (actor === null || actorPath(actor) === actorPath(current.actor))) return;
    select(ref, actor, options);
  });

  void loadLists().then(() => {
    const parsed = parseHash(window.location.hash);
    if (parsed) select(parsed.ref, parsed.actor, { fromHash: true });
    scheduleRender();
  });
  void loadUsage();
  setInterval(() => {
    tickSidebar();
    tickJobView();
  }, 1000);
  setInterval(() => void loadUsage(), 30000);
  scheduleStatus();
  scheduleRender();
}

boot();
