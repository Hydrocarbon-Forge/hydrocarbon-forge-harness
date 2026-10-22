# Substrate web UI: design study and API contract

Status: DESIGN, not yet built. Date 2026-10-22. Binding scope is set by `docs/plan/DECISIONS.md` (Note 2026-10-22 (R14)). Where this document and DECISIONS disagree, DECISIONS wins.

This document is for the work packages that build the UI. Section 5 (HTTP API) and section 6 (on-disk additions) are binding for the server and client work. Anything marked **decided here** is a default chosen in this document; the owner may override it.

---

## 1. Goals and non-goals

### Goals
- A browser UI for Substrate, served by an always-on local service (`substrate ui`). It runs as a user-level daemon, so it stays up when no run is active and shows jobs from every project on the machine.
- Two lists: RUNNING jobs and PAST jobs.
- Under a running job, a tree of its actors: the Planner, the Engine (the substrate worker), and one node per task worker, with generation and attempt. Each actor can be opened to read its work: transcript, tool calls, diffs, verify output.
- A chat box that talks to the Planner at any time, with the job in context, to request changes to the plan.
- A job header with the request, models, status, branch, merged yes/no, cost, tokens and elapsed time, and Stop and Resume buttons.
- A look and keyboard model modelled on terminal UIs, especially Claude Code (section 2).
- Plain ES modules for the client: no framework, no build step, no CDN. Files live under `assets/web/`.

### Non-goals
- Authentication, authorisation, TLS, hardening and any security work. Out of scope per DECISIONS A6. The two cheap guards in section 5.0 are availability and correctness guards, not security, and the owner may drop them.
- Remote access. Original non-goal, overridden by the owner on 2026-10-22: the bind address is configurable (`host` in `ui.json`, or `--host`), and the default stays the loopback interface reached as `localhost`. When bound elsewhere, the Host-header guard is skipped and the service is reachable from the network with no authentication. See section 8.2.
- A terminal UI. DECISIONS still lists "A TUI" as out of scope. Bare `substrate` still prints help.
- Editing code, merging, branch management or git operations from the UI. These stay on the CLI. The only write actions are Stop, Resume, Chat and (optional, phase 2) Start job.
- Interactive permission prompts. Workers are headless and their permission decisions belong to the harness. The UI shows denials (`permission.denied`) as events; it does not answer prompts.
- Multi-user or multi-machine views. One machine, one user.

---

## 2. Design study

Each finding has a source. "Verified" means the text was read from that page or document during this study. "Dated" means the source is older than the current product or a third-party account. "Unverified" means it is from general knowledge and no source was read; treat it as a hypothesis for the UI team to check against the running product.

### 2.1 Claude Code (primary reference)

