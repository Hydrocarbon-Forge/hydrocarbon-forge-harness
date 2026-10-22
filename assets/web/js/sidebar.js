// The sidebar: the project switcher, RUNNING and PAST jobs, and the actor tree of the selected job (Planner, Engine,
// each task with its attempts, Integration and Repair). Each row is a button with a data-nav key so the keyboard can
// walk the list and come back to the same row after a redraw.

import { jobOf, isLive, actorPath, attemptsOf, setProject, state } from "./store.js";
import { runView } from "./jobview.js";
import { RUN_GLYPH, TASK_GLYPH, TASK_WORD } from "./glyphs.js";
import { el, fmtAgo, fmtCost, fmtDuration, truncate } from "./util.js";

const $ = (id) => document.getElementById(id);
let onSelect = () => {};

/** `select(ref, actor)` is called when a job or an actor is chosen. */
export function initSidebar({ select }) {
  onSelect = select;
  $("project-select").addEventListener("change", (event) => {
    setProject(event.target.value);
  });
}

function startedMs(row) {
  const ms = Date.parse(row.started_at);
  return Number.isNaN(ms) ? 0 : ms;
}

function byNewest(a, b) {
  return startedMs(b) - startedMs(a);
}

function selectedRef() {
  return state.selected?.ref ?? null;
}

function selectedActorPath() {
  return state.selected?.actor ? actorPath(state.selected.actor) : null;
}

function renderProjects() {
  const select = $("project-select");
  const key = JSON.stringify([state.project, state.projects.map((p) => [p.id, p.name, p.running_count])]);
  if (select.dataset.key === key) return;
  select.dataset.key = key;
  const options = [el("option", { value: "", text: "All projects" })];
  for (const project of state.projects) {
    const running = project.running_count > 0 ? ` (${project.running_count} running)` : "";
    options.push(el("option", { value: project.id, text: `${project.name}${running}` }));
  }
  select.replaceChildren(...options);
  select.value = state.project ?? "";
  if (select.value !== (state.project ?? "")) select.value = "";
}

function actorButton(ref, actor, label, word, meta, extraClass = "") {
  const path = actorPath(actor);
  const current = selectedRef() === ref && selectedActorPath() === path;
  return el(
    "button",
    {
      type: "button",
      class: `nav actor ${extraClass}`,
      data: { nav: `actor:${ref}:${path}` },
      "aria-current": current ? "true" : null,
      on: { click: () => onSelect(ref, actor) },
    },
    el("span", { class: "actor-name", text: label }),
    el("span", { class: "actor-word", text: word }),
    meta ? el("span", { class: "actor-meta", text: meta }) : null,
  );
}

function treeOf(ref) {
  const job = jobOf(ref);
  const run = runView(ref) ?? {};
  const planner = [...job.sessions.values()]
    .filter((s) => s.role === "planner" || s.role === "planner_chat")
    .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  const lastPlanner = planner[planner.length - 1];
  const plannerRunning = lastPlanner !== undefined && lastPlanner.ended_at === null && isLive(ref);
  const plannerWord = plannerRunning ? "running" : lastPlanner === undefined ? "waiting" : lastPlanner.ok === false ? "failed" : "ok";

  const list = el("ul", { class: "tree", "aria-label": "Actors" });
  list.append(el("li", null, actorButton(ref, { kind: "planner" }, "Planner", plannerWord, run.planner ? run.planner.model : "")));
  list.append(el("li", null, actorButton(ref, { kind: "engine" }, "Engine", run.status_word ?? "", "substrate worker")));

  for (const row of job.tasks.values()) {
    const attempts = attemptsOf(job, row.id);
    const latest = attempts[attempts.length - 1];
    const where = latest ? `g${latest.generation} a${latest.attempt}` : "";
    const word = `${TASK_GLYPH[row.state] ?? "?"} ${TASK_WORD[row.state] ?? String(row.state).toLowerCase()}`;
    const elapsed = row.elapsed_ms ? fmtDuration(row.elapsed_ms) : "";
    const cost = row.cost_usd > 0 ? `$${row.cost_usd.toFixed(2)}` : "";
    const meta = [where, elapsed, cost].filter(Boolean).join(" | ");
    const item = el("li", { class: "task-node" }, actorButton(ref, { kind: "task", id: row.id }, `t${row.id}`, word, meta));
    if (attempts.length > 1) {
      const children = el("ul", { class: "tree tree-children", "aria-label": `attempts of ${row.id}` });
      attempts.forEach((a, index) => {
        const retried = index < attempts.length - 1;
        const word2 = a.ended_at === null || a.ended_at === undefined ? "running" : a.ok ? "ok" : "failed";
        children.append(
          el("li", null, actorButton(ref, { kind: "session", id: a.session_id }, `g${a.generation} a${a.attempt}`, word2, retried ? "retry" : "", retried ? "retried" : "")),
        );
      });
      item.append(children);
    }
    list.append(item);
  }

  if (job.events.some((e) => e.type.startsWith("integration."))) {
    const verdict = job.detail?.integration?.verdict ?? "pending";
    list.append(el("li", null, actorButton(ref, { kind: "integration" }, "Integration", verdict.replace(/_/g, " "), "")));
  }
  const repairs = [...job.sessions.values()].filter((s) => s.role === "repair");
  if (repairs.length > 0) {
    list.append(el("li", null, actorButton(ref, { kind: "repair" }, "Repair", `${repairs.length} attempt(s)`, "")));
  }
  return list;
}

