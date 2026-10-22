// The job list and job view of the web UI (docs/design/web-ui.md, 4 and 5). Plain ES module: no framework, no build.
// Every value from the server is written with textContent, never as HTML.

const UI_HEADER = { "X-Substrate-UI": "1", "Content-Type": "application/json" };

const runs = new Map(); // ref -> RunSummary
let globalStream = null;
let jobStream = null;
let job = null; // { ref, detail, lastSeq, events: [] }

const $ = (id) => document.getElementById(id);

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setConn(text, bad) {
  const node = $("conn");
  node.textContent = text;
  node.className = bad ? "conn bad" : "conn";
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `request failed (${response.status})`);
  return body;
}

function post(path, body) {
  return api(path, { method: "POST", headers: UI_HEADER, body: JSON.stringify(body ?? {}) });
}

function duration(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function money(usage) {
  if (!usage) return "";
  if (usage.cost_source === "unknown") return "cost unknown";
  return `$${usage.cost_usd.toFixed(2)}`;
}

function clock(iso) {
  return iso ? new Date(iso).toLocaleTimeString() : "";
}

function applyTheme() {
  const saved = (() => {
    try {
      return localStorage.getItem("substrate-theme");
    } catch {
      return null;
    }
  })();
  const theme = saved === "light" || saved === "dark" ? saved : null;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $("theme").textContent = `theme: ${theme ?? "system"}`;
}

function cycleTheme() {
  const current = document.documentElement.dataset.theme ?? "system";
  const next = current === "system" ? "light" : current === "light" ? "dark" : "system";
  try {
    if (next === "system") localStorage.removeItem("substrate-theme");
    else localStorage.setItem("substrate-theme", next);
  } catch {
    // Private windows may refuse storage: the choice then lasts for this page only.
  }
  applyTheme();
  if (next !== "system") document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  $("theme").textContent = `theme: ${next}`;
}

// ---- the sidebar: every run of every project, from the service stream ----

function renderSidebar() {
  const all = [...runs.values()];
  const running = all.filter((r) => r.live).sort((a, b) => b.started_at.localeCompare(a.started_at));
  const past = all.filter((r) => !r.live).sort((a, b) => b.started_at.localeCompare(a.started_at));
  $("count-running").textContent = `(${running.length})`;
  $("count-past").textContent = `(${past.length})`;
  fillList($("list-running"), running);
  fillList($("list-past"), past);
}

function fillList(list, rows) {
  list.replaceChildren();
  const current = location.hash.startsWith("#/run/") ? decodeURIComponent(location.hash.slice("#/run/".length)) : null;
  for (const run of rows) {
    const item = el("li");
    const link = document.createElement("a");
    link.href = `#/run/${encodeURIComponent(run.ref)}`;
    link.setAttribute("aria-current", String(run.ref === current));
    link.append(el("span", `${run.live ? "> " : run.status === "finished" ? "+ " : "x "}${run.run_id}`));
    link.append(el("div", `${run.project_name} · ${run.status_word} · ${duration(run.elapsed_ms)}`, "sub"));
    link.append(el("div", run.request, "sub"));
    item.append(link);
    list.append(item);
  }
}

async function loadRuns() {
  const rows = await api("/api/runs?limit=200");
  runs.clear();
  for (const row of rows) runs.set(row.ref, row);
  renderSidebar();
}

function openGlobalStream() {
  globalStream = new EventSource("/api/stream");
  globalStream.addEventListener("run", (event) => {
    const run = JSON.parse(event.data);
    runs.set(run.ref, run);
    renderSidebar();
    if (job && job.ref === run.ref) renderJobHeader();
  });
  globalStream.onopen = () => setConn("connected", false);
  globalStream.onerror = () => setConn("reconnecting", true);
}

// ---- the job view: header, tasks and the engine journal, live over the job's stream ----

function renderJobHeader() {
  const run = job.detail;
  $("job").hidden = false;
  $("empty").hidden = true;
  $("job-request").textContent = run.request || run.run_id;
  $("job-meta").textContent =
    `${run.project_name} · ${run.run_id} · planner ${run.planner.provider}/${run.planner.model} · ` +
    `worker ${run.worker.provider}/${run.worker.model} · branch ${run.branch ?? "none"} · ` +
    `merged ${run.merged === null ? "no" : run.merged ? "yes" : "no"} · in ${run.usage.input_tokens} out ${run.usage.output_tokens} · ${money(run.usage)}`;
  $("job-status").replaceChildren(
    el("strong", run.status_word),
    document.createTextNode(` · elapsed ${duration(run.elapsed_ms)}${run.pause_reason ? ` · ${run.pause_reason}` : ""}`),
  );
  if (run.pause_question) $("job-status").append(el("span", ` · question: ${run.pause_question}`, "warn"));
  $("btn-stop").disabled = !run.live;
  $("btn-resume").disabled = run.live || run.status === "finished";
  renderTasks();
}

function renderTasks() {
  const rows = $("task-rows");
  rows.replaceChildren();
  for (const task of job.detail.tasks) {
    const tr = document.createElement("tr");
    tr.append(
      el("td", `${task.id} ${task.title}`),
      el("td", task.state),
      el("td", `g${task.generation} a${task.attempt}`),
      el("td", task.verify ?? "", task.verify === "failed" || task.verify === "timed_out" ? "bad" : ""),
      el("td", `$${(task.cost_usd ?? 0).toFixed(2)}`),
    );
    rows.append(tr);
  }
}

function renderEvents() {
  const list = $("events");
  list.replaceChildren();
  for (const e of job.events.slice(-300)) {
    const li = el("li");
    li.append(el("span", clock(e.ts), "t"), el("span", e.type), document.createTextNode(` ${summaryOf(e.data)}`));
    list.append(li);
  }
}

function summaryOf(data) {
  if (data === undefined || data === null) return "";
  const text = JSON.stringify(data);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function closeJob() {
  if (jobStream) jobStream.close();
  jobStream = null;
  job = null;
}

async function openJob(ref) {
  if (job && job.ref === ref) return;
  closeJob();
  $("action-msg").textContent = "";
  let detail;
  try {
    detail = await api(`/api/runs/${encodeURIComponent(ref)}`);
  } catch (err) {
    $("job").hidden = true;
    $("empty").hidden = false;
    $("empty").textContent = err.message;
    return;
  }
  job = { ref, detail, lastSeq: 0, events: [] };
  renderJobHeader();
  renderEvents();
  jobStream = new EventSource(`/api/runs/${encodeURIComponent(ref)}/stream`);
  jobStream.addEventListener("engine", (event) => {
    const e = JSON.parse(event.data);
    if (!job || job.ref !== ref || e.seq <= job.lastSeq) return;
    job.lastSeq = e.seq;
    job.events.push(e);
    const li = el("li");
    li.append(el("span", clock(e.ts), "t"), el("span", e.type), document.createTextNode(` ${summaryOf(e.data)}`));
    $("events").append(li);
  });
  jobStream.addEventListener("state", (event) => {
    if (!job || job.ref !== ref) return;
    const patch = JSON.parse(event.data);
    Object.assign(job.detail, patch.run ?? {});
    if (Array.isArray(patch.tasks)) {
      for (const task of patch.tasks) {
        const index = job.detail.tasks.findIndex((t) => t.id === task.id);
        if (index >= 0) job.detail.tasks[index] = task;
        else job.detail.tasks.push(task);
      }
    }
    renderJobHeader();
    if (job.detail.live === false) jobStream.close();
  });
  jobStream.onerror = () => setConn("reconnecting", true);
}

async function act(path) {
  const msg = $("action-msg");
  msg.textContent = "";
  try {
    const accepted = await post(path, {});
    msg.textContent = `${accepted.status}...`;
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "action-msg bad";
  }
}

function route() {
  const hash = location.hash;
  if (hash.startsWith("#/run/")) {
    openJob(decodeURIComponent(hash.slice("#/run/".length)));
  } else {
    closeJob();
    $("job").hidden = true;
    $("empty").hidden = false;
    $("empty").textContent = "Choose a job on the left.";
  }
  renderSidebar();
}

async function boot() {
  applyTheme();
  $("theme").addEventListener("click", cycleTheme);
  $("btn-stop").addEventListener("click", () => {
    if (job) act(`/api/runs/${encodeURIComponent(job.ref)}/stop`);
  });
  $("btn-resume").addEventListener("click", () => {
    if (job) act(`/api/runs/${encodeURIComponent(job.ref)}/resume`);
  });
  window.addEventListener("hashchange", route);
  try {
    await loadRuns();
    setConn("connected", false);
  } catch (err) {
    setConn(`offline: ${err.message}`, true);
  }
  openGlobalStream();
  route();
}

boot();