Sources: [Interactive mode](https://code.claude.com/docs/en/interactive-mode), [Subagents](https://code.claude.com/docs/en/sub-agents), [Agent view](https://code.claude.com/docs/en/agent-view), [Commands](https://code.claude.com/docs/en/commands), [Permission modes](https://code.claude.com/docs/en/permission-modes), [Status line](https://code.claude.com/docs/en/statusline), and a dated example of terminal output in [Simon Willison, 11 Oct 2025](https://simonwillison.net/2025/Oct/11/sub-agents).

| Area | Finding | Status |
|---|---|---|
| Transcript view | `Ctrl+O` toggles a transcript viewer that shows detailed tool usage and execution, with a timestamp and the model used on each assistant message. It also expands lines that collapse by default, such as MCP calls. | Verified (interactive mode) |
| Collapsed output | Tool results collapse to one summary line with a hint, e.g. `Found 47 files (ctrl+o to expand)`. | Verified, dated (Simon Willison, Oct 2025) |
| Subagent (Task) rows | A delegation shows as a row with the agent's name and a short description, e.g. `Task(Document index template context)`. On completion: `Done (12 tool uses · 86.4k tokens · 1m 13s)`. Nested subagents form a tree; a row with children shows `(+N)`. | Verified (sub-agents doc; Simon Willison, dated) |
| Background work | `Ctrl+B` moves a running Bash command or agent to the background. `/tasks` lists background shells and subagents; finished ones are marked done and sorted below running work. Background subagents show in a panel below the prompt, which the footer points to with `/tasks to see subagents`. | Verified |
| Subagent transcripts on disk | `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`. Each subagent's transcript is a separate file. | Verified |
| Subagent permissions | Background subagents' permission prompts appear in the main session, naming the subagent. Esc denies that one call without stopping the subagent. | Verified |
| Resume | `/resume` opens a picker of past sessions for the current repository, newest first; running background sessions are marked `bg`. Subagents resume by `SendMessage` to their ID. | Verified (commands, agent view, sub-agents) |
| Agent view | `claude agents` lists background sessions across all projects (scope can be limited by directory). Groups: pinned and needing-input first, then "Ready for review", "Needs input", "Working", "Completed". Icons: Working (animated), Needs input (yellow), Idle (dimmed), Completed (green), Failed (red), Stopped (grey). `Space` opens a peek panel with recent output and a reply box; `Enter`/`→` attaches. | Verified (agent view) |
| Task checklist | Claude's to-do list shows pending, in-progress and complete items, up to five at a time; `Ctrl+T` toggles it. It is separate from the background-task view. | Verified (interactive mode) |
| Spinner line, token count, interrupt hint | The footer shows `esc to interrupt`; the status line receives `cost.total_duration_ms`, `cost.total_api_duration_ms` and context token counts. The exact spinner wording and token display in the transcript were not read. | Footer hint and status fields verified; spinner text Unverified |
| Status line | A user-configured script receives session JSON on stdin (cost, durations, context window, `session_id`, `transcript_path`) and prints a line. It is hidden during permission prompts. | Verified (statusline) |
| Permission prompts | Modes: `default` (Manual), `acceptEdits`, `plan`, `auto`, `bypassPermissions`; cycled with `Shift+Tab`. Prompt options depend on context (e.g. "Yes, and switch to auto mode"). | Verified (permission modes) |
| Queued messages | Messages sent while Claude works are queued; Esc interrupts the turn and keeps the work done so far. | Verified (interactive mode) |
| Diff view | `/diff` lists changed files with added and removed line counts, and shows each file's diff below the list. In wide terminals (144 columns or more) it opens beside the conversation and refreshes as edits land. | Verified (interactive mode) |
| Slash commands | Typed at the start of the message; the menu filters as you type. `/resume`, `/tasks`, `/diff`, `/rewind`, `/usage`, `/statusline`, `/model` are documented. | Verified (commands) |
| Colour and typography | Bullet glyph `●` for assistant or tool lines, `⎿` as the result connector, diff colouring, theme names. | Unverified (general knowledge; not read on a source page) |

### 2.2 OpenCode

OpenCode is a client/server design, with a web mode. This is the closest precedent for an always-on service plus a browser client.

Sources: [Server](https://opencode.ai/docs/server/), [Web](https://opencode.ai/docs/web/), [TUI](https://opencode.ai/docs/tui/), [Agents](https://opencode.ai/docs/agents/); a feature request for a child-session panel, [anomalyco/opencode #15223](https://github.com/anomalyco/opencode/issues/15223).

| Area | Finding | Status |
|---|---|---|
| Client/server split | Running `opencode` starts a TUI and a server; the TUI is a client of that server. `opencode serve` starts a separate headless server. | Verified (server doc) |
| API | An OpenAPI 3.1 spec is served at `/doc` on the server. `GET /global/health`; `GET /global/event` and `GET /event` are SSE streams (the first event on `/event` is `server.connected`). Sessions: `GET`/`POST /session`, and `/session/:id` for get, fork, abort, diff, revert and permission responses. `POST /session/:id/message` waits for a reply; `POST /session/:id/prompt_async` returns 204 at once. | Verified (server doc) |
| Defaults and CORS | `serve` defaults to a fixed port and the loopback hostname; browser origins are allowed only when listed with `--cors`. Basic auth is enabled by an environment password. (The numeric defaults are not reproduced here, per repo rule 8.) | Verified (server doc) |
| Web mode | `opencode web` starts a local server bound to the loopback hostname on a free port (or `--port`) and opens the browser. Its homepage lists and creates sessions and shows connected servers. A terminal TUI can attach to the running web server and both share state. A warning says the server is unsecured without a password. | Verified (web doc) |
| Sessions | `/sessions` (aliases `/resume`, `/continue`) lists sessions; `/new`, `/compact`; a leader key `ctrl+x` prefixes single-key commands. | Verified (TUI doc) |
| Command palette | `ctrl+p` opens it. | Verified (TUI doc) |
| Diffs | `diff_style` is `auto` (fits the terminal width) or `stacked`. | Verified (TUI doc) |
| Tool output | `/details` toggles tool execution details. Shell output from `!` appears as a tool result. | Verified (TUI doc) |
| Child (subagent) sessions | A subagent that creates a child session is entered with `session_child_first` (default leader + Down); inside a child, Right and Left cycle siblings and Up returns to the parent. Subagents inherit the primary agent's model unless they set one. An agent's `color` affects how it appears in the interface. | Verified (agents doc) |
| Child-session panel | The docs do not describe a sidebar listing child sessions. A GitHub feature request asks for a split-pane list of child sessions with status and an `/subagents` command, which suggests no built-in panel at the time it was filed. Date not read. | Partly verified (issue; conflicting reports) |

### 2.3 Antigravity CLI (`agy`)

Sources: [Antigravity CLI getting started, CLI tab](https://antigravity.google/docs/getting-started?tab=cli). Third-party summaries: [computingforgeeks cheat sheet](https://computingforgeeks.com/antigravity-cli-cheat-sheet/), [Flutter docs mirror](https://docs.flutter.cn/ai/antigravity-cli.md).

| Area | Finding | Status |
|---|---|---|
| Launch and rendering | `agy` in a directory opens the TUI; `agy "prompt"` starts with a prompt. First run asks for a colour scheme and a rendering mode: "Alt-Screen" (full-screen buffer) or "Inline" (output stays in terminal history). Workspace trust is confirmed before indexing. | Verified |
| Review screen | `Ctrl+R` opens the review screen. Arrow keys move between files; `Tab` shows inline diffs; `Y` approves; `Esc` closes. | Verified |
| Tool calls | `Ctrl+O` expands or collapses the active tool execution "pill"; `Tab` shows file diffs and tool execution details. | Verified |
| Interrupt and exit | `Ctrl+C` interrupts generation; `Ctrl+D` or `/exit` closes the session. | Verified |
| Subagents | `/agents` switches between active background subagents. The docs describe no separate agent-manager view in the CLI. | Verified (single line) |
| Agent manager, task lists, artifacts | The Agent Manager, task lists, implementation plans and walkthroughs are described for the IDE, not for the CLI. Whether the CLI shows them was not confirmed. | Unverified for the CLI (third-party summary only) |
| Modes and resume | `plan` and accept-edits modes are named; their behaviour and `/resume` were not described on the page read. | Unverified |

Note: the first URL tried for the CLI, `antigravity.google/docs/cli`, redirected to the getting-started page; the findings above come from the page it redirects to.

### 2.4 Synthesis: what to copy, and how Substrate differs

**Copy from Claude Code**
- The transcript is the main pane. A one-line summary per tool call, expandable on demand (`ctrl+o to expand` pattern), and a subagent row that ends with a `tool uses · tokens · time` summary.
- A checklist for the run's tasks (Ctrl+T in Claude; always visible in the job tree here).
- The agent view idea: one list of jobs across projects, grouped by state, with status icons and a peek with a reply box. This is the RUNNING and PAST lists.
- Resume picker and `/tasks`-style background view, folded into the sidebar.
- Status line metrics (elapsed, cost, tokens) and a footer hint for the interrupt key.
- A side diff panel with per-file added and removed counts.

**Copy from OpenCode**
- A client/server split: the engine and the server own the state; the browser is a client that subscribes to SSE. The same REST and SSE surface can be used by a second client later.
- Loopback-only web mode with a free port, and a homepage of sessions.
- A command palette (`ctrl+p`) and a leader-key set of shortcuts.
- Child-session navigation by keyboard (next, previous, parent), mapped to the job tree here (`[` and `]` in section 4).

**Copy from agy**
- A review step with an approve key for a finished task's diff.
- An expand and collapse toggle for tool pills.

**How Substrate differs**
1. Jobs are first-class objects. RUNNING and PAST are the top-level structure; a job is a run with a durable record, not a chat session.
2. Actors are named. The Planner, the Engine (the substrate worker, which is plain code), and the Integration and Repair steps are actors with their own transcript or log. The UI shows them as peers, not as tool calls inside one agent.
3. Workers form a tree per task, with generations and attempts. Claude's subagents are flat rows; here a task can be retried as generation 2 with a fresh attempt counter.
4. The Planner is chat-able. Claude's subagents can be messaged; here the planner's chat changes the plan (section 7).
5. Multi-project and always-on. The service sees every project registered on the machine; no terminal session needs to be open.
6. Durable history. Everything shown is read from `.substrate/runs/<id>/` (events, packets, transcripts) and not from a live process, so a finished job remains fully inspectable after a restart.
7. No interactive permission prompts. Workers are headless. Denials are events to read, not questions to answer.

---

## 3. Concepts

| Concept | What it is | Where it lives | What the UI shows |
|---|---|---|---|
| **Project** | A git repository with a `.substrate/` directory. | Registered in `projects.json` (section 6.1); id is derived (section 5.1). | Sidebar project switcher; name, path, last run time, running count. |
| **Job** | One run (`run_id`, e.g. `r_...`), addressed as `<projectId>~<runId>` (the **ref**). | `.substrate/runs/<run_id>/` | Sidebar entry under RUNNING or PAST; the job header; the actor tree. |
| **Planner** | The strong-model planning actor. Its planning session writes the plan files (`manifest.yaml`, `tasks/<ID>.md`, `decisions.md`, `QUESTIONS.md` when it asks). Each chat turn is a further planner session. | `runs/<id>/transcripts/<session>.jsonl` (role `planner` or `planner_chat`); plan files in the run directory. | Its transcript in time order, with chat turns; the plan files (rendered); the chat box is addressed here. |
| **Engine** | The substrate worker: plain code that sequences tasks, runs checks, commits, merges, and records everything. | `runs/<id>/events.jsonl`, `progress.log`, `inbox/`. | The journal, decoded: one line per event with time, type and a short summary; the progress log; a live "next action" line. |
| **Worker** (per task generation and attempt) | One headless harness process for one task in its own git worktree. | Transcript `transcripts/<session>.jsonl` (role `worker`); `packets/<task>-g<n>-attempt<k>.json`; `packets/*.patch` on failure. | Tool calls, assistant text, diff of the task, verify output, the worker report (status, failure class, files changed, usage). |
| **Integration** | The step that merges passed tasks into the run branch and runs the plan's `integration_verify` commands. | Events (`integration.*`); verify output (artifact, section 6.4). | Verify commands and their output tails; verdict (`passed`, `failed`, `could_not_run`). |
| **Repair** | Up to two repair workers that try to fix a failed integration check without loosening it. | Transcript (role `repair`); events. | Like a worker: transcript, diff, verify output; attempt outcome. |

A task node in the tree groups its attempts (generation `g` and attempt `a`). A job's status is one of the reducer's run statuses: `running`, `planned`, `paused`, `finished`, `failed`, `stopped`, `interrupted`, `cancelled` (the set in `src/cli/run-observe.ts`).

---

## 4. Layout

### 4.1 Wireframe (desktop, about 110 columns)

```text
+--------------------------------------------------------------------------------------------------------------+
| substrate   project: [hydrocarbon-forge-harness v]        [/ search]        [theme]  [?]  [ctrl+k palette]    |
+-----------------------------+--------------------------------------------------------------------------------+
| PROJECTS                    | JOB  r_ZEEOKTFXRD33   "make a snake game in the browser"                       |
|  * hydrocarbon-forge-harn.. | planner claude/plan   worker opencode/work   branch substrate/runs/r_ZEEOK..   |
|    my-other-app             | RUNNING   merged: no   elapsed 12m 04s   cost $0.84   in 210k  out 31k        |
|                             | [ Stop ]  [ Resume ] (greyed while running)                                    |
| RUNNING (1)                 +--------------------------------------------------------------------------------+
|  v r_ZEEOKTFXRD33   12m     | ACTOR: Worker  t2  g1 a2  (opencode)                       [ < ]  [ > ]  [ ^ ]  |
|      Planner           ok   |                                                                                |
|      Engine            >    |  * Read(src/game.js)                                                           |
|      t1 g1 a1         ok    |    | 212 lines                                                                 |
|      t2 g1 a2         run   |  * Bash(npm test)                                                              |
|          > a1 failed        |    | 14 passed, 2 failed   (ctrl+o to expand)                                  |
|      t3 g1 a1         queued|  * I will fix the collision check first.                                       |
|      Integration       --   |  * Edit(src/game.js)                                                           |
|      Repair            --   |    | +3 -1                                                                     |
|                             |    |  +-- src/game.js ---------------------------------------------+           |
| PAST                        |    |  | 41   if (head.x >= W)  ..................  (red -)        |           |
|  + r_QX7A12  snake   2h     |    |  | 42 - if (head.x == W)                                       |           |
|  x r_AB3C99  refactor 1d    |    |  | 42 + if (head.x >= W)                                       |           |
|                             |    |  +---------------------------------------------------------+           |
|                             |  * Bash(npx tsc --noEmit)  (collapsed: 240 lines)   [ctrl+o]                  |
|                             |                                                                                |
|                             |  ( *  Working...  1m 12s  .  84.2k tokens  .  esc to interrupt )              |
+-----------------------------+--------------------------------------------------------------------------------+
| > Ask the planner, e.g. "make the board 12x12"   changes apply to pending tasks only   [ctrl+enter] send     |
+--------------------------------------------------------------------------------------------------------------+
| localhost  .  connected  .  2 running  .  6 projects  .  ?=shortcuts  .  [ctrl+k]=palette                    |
+--------------------------------------------------------------------------------------------------------------+
```

Notes on the wireframe:
- The glyphs (`*` bullet, `|` result connector, `+`, `-` for the diff gutter) stand in for the glyphs the client draws: `●` for an assistant or tool line, `⎿` for a result, red and green rows in the diff block.
- The status words in the sidebar are text, so they stay readable with colour off.

### 4.2 Regions

**Left sidebar (260 px; becomes a slide-in drawer under 720 px)**
- *Project switcher*: a list of projects from `GET /api/projects`. The switcher can show "All projects" (default: RUNNING and PAST show jobs from every project, with the project name on each row).
- *RUNNING*: live jobs, newest first. Each row: short run id, project name, elapsed. Under a running job (expanded by default when selected) the **actor tree**:
  - `Planner`: status `ok`, `running` or `waiting` (plan written, or chat turn in progress); child rows for chat turns when present.
  - `Engine`: the substrate worker; status shows the current phase (`scheduling`, `merging`, `verifying`, `paused`).
  - Task nodes `t<id>` each with their attempts: `g<gen> a<att>`, state glyph, elapsed, cost. A failed attempt that has been retried shows as a child with a `retry` label.
  - `Integration` and `Repair` nodes, present once they start.
- *PAST*: finished, failed, stopped and interrupted jobs, newest first. Glyphs: `+` finished, `x` failed, `-` stopped or interrupted, `!` paused.

**Main pane**
- *Job header* (always visible for the selected job): request (truncated, click to expand), planner and worker models, status, branch, merged yes or no, cost, tokens in and out, elapsed, Stop and Resume buttons. Resume is enabled only for a job that is not running and not finished.
- *Actor bar*: the selected actor's name and attempt, with previous, next and parent controls (`[`, `]`, `^`).
- *Transcript*: a Claude-Code-style stream for the selected actor (section 4.3).
- For the Engine: the journal decoded, plus the progress log. For Integration: verify commands with output blocks.
- For the Planner: its transcript, with chat turns inline, and a "Plan files" tab that renders `manifest.yaml`, the task specs and `decisions.md`.

**Bottom chat box**
- Always visible for a job. Addressed to the Planner, with the job in context (the chat sends the ref).
- Note under the box, always shown: "Changes apply to pending tasks only. Running tasks finish unless stopped."
- Ctrl+Enter sends. A message that cannot be applied says why in the transcript (section 7).

**Status line** (bottom row): connection state, count of running jobs, number of projects, shortcut hints.

### 4.3 Transcript rendering rules

- Assistant text: a bullet line with the text, wrapped at the pane width. Markdown is rendered (code blocks, lists); no raw HTML.
- Tool call: `* Name(argument)`, where the argument is `input_summary` from `tool.call`. The next line is the result connector with `output_summary` from `tool.result`. A failed result is red.
- Long output: a result or a block longer than 6 lines collapses to its first 2 lines and a `(ctrl+o to expand)` hint. `Ctrl+O` (or `o` on a focused row) expands the focused block. Verify output that is truncated shows the tail and a link to the full output artifact.
- Subagent summary (a task finished): `Done (N tool calls · in/out tokens · duration)`.
- Diff block: a header with the file name and `+added -removed` counts; each line gutter-marked red (removed) or green (added); unchanged lines dimmed; collapsed past 40 lines.
- Verify block: each command on its own line with its exit code; the stdout and stderr tails in a monospace block; `timed_out` shown as a distinct label.
- Live actor only: a spinner line at the bottom of the transcript with elapsed time, token count and `esc to interrupt`. Stop (the button, or `s`) ends the job, not the actor alone.
- Timestamps: each assistant turn carries a time on hover and in the transcript's detail mode (`ctrl+o` on a turn).
- Denials (`permission.denied`) render as a yellow line with the tool and reason.
- Errors (`error`) render as a red line with the kind (`rate_limit`, `auth`, `crash`, `timeout`, `protocol`).

### 4.4 Keyboard

| Key | Action |
|---|---|
| `Up` / `Down`, `j` / `k` | Move in the sidebar; `Enter` opens the focused job or actor. |
| `[` / `]` | Previous or next actor in the tree (the child-session pattern from OpenCode). |
| `^` or `Backspace` (empty chat) | Up to the parent actor (task node). |
| `Ctrl+O` | Expand or collapse the focused tool result, or all results when none is focused. `e` expands all in the pane. |
| `Ctrl+Enter` | Send the chat message. `Enter` inserts a newline. |
| `c` | Focus the chat box. `Esc` returns focus to the transcript. |
| `s` | Stop the selected job (asks once for confirmation in the job header). |
| `r` | Resume the selected job (when enabled). |
| `/` | Search across the transcript of the selected actor. |
| `Ctrl+K` | Command palette: switch project, jump to a job, toggle theme, open the plan files, open usage. |
| `t` | Toggle theme (system, light, dark). |
| `?` | Shortcut list. |
| `Esc` | Close a palette, drawer or dialog; from the transcript, return focus to the sidebar. |

Shortcuts that are a single printable key apply only when focus is not in the chat box.

### 4.5 Theme and responsive layout

- Colours are CSS custom properties on `:root`. Dark values apply under `@media (prefers-color-scheme: dark)` (guarded by `:root:not([data-theme="light"])`) and under `:root[data-theme="dark"]`. The `t` key and the palette set `data-theme`.
- Both themes meet WCAG contrast for body text. Status is never shown by colour alone: each state has a word or a glyph.
- Phone width (under 720 px): the sidebar becomes a drawer opened from the job header; the actor tree moves into the drawer; the chat box stays fixed at the bottom; diffs scroll horizontally inside their block only. The page has no horizontal scroll, with a 16 px side gutter.

### 4.6 Client structure (no build step)

```text
assets/web/
  index.html          the shell; links app.css and a single module
  app.css             tokens on :root, dark-mode overrides, layout, phone rules
  js/main.js          boot, routing (hash-based: #/run/<ref>/<actor>), SSE connection
  js/api.js           fetch wrappers; error shape handling
  js/stream.js        EventSource wrappers for /api/stream and /api/runs/:ref/stream
  js/store.js         in-memory model: projects, runs, tasks, transcripts, chat
  js/view/*.js        sidebar.js, job-header.js, transcript.js, diff.js, verify.js, chat.js, palette.js
  js/render/md.js     minimal Markdown renderer (no HTML pass-through)
```

Plain ES modules loaded with `<script type="module">`. No CDN, no framework, no build. Transcript DOM is appended, not re-rendered, so that scroll position and expanded blocks survive live updates.

---

## 5. HTTP API contract

### 5.0 Conventions (binding)

- Base path `/api`. JSON in and out (`application/json; charset=utf-8`). Times are ISO 8601 UTC strings. Durations are integer milliseconds.
- `:ref` is `<projectId>~<runId>` and is URL-encoded. The server validates both parts against `^[A-Za-z0-9_-]+$`.
- Errors: HTTP status plus body `{ "error": { "code": ErrorCode, "message": string } }`.

```ts
type ErrorCode =
  | "bad_request"      // 400: malformed JSON, invalid field, invalid ref
  | "unsupported"      // 415: POST without Content-Type application/json
  | "guard_failed"     // 403: POST without X-Substrate-UI, or (bound to localhost) Host not the loopback name
  | "not_found"        // 404: project, run, task, session, artifact or chat id unknown
  | "conflict"         // 409: stop of a run that is not live; resume of a live run; chat on a job that cannot take it
  | "unavailable"      // 503: the planner session cannot be started (e.g. harness missing)
  | "internal";        // 500
```

- Every POST requires `Content-Type: application/json` and the request header `X-Substrate-UI: 1`. When the server is bound to `localhost`, the `Host` header must also name the loopback hostname; when it is bound to any other address, the Host check is skipped (owner override, 2026-10-22). **Decided here**: these are cheap guards so that a web page in another tab cannot drive the service through a cross-site form post or DNS rebinding. They are not authentication and they are not security hardening (A6). The owner may drop them.
- Request bodies are capped at 64 KB. A chat message is capped at 8000 characters.
- GET responses are not cached (`Cache-Control: no-store`).

### 5.1 Shared types

```ts
type RunStatus =
  | "running" | "planned" | "paused" | "finished"
  | "failed" | "stopped" | "interrupted" | "cancelled";

type Backend = "claude" | "opencode" | "agy";

interface ModelChoice {
  provider: Backend;
  model: string;
  effort: string | null;
}

// Cost and tokens. cost_source "unknown" means the price is missing:
// cost_usd is 0 for that row and the UI must show "unknown", never $0 (DECISIONS A7).
interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_source: "reported" | "computed" | "unknown";  // for a total: "unknown" if any row is unknown
  unknown_cost_rows: number;
}

// Project.id: first 12 hex characters of sha256 over the realpath of the project directory.
// It is derived, not stored, so a project keeps its id while it stays at the same path.
interface Project {
  id: string;                  // "3f9a0c1b2d4e"
  path: string;                // absolute realpath
  name: string;                // basename of path, unless projects.json sets one
  last_run_at: string | null;  // started_at of the newest run in the project
  running_count: number;       // runs with a live lock file
}

interface RunSummary {
  ref: string;                 // "<projectId>~<runId>"
  project_id: string;
  project_name: string;
  run_id: string;
  request: string;             // first line of the request, at most 200 characters
  status: RunStatus;
  status_word: string;         // the word the CLI prints (src/cli/run-observe.ts statusWordOf)
  live: boolean;               // the run's lock file names a live process
  planner: ModelChoice;
  worker: ModelChoice;
  started_at: string;
  ended_at: string | null;
  elapsed_ms: number;          // ended_at or now, minus started_at
  branch: string | null;       // run branch, e.g. substrate/runs/<run_id>
  merged: boolean | null;      // null while the run is not finished
  usage: Usage;
  tasks: { total: number; passed: number; running: number; failed: number; skipped: number };
  pause_reason: string | null; // present when status is paused
}

type TaskState = string;       // the reducer's TaskState union (src/engine/reducer.ts), passed through verbatim

interface TaskRow {
  id: string;
  title: string;
  class: string;               // task class, e.g. "feature", "tests"
  state: TaskState;
  generation: number;
  attempt: number;
  session_ids: string[];       // worker sessions of this task, all generations and attempts
  failure_class: string | null;
  failure_message: string | null;
  files_changed: string[];
  cost_usd: number;
  elapsed_ms: number;
  verify: "passed" | "failed" | "timed_out" | "not_run" | null;
}

// Every transcript in the run, with the role that the UI uses to place it in the actor tree.
interface SessionRef {
  session_id: string;
  role: "planner" | "planner_chat" | "worker" | "repair";
  task_id: string | null;      // null for planner, planner_chat
  generation: number | null;
  attempt: number | null;
  backend: Backend;
  model: string;
  started_at: string;
  ended_at: string | null;
  ok: boolean | null;          // from session.result, null while live
  usage: Usage | null;
}

interface IntegrationState {
  verdict: "pending" | "verifying" | "passed" | "failed" | "could_not_run" | "skipped";
  verify: VerifyResult[];      // the final integration_verify commands
  repairs: { attempt: number; outcome: "passed" | "failed" | "unfixable" | "rejected"; session_id: string | null }[];
}

interface ArtifactRef {
  key: string;                 // opaque; the client fetches GET /api/runs/:ref/artifacts/:key
  label: string;               // "verify output, task t2 g1 a2", "patch, task t2 g1 a1"
  kind: "summary" | "verify_full" | "patch" | "spec" | "packet" | "report" | "progress_log" | "plan_file";
  bytes: number;
}

interface RunDetail extends RunSummary {
  request: string;             // the full request text
  pause_question: string | null;
  verification: "passed" | "failed" | "not_run" | null;   // from result.json
  verification_note: string | null;
  report_text: string | null;  // summary.txt, when present
  tasks: TaskRow[];
  sessions: SessionRef[];      // every transcript; planner_session_ids below is the subset for the Planner node
  planner_session_ids: string[];
  integration: IntegrationState;
  artifacts: ArtifactRef[];
  chat_available: boolean;     // false when the job is finished (section 7)
}

interface VerifyResult {       // the existing contract (src/contracts/index.ts VerifyResult), with the on-disk full output added
  cmd: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
  truncated: boolean;
  full_output: ArtifactRef | null;   // present once full verify output is on disk (section 6.4)
}

interface WorkerReport {       // existing contract (src/contracts/index.ts WorkerReport), shown as-is
  task_id: string;
  generation: number;
  attempt: number;
  session_id: string;
  backend: Backend;
  model: string;
  effort?: string;
  status: "passed" | "failed";
  failure_class?: string;
  files_changed: string[];
  usage: Usage;
  duration_ms: number;
  verify: VerifyResult[];
  denials: string[];
}

interface TranscriptHeader {   // first line of runs/<id>/transcripts/<session>.jsonl (section 6.3)
  type: "header";
  v: 1;
  session: string;
  role: "planner" | "planner_chat" | "worker" | "repair";
  task_id: string | null;
  generation: number | null;
  attempt: number | null;
  backend: Backend;
  model: string;
  started_at: string;
}

interface TranscriptLineOut {  // one line as served by the API; index 0 is the header
  index: number;
  ts: string;
  header: TranscriptHeader | null;   // set on index 0 only
  event: BackendEvent | null;        // set on every other index
}
```

`BackendEvent` is the existing union in `src/contracts/index.ts` (`session.started`, `assistant.text`, `tool.call`, `tool.result`, `permission.denied`, `usage`, `subagent`, `error`, `session.result`). It is not changed.

### 5.2 Endpoints

**GET /api/health** -> `Health`
```ts
interface Health { ok: true; version: string; pid: number; started_at: string; projects: number }
```

**GET /api/projects** -> `Project[]`
Sorted by `last_run_at` descending, then `name`. Source: the registry (section 6.1), plus any project found in the usage ledger that the registry does not list yet (backfill, below).

**GET /api/runs?project=&status=&limit=** -> `RunSummary[]`
- `project`: a project id or an absolute path. Omitted means all projects.
- `status`: `live`, `past`, or one `RunStatus`. `live` means `live: true`. `past` means not live. Omitted means all.
- `limit`: 1 to 200, default 50.
- Order: live runs first, then by `started_at` descending.

**GET /api/runs/:ref** -> `RunDetail`
404 when the project is not registered or the run directory is missing.

**GET /api/runs/:ref/tasks/:task** -> `TaskDetail`
```ts
interface TaskDetail {
  task: TaskRow;
  spec_markdown: string | null;      // tasks/<ID>.md from the plan
  attempts: AttemptDetail[];         // every generation and attempt, oldest first
  integration_verify_for_task: VerifyResult[];   // empty unless this is the only task of a single-task plan (see below)
}

interface AttemptDetail {
  generation: number;
  attempt: number;
  session_id: string | null;         // null when the attempt never started a session
  report: WorkerReport | null;       // packets/<task>-g<n>-attempt<k>.json
  verify: VerifyResult[];            // the report's verify list, or the failure packet's verify_output
  patch: ArtifactRef | null;         // failed attempts (packets/*.patch); merged tasks once on disk
  packet: ArtifactRef | null;        // the failure packet JSON, when present
}
```
`integration_verify_for_task` exists only so the one-task plan case (`integration.skipped`, reason `single_task`) can show the task's own verify with a label. The UI shows it under the task, not as a separate verdict.

**GET /api/runs/:ref/engine?after=&limit=** -> `EngineSlice`
```ts
interface EngineSlice {
  events: EngineEvent[];   // the events file's lines, parsed; events with seq > after
  next: number;            // the last seq returned, or after when none
  complete: boolean;       // true when the run is not live and seq next is the last seq
}
```
`after` defaults to 0. `limit` defaults to 500 and is capped at 1000. `EngineEvent` is `{v, seq, ts, run_id, type, data}` (`src/contracts/events.ts`).

**GET /api/runs/:ref/transcripts/:session?after=&limit=** -> `TranscriptSlice`
```ts
interface TranscriptSlice {
  session: string;
  lines: TranscriptLineOut[];  // index > after
  next: number;                // last index returned, or after when none
  complete: boolean;           // true after a session.result line, or when the run is not live and the file is closed
}
```
`after` defaults to -1, so index 0 (the header) is returned first. `limit` defaults to 500, capped at 1000. 404 when the session is not in the run's `sessions`.

**GET /api/runs/:ref/artifacts/:key** -> the artifact body
- `key` is an opaque value issued by `RunDetail.artifacts` or `AttemptDetail`. The server maps the key to a file inside the run directory. A client never supplies a path. Unknown key: 404.
- `Content-Type`: `text/plain; charset=utf-8` for logs, verify output, patches and specs; `application/json` for packets and reports; `text/markdown; charset=utf-8` for spec and plan files.

**GET /api/runs/:ref/stream** -> Server-Sent Events, for one job
Events (`event:` name, `data:` JSON):

| Event | `data` | Notes |
|---|---|---|
| `engine` | `EngineEvent` | `id:` is the event's `seq`. On reconnect with `Last-Event-ID: <seq>` the server sends events with seq greater than that. |
| `transcript` | `{ session: string; line: TranscriptLineOut }` | No `id:`. On reconnect the client fetches `transcripts/:session?after=<last index>`. |
| `chat` | `ChatMessage` | Sent each time a message's status changes (section 5.3). No `id:`. The client refetches `GET .../chat` on reconnect. |
| `state` | `StatePatch` | `{ ref: string; run: Partial<RunDetail>; tasks?: TaskRow[] }`. `run` carries the changed scalar fields; `tasks` carries only the changed rows. |

The server polls the run's files every 500 ms (`fs.watch` may be added later) and sends a `: ping` comment every 15 s. A `state` event is sent at most once per poll. A stream of a run that is not live sends its current `state` and `engine` events, then closes after 5 s of silence.

**GET /api/stream** -> Server-Sent Events, for the whole service
| Event | `data` |
|---|---|
| `run` | `RunSummary`: sent when a run appears, changes status or changes live state |
| `project` | `Project`: sent when a project is registered or its counts change |

The sidebar subscribes to this stream. The job view subscribes to the per-run stream. `Last-Event-ID` is not used here; a reconnect sends a fresh snapshot of every live run as `run` events.

**POST /api/runs/:ref/stop** -> `202 { ref: string; status: "stopping" }`
Requests the same stop that `substrate stop <id>` makes (the same function). `409 conflict` when the run is not live.

**POST /api/runs/:ref/resume** body `{ answers?: Record<string, string> }` -> `202 { ref: string; status: "resuming" }`
Starts `substrate resume <id>` detached, through the same function the CLI uses. `answers` answers `QUESTIONS.md` items when the run is paused with questions. `409 conflict` when the run is live, when it is `finished`, or when `answers` are sent to a run with no questions.

**GET /api/runs/:ref/chat** -> `ChatMessage[]`
The chat history with each message folded to its latest status (section 6.2), oldest first.

**POST /api/runs/:ref/chat** body `{ message: string }` -> `202 { message: ChatMessage }`
The returned message has `status: "queued"`. Replies arrive as `chat` events on the run stream. A message is refused with `409 conflict` only when the job is finished and the planner cannot answer at all (section 7). Chat messages are handled in order, one planner turn at a time.

**POST /api/runs** (optional, phase 2) body `StartRunRequest` -> `202 { ref: string }`
```ts
interface StartRunRequest {
  project: string;               // project id or absolute path; the directory must be a git repository or be empty
  request: string;
  planner: ModelChoice;          // models are explicit (DECISIONS R7.2): the UI must send them, never leaves them to settings
  worker: ModelChoice;
  mode?: "auto" | "plan" | "solo";
  merge?: boolean;               // default: the project setting (DECISIONS R10.1)
}
```
Starts `substrate run` detached through the existing `src/cli/detach.ts` path.

**GET /api/usage?project=&since=** -> `UsageReport`
```ts
interface UsageReport {
  total: Usage;
  by_project: { project_id: string; usage: Usage }[];
  by_model: { provider: Backend; model: string; usage: Usage }[];
}
```
`since` is an ISO date. Source: the global usage ledger (`$XDG_STATE_HOME/substrate/usage.jsonl`, DECISIONS A7).

**GET /** and **GET /assets/*** -> static files from `assets/web/`. The server resolves `assets/web` the same way `src/prompts/index.ts` resolves `assets/`. A path with `..` or a symlink out of the directory is refused (404).

### 5.3 Chat messages

```ts
interface ChatMessage {
  id: string;                    // "c<n>", n counts from 1 per run
  ts: string;
  role: "user" | "planner" | "system";
  text: string;
  status: "queued" | "answering" | "answered" | "failed" | "refused";
  reply_to: string | null;       // for a planner message: the user message id it answers
  session_id: string | null;     // the planner_chat transcript session, once started
  amendment: AmendmentSummary | null;   // on a planner message that carries an amendment
}

interface AmendmentSummary {
  chat_id: string;
  outcome: "pending" | "applied" | "rejected";
  applied_at: "live" | "resume" | null;
  added: string[];               // task ids
  changed: string[];             // task ids whose spec changed and that had not started
  dropped: string[];             // task ids of not-started tasks that the amendment removed
  kept_started: string[];        // task ids in the amendment whose work had started: ignored, reported
  reason: string | null;         // when rejected: the blocker lines from plan lint, or "job finished"
}
```

---

## 6. On-disk additions

These are the files the server relies on. The foundation package writes exactly these shapes. Everything is append-only except where stated.

### 6.1 Project registry

`$XDG_STATE_HOME/substrate/projects.json`, default `~/.local/state/substrate/projects.json`.

```ts
interface ProjectsFile {
  version: 1;
  projects: { path: string; name: string; first_seen: string; last_seen: string }[];
}
```
- `path`: absolute realpath. `name`: basename. `first_seen`, `last_seen`: ISO times.
- Written atomically at run creation: write `projects.json.tmp` in the same directory, then rename. Created with an empty list when missing.
- **Backfill (decided here)**: `ui serve` also reads the global usage ledger (DECISIONS A7 lines carry the project path) and adds projects it does not list, so projects with runs made before this change appear.
- Corrupt file: the server logs a warning and treats the list as empty; it does not rewrite the file until a run is created.

### 6.2 Chat history and inbox

`runs/<id>/chat.jsonl`: one `ChatMessage` per line (section 5.3). A status change appends the whole message again with the same `id`; the last line for an id wins. Only one writer per message at a time: the server writes `role: "user"` lines; the planner chat turn process writes `role: "planner"` lines.

`runs/<id>/inbox/<n>.json`: messages for the engine. `n` is the next integer, allocated by creating the file with the `wx` flag (retry with n+1 on EEXIST). Written to a temporary name and renamed into place, so the engine never reads half a file.

```ts
type InboxMessage =
  | { v: 1; n: number; ts: string; kind: "chat"; chat_id: string; text: string }
  | { v: 1; n: number; ts: string; kind: "amendment"; chat_id: string; dir: string };  // dir: "amendments/<chat_id>" inside the run directory
```
Inbox files are not deleted when consumed. The engine records consumption as a `run.message` event, which is the record of what was processed.

### 6.3 Transcripts

`runs/<id>/transcripts/<session>.jsonl`: one file per session (planner, planner chat turn, worker attempt, repair attempt).
- Line 0 is the `TranscriptHeader` (section 5.1).
- Each following line is `{ "ts": string, "event": BackendEvent }`. **Decided here**: the wrapper with `ts` is added so that the UI can show times and elapsed per event. The brief said "one BackendEvent per line"; if the owner wants the bare form, `ts` moves to the header and the times are approximated from the event order.
- The adapters write these lines as they stream; a session is closed by its `session.result` line.
- Session ids are the harness's session ids (`session.started.session_id`).

### 6.4 Full verify output and merged patches

- Full stdout and stderr of each verify command go to `packets/verify/<task>-g<n>-attempt<k>-<i>.out` (stdout) and `…-<i>.err` (stderr), with `i` the command index. `VerifyResult.full_output` points at the stdout artifact; the stderr artifact key is derived in the same way.
- A merged task's patch goes to `packets/merged/<task>-g<n>.patch`. A failed attempt keeps `packets/<task>-g<n>-attempt<k>.patch`.
- Integration verify output goes to `integration/verify-<k>-<i>.out` and `.err`.

### 6.5 Engine events added

Two events are added to `src/contracts/events.ts` and registered in `src/engine/reducer.ts` (they change no task state):

```ts
// run.message: the engine accepted an inbox message
interface RunMessageEvent {
  type: "run.message";
  data: { message_id: number; kind: "chat" | "amendment"; chat_id: string };
}

// run.amended: an amendment was validated and applied (or refused)
interface RunAmendedEvent {
  type: "run.amended";
  data: AmendmentSummary & { applied_at: "live" | "resume" };
}
```

---

## 7. Chat and amendment semantics

Decided (owner, 2026-10-22). Summary with the mechanics the work packages need:

1. **Where a message goes.** The server writes the user line to `chat.jsonl` and an inbox `chat` message. A planner chat turn starts as a detached child process (`substrate ui chat-turn <ref> <chat_id>`, hidden from help). It resumes the run's planner session id. When the run has none (for example, the plan was never accepted), it starts a new `planner_chat` session with a context pack.
2. **Context pack for a new planner chat session** (assets: `assets/prompts/planner/chat.md`, the prompt text; code only assembles it): the charter (capped at 4 KB, DECISIONS A8), the request, the current manifest, the task states, the recent failures (the last three failed attempts with `failure_class` and `failure_message`), the last 20 engine events in short form, and the last 10 chat messages.
3. **What the planner answers.** Text, always: the reply is a `planner` chat line with `status: "answered"`. It may also write an amendment.
4. **Amendment format.** The planner writes a full plan into `runs/<id>/amendments/<chat_id>/` using the normal plan files: `manifest.yaml`, `tasks/<ID>.md`, contract stubs at their repo-relative paths, and `decisions.md`. The engine diffs it against the current plan by task id:
   - a new id: **added**;
   - an id that exists, not started, with a different spec: **changed**;
   - an id that exists, not started, and absent from the amendment: **dropped**;
   - an id whose task is running, passed, or merged: **kept_started**. Its spec is not read and the amendment cannot change it.
5. **Validation.** The engine runs the normal plan lint and refuses the amendment only on blockers (DECISIONS R12.3). A refused amendment is recorded as `outcome: "rejected"` with the blocker lines in `reason`. No partial application.
6. **Applying it.**
   - A **live** run applies the amendment through the existing plan ingest path (`src/roles/planner.ts`, `ingestPlanDraft`) when the engine drains its inbox between actions. It emits `run.amended` with `applied_at: "live"`.
   - A **stopped** run applies it on resume, by re-ingesting the plan before scheduling. It emits `run.amended` with `applied_at: "resume"`.
7. **Running and passed tasks are never changed by chat.** The user can stop a task or the whole job explicitly. A task stop is not in the v1 API: stopping is the job's Stop button.
8. **A job that is finished.** **Decided here**: the planner can still answer (a `planner_chat` turn on the run's planner session) but cannot amend, because a finished run is not resumable (DECISIONS R10.4). An amendment from such a chat is `rejected` with reason `job finished`, and the UI says to start a follow-up job. `chat_available` is `true` for every job so that questions can be asked; sending is refused only when the planner session is missing and cannot be started (`unavailable`).
9. **Ordering.** One planner turn at a time per run. Further messages stay `queued` until the previous turn ends.
10. **Cost.** A chat turn is a paid planner call, shown in the run's usage with `role: "planner_chat"`. There is no confirmation step in the UI.
11. **The UI copy.** The chat box shows: "Changes apply to pending tasks only. Running tasks finish unless stopped." A rejected amendment shows its reason in the transcript.

---

## 8. The always-on service

### 8.1 Commands

| Command | What it does |
|---|---|
| `substrate ui serve` | Runs the server in the foreground, logging to stderr. This is what systemd runs. |
| `substrate ui start` | Starts `ui serve` detached, writes its pid, and prints the URL. Does nothing if it is already running. |
| `substrate ui stop` | Sends SIGTERM to the pid in the pid file, waits up to 5 s, then reports. Removes the pid file. |
| `substrate ui status` | Prints whether the service runs (pid alive and `GET /api/health` answers), the pid, the uptime, and the URL. |
| `substrate ui install-service` | Writes a systemd user unit (Linux only for now) and prints the enable command (section 8.4). |

Bare `substrate` still prints help. `substrate ui` with no subcommand prints the `ui` help.

### 8.2 Binding, port and config

- The bind address is set by the `host` key of `ui.json` or the `--host` flag on `ui serve` and `ui start` (owner override, 2026-10-22; the original rule was loopback only). The default is `localhost`, the loopback interface. When bound elsewhere, the `Host`-header guard is skipped, the `X-Substrate-UI` guard stays, and the UI has no authentication, so anyone who can reach the port can read transcripts and stop, resume or message jobs.
- **Port**: on the first `ui serve` (or `ui start`), if `ui.json` has no port, the server asks the operating system for a free port on the loopback interface, writes it into `ui.json`, and uses it from then on. If the stored port is busy, `serve` exits with an error that names the port and the config file; it does not pick another one silently.
- **`ui.json`**: in the user config directory, next to `settings.json`: `$SUBSTRATE_CONFIG_DIR` or `~/.config/substrate/ui.json`.
  ```ts
  interface UiConfig { version: 1; port: number; chosen_at: string }
  ```
  It is never committed. Nothing in the repository holds a port.
- `ui status` prints the URL from `ui.json`. No port appears in any committed file, spec or prompt (repo rule 8).

### 8.3 Pid and logs

- Pid file: `$XDG_STATE_HOME/substrate/ui.pid` (default `~/.local/state/substrate/ui.pid`), written by `serve` after the port is bound and removed on clean exit.
- Log: `$XDG_STATE_HOME/substrate/ui.log`, appended by `ui start`'s detached child. `serve` in the foreground logs to stderr only.

### 8.4 systemd user unit

`ui install-service` writes `~/.config/systemd/user/substrate-ui.service`:
```ini
[Unit]
Description=Substrate web UI
After=network-online.target

[Service]
ExecStart=<absolute path to node> <absolute path to dist/substrate.mjs> ui serve
Restart=on-failure

[Install]
WantedBy=default.target
```
The command writes the file and prints `systemctl --user daemon-reload` and `systemctl --user enable --now substrate-ui`. It does not run systemctl unless `--enable` is passed. **Decided here**: running as a user service after logout needs `loginctl enable-linger`; the command prints that line too and does not run it.

Linux only for now. On other platforms the command exits 2 with a message and `ui start` remains available.

---

## 9. Work breakdown

Each package has files and an acceptance check. Every package ends with `npm run check` passing, and every package that adds behaviour is proven by running the built CLI (`npm run bundle`, then `node dist/substrate.mjs ...`). Packages run in order.

**W1. Read model moved to a neutral module (no behaviour change).**
- Move `src/cli/run-observe.ts` to `src/observe/run-observe.ts`. Update its imports and the dynamic imports of `../run-observe.js` in `src/cli/commands/{resume,runs,stop,status,watch}.ts` and `src/cli/model-catalog.ts` if it imports it.
- Extend `scripts/check-boundaries.mjs`: `src/web` and `src/observe` must not import `src/cli`; `src/observe` must not import `src/web`.
- Acceptance: `npm run check` passes; `node dist/substrate.mjs runs` and `status <id>` print the same output as before the move.

**W2. Recording on disk (no UI yet).**
- `src/store/projects.ts`: atomic registry read and write; called from run creation. `src/store/transcript.ts`: transcript writer (header line, `{ts, event}` lines), called from the three backends' adapter loops (`src/backends/*`).
- Full verify output and merged patches (section 6.4), written from `src/verify` and `src/engine/actions/integrate.ts` and the merge path.
- `src/contracts/events.ts` and `src/engine/reducer.ts`: `run.message` and `run.amended` (section 6.5). Extend `scripts/check-events.mjs` if the event list is checked there.
- Acceptance: run one fake-harness job (`test/fixtures/fake-harness/bin` first on `PATH`; no live harness) and check the files exist: `projects.json`, `transcripts/*.jsonl` with headers, `packets/verify/*`.

**W3. Read API and client, read-only.**
- `src/observe/`: `projects.ts` (registry plus backfill), `runs.ts` (`RunSummary` list and `RunDetail`), `tasks.ts` (`TaskDetail`), `transcripts.ts` (incremental JSONL reader by line index), `engine.ts` (journal slice), `artifacts.ts` (key-to-file map), `usage.ts`.
- `src/web/`: `server.ts` (node:http router, static files), `routes.ts` (GET endpoints only), `sse.ts` (polling tailer, `Last-Event-ID`, ping), `guards.ts` (POST guards, used from W4).
- `assets/web/` (client, section 4.6): sidebar, job header, transcript, diff and verify blocks, Engine and Planner views. Read-only.
- `src/cli/commands/ui.ts`: `ui serve` only, in the foreground.
- Acceptance: `node dist/substrate.mjs ui serve` in one terminal; open the URL printed by `ui status`; a finished fake-harness job appears in PAST with its tasks, transcripts and diffs; a running job's tree updates live.

**W4. Chat and amendments.**
- `src/web/chat.ts` (chat file writes, inbox writes, POST handling); `src/cli/commands/ui.ts` gains the hidden `chat-turn` subcommand; `src/roles/planner-chat.ts` (context pack, planner resume or start, amendment directory handling).
- `assets/prompts/planner/chat.md` (prompt text: no prompt text in TypeScript).
- `src/engine/inbox.ts`: drain between actions in `src/engine/engine.ts`; diff by task id; validation with the plan lint (blockers only); apply through `src/roles/planner.ts` `ingestPlanDraft`; re-ingest on resume in `src/cli/commands/resume.ts`.
- Acceptance: with a fake planner, a chat message on a running job produces a `planner` reply line and a `run.amended` event with `applied_at: "live"`; a message that tries to change a passed task is reported in `kept_started`; a message on a stopped job applies on `resume` with `applied_at: "resume"`.

**W5. Control endpoints.**
- `POST /api/runs/:ref/stop` and `/resume` (call the same functions the `stop` and `resume` commands use), `POST /api/runs/:ref/chat` (W4), and the optional `POST /api/runs` (`src/web/start.ts`, using `src/cli/detach.ts`).
- Client: Stop and Resume buttons, chat box, palette commands.
- Acceptance: stop a live fake-harness job from the browser; resume it; the events show `run.stopped` and `run.resumed` with the same run id.

**W6. The service.**
- `src/web/service.ts`: port choice and `ui.json`, pid and log files, `ui start`, `ui stop`, `ui status`, `ui install-service` (Linux systemd unit, section 8.4).
- `src/cli/commands/ui.ts` gains the subcommands. Register `ui` in `src/cli/dispatcher.ts`. Add `ui` to `docs/reference/cli.md` (the docs check DOC-CMD expects every documented command to be registered).
- Acceptance: `ui start`, `ui status` (prints URL), reload the page, `ui stop`, `ui status` reports not running. `ui install-service` writes the unit to a temporary `SUBSTRATE_CONFIG_DIR`-style location when tested, and the printed commands are correct.

**W7. Polish and docs.**
- Phone layout check (under 720 px: drawer, no horizontal page scroll), dark and light themes, keyboard map (section 4.4), `docs/reference/config.md` for `ui.json`, `docs/reference/cli.md` for `ui`, README pointer, `START-HERE.md` section 4 link.
- Acceptance: `npm run check`, `npm run docs:check`, `npm test` (targeted tests while iterating, the full suite once).

---

## 10. Open points (decided here; owner may override)

1. Transcript lines carry a `ts` wrapper (section 6.3).
2. Amendments are full plans diffed by task id (section 7.4).
3. Chat on a finished job answers but cannot amend (section 7.8).
4. Planner chat turns run as a detached child process, so the server stays responsive (section 7.1).
5. The POST guards in section 5.0 (`X-Substrate-UI` header and, when bound to localhost, the loopback Host check) are cheap availability guards, not security. Owner may drop them under A6. The owner has already dropped the Host check for a non-localhost bind (2026-10-22).
6. `ui install-service` writes the unit and prints the enable command; `--enable` runs systemctl. Linger is printed, not run.
7. Projects found in the usage ledger are added to the registry on `ui serve` (backfill).
8. `POST /api/runs` is phase 2 (W5). The core UI is read-plus-chat.