function jobRow(row) {
  const selected = selectedRef() === row.ref;
  const glyph = RUN_GLYPH[row.status] ?? "?";
  const when = row.live ? fmtDuration(Date.now() - startedMs(row)) : fmtAgo(row.started_at);
  const item = el(
    "button",
    {
      type: "button",
      class: `nav job-row st-${row.status}`,
      data: { nav: `run:${row.ref}`, started: row.started_at, live: row.live ? "1" : "0" },
      title: row.request,
      "aria-current": selected ? "true" : null,
      on: { click: () => onSelect(row.ref, null) },
    },
    el("span", { class: "glyph", "aria-hidden": "true", text: glyph }),
    el(
      "span",
      { class: "job-main" },
      el("span", { class: "job-title", text: truncate(row.request || row.run_id, 90) }),
      el(
        "span",
        { class: "job-sub" },
        el("span", { text: row.status_word ?? row.status }),
        " · ",
        el("span", { text: row.project_name }),
        " · ",
        el("span", { class: "when", text: when }),
        " · ",
        el("span", { text: fmtCost(row.usage) }),
      ),
    ),
  );
  const li = el("li", null, item);
  if (selected) li.append(treeOf(row.ref));
  return li;
}

function listSection(title, count, body) {
  return el("section", { class: "side-section" }, el("h2", null, title, " ", el("span", { class: "count", text: `(${count})` })), body);
}

/** Redraws the sidebar. Keeps keyboard focus on the same row when it can. */
export function renderSidebar() {
  renderProjects();
  const root = $("side-list");
  const focusedNav = root.contains(document.activeElement) ? document.activeElement.dataset.nav : null;

  const rows = [...state.runs.values()].filter((r) => state.project === null || r.project_id === state.project);
  const running = rows.filter((r) => r.live).sort(byNewest);
  const past = rows.filter((r) => !r.live).sort(byNewest);
  const sections = [];

  const runningBody = el("ul", { class: "jobs" });
  if (state.runsError && state.runs.size === 0) runningBody.append(el("li", { class: "notice err", text: `Could not load jobs: ${state.runsError}. Retrying...` }));
  else if (running.length === 0) runningBody.append(el("li", { class: "empty", text: "No running jobs." }));
  for (const row of running) runningBody.append(jobRow(row));
  sections.push(listSection("Running", running.length, runningBody));

  const pastBody = el("ul", { class: "jobs" });
  if (rows.length === 0 && state.runs.size === 0 && !state.runsError) {
    pastBody.append(
      el("li", { class: "empty" }, "No jobs yet: run ", el("code", { text: 'substrate run "<request>"' }), " in a project."),
    );
  } else if (past.length === 0) {
    pastBody.append(el("li", { class: "empty", text: "No past jobs yet." }));
  }
  for (const row of past.slice(0, state.pastLimit)) pastBody.append(jobRow(row));
  const more = past.length - state.pastLimit;
  const section = listSection("Past", past.length, pastBody);
  if (more > 0) {
    section.append(
      el("button", {
        type: "button",
        class: "ghost small more",
        text: `Show ${Math.min(50, more)} more (${more} left)`,
        on: {
          click: () => {
            state.pastLimit += 50;
            renderSidebar();
          },
        },
      }),
    );
  }
  sections.push(section);

  const notes = [
    state.conn === "down" ? el("p", { class: "notice err", text: "Service unreachable, retrying..." }) : null,
    state.projectsError && state.projects.length === 0
      ? el("p", { class: "notice err", text: `Could not load projects: ${state.projectsError}` })
      : null,
  ];
  root.replaceChildren(...[...notes, ...sections].filter(Boolean));
  tickSidebar();
  if (focusedNav) {
    const again = [...root.querySelectorAll("[data-nav]")].find((node) => node.dataset.nav === focusedNav);
    if (again) again.focus({ preventScroll: true });
  }
}

/** Once a second: the elapsed time on running rows. */
export function tickSidebar() {
  for (const node of document.querySelectorAll('#side-list .job-row[data-live="1"]')) {
    const ms = Date.parse(node.dataset.started);
    const when = node.querySelector(".when");
    if (when && !Number.isNaN(ms)) when.textContent = fmtDuration(Date.now() - ms);
  }
}

/** The sidebar's keyboard navigation: every focusable row, in order. */
export function navItems() {
  return [...document.querySelectorAll("#side-list [data-nav]")];
}
