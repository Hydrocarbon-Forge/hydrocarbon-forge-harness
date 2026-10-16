# Substrate — Architecture & Implementation Plan (v2)

> Status: draft for user review · Date: 2026-10-16 · Supersedes `PLAN.md` (working title "Valence").
> Authored in the **Planner** role: this document contains invariants, contracts, verification criteria and work-package boundaries. It contains **no implementation bodies**. Where a fact is unverified it is marked `UNKNOWN`/`ASSUMPTION` and routed to a spike (§17).

---

## 0. How to read this document

| If you are… | Read |
|---|---|
| The user | §1, §4, §16 (cut lines), §18 (assumptions to confirm) |
| The build orchestrator | everything; `ORCHESTRATOR-PROMPT.md` cites sections by number |
| A spec-writer / worker | your task spec + the Appendix A declarations it references; do not read the rest |

Evidence base: `research/01-harness-conventions.md` (Claude Code / OpenCode / Antigravity CLI facts, real samples) and `research/02-principles-and-prior-art.md` (principles). Only their *Planner digests* were used to write this plan. Two research gaps are known: the Reddit thread could not be retrieved (its principles are not attributed anywhere here), and prior-art coverage beyond Claude Code subagents, Roo Orchestrator and Aider is thin.

---

## 1. Vision, scope, non-goals

**Substrate** is a deterministic orchestration engine, packaged as a CLI/TUI that looks and behaves like Claude Code, OpenCode and Antigravity CLI (`agy`), that pairs one expensive **Planner** with many cheap **Workers**. It does not implement a coding agent loop of its own: it drives the three existing harnesses as *backends* (one headless process per task, in an isolated git worktree), validates everything they produce with code, and merges only what passes.

**Substrate is its own product, not a wrapper around any one harness.** Claude Code, OpenCode and Antigravity are peer *runners*: any role (planner, test-writer, worker, reviewer) may run on any of them, and one run may mix them (for example planning on one harness and implementation on another). Substrate has no model-calling runtime of its own for planning or implementation; a local model is reached by adding it as an OpenCode provider.

Why it exists: naive agentic loops pay a "supervision tax" (an expensive model babysitting cheap work, or cheap models improvising architecture). Substrate moves supervision into code, keeps every context window minimal and isolated, and uses the top model only where ambiguity lives (planning, replanning, review).

**Non-goals (v1):** no model inference of its own; no cloud service or multi-user mode; no automatic `git push`; no custom coding-agent loop; no IDE integration; no guarantee of cost savings (it is *measured*, §13).

---

## 2. Invariants

Each invariant names its enforcement mechanism. An invariant enforced only by prompting is not an invariant.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | **Code owns control flow.** State transitions, retry counters, caps, locks, git operations and verdicts are never decided by an LLM. | Pure reducer + effect runner (§5); event store |
| I2 | **Workers never grade themselves.** The engine runs every acceptance command and owns the pass/fail verdict. | Verify runner (§9); engine re-runs after every worker session |
| I3 | **Contracts are code.** The Planner emits type/stub files, task specs and acceptance commands, never implementations. Stubs must compile before any worker spawns. | Plan linter L013–L020 (App. C); contract typecheck |
| I4 | **Atomic, owned, budgeted tasks.** Every task declares what it may read, write, create, and must not touch, plus a budget. | Spec schema; scope check; budget governor |
| I5 | **Models are explicit.** Every worker's backend/model/effort comes from the routing table; nothing inherits a model silently. | Routing table + adapter always passes `--model` |
| I6 | **Returns are structured and capped.** The engine consumes JSON reports/packets, never transcripts. | `WorkerReport`, `FailurePacket` with byte caps |
| I7 | **Hard budgets everywhere.** Per task, per run, per replan ladder. The engine enforces by killing process groups, not by asking nicely. | Budget governor (§10) |
| I8 | **Simplest path first.** A trivial request runs as a single worker (`solo`), with no planner, no manifest. | Router (§6.3) |
| I9 | **Parallel only when disjoint.** Concurrency requires dependency-ready tasks with non-overlapping write/create sets; otherwise the engine serializes. | Scheduler + linter L008 |
| I10 | **Familiar surface.** Flags, files, formats and keybindings follow the three harnesses wherever they agree (§4). | Copy table (§4.1) |
| I11 | **No trust in exit codes.** Success is read from structured results; denials and silent failures are detected per backend. | Adapter obligations (§11.1) |
| I12 | **No credential handling.** Substrate only invokes the official CLIs the user is already logged into and never reads, copies or logs their tokens. | Env allowlist; redaction; code review gate (P6.2) |

---

## 3. Architecture

```text
┌─ SURFACE ───────────────────────────────────────────────────────────────┐
│ CLI (`substrate`, `-p`, `run`, `plan`, `resume`…)  ·  TUI  ·  hooks      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ RunOptions / EngineEvent stream
┌─ ENGINE (deterministic, no LLM) ────────────────────────────────────────┐
│ Run state machine (pure reducer) · Scheduler (DAG layers, concurrency)  │
│ Event store (JSONL) · Budget governor · Escalation ladder               │
│ Workspace (git worktrees, scope check, commits, merge-tree, integration)│
│ Verify runner (sandboxed acceptance commands) · Plan linter · Ledger    │
└───────┬───────────────────────────┬────────────────────────────┬────────┘
        │ role: governor (intake)   │ role: planner / reviewer   │ role: worker / test-writer
        ▼                           ▼                            ▼
  OpenAI-compatible          HarnessAdapter.spawn()        HarnessAdapter.spawn()
  local model (llama.cpp)    (frontier model)              (cheap/mid model, 1 process per task)
                                    │                            │
                      ┌─────────────┴────────────────────────────┴───────────┐
                      │ BACKENDS: claude · opencode · agy  (+ fake for tests) │
                      └───────────────────────────────────────────────────────┘
```

**Run modes** (`--mode auto|solo|plan`; `auto` lets the router decide):
- `solo` — one worker, no planner, no manifest; engine still scope-checks, verifies (if the user supplies a verify command or the repo has a detectable one) and enforces budgets.
- `plan` — full pipeline: route → plan → lint → approve → setup → execute batches → merge → integrate.

**Dispatcher mode** (an LLM fanning out workers through a harness's native subagents) is **not** in v1. The research found native headless subagents are only confirmed for Claude Code, so the portable design is engine-side fan-out. Dispatcher mode is a Phase 7 experiment (§16).

**Glossary**
- *Session* — user-facing conversation thread (like a Claude Code session); may contain several runs.
- *Run* — one planned-and-executed unit of work; has a `run_id`, a run branch, a run directory, an event log.
- *Backend session* — one harness process/conversation (planner, worker…); identified by the backend's own session id.
- *Generation* — version of a task spec; replans create `g+1`.
- *Attempt* — a verification attempt within a generation (1 = initial, 2 = after the single heal).
- *Batch* — a dependency layer of tasks that may run concurrently.

---

## 4. Product surface (deliberately mirrors the three harnesses)

### 4.1 Copy table (sourced from `research/01`; "—" = no equivalent)

| Feature | Claude Code | OpenCode v2 | Antigravity | **Substrate** |
|---|---|---|---|---|
| Headless | `-p` | `run` | `-p` | `-p/--print` flag **and** `run` subcommand |
| Output | `--output-format text\|json\|stream-json` | `--format default\|json` | same as Claude | `--output-format text\|json\|stream-json` |
| Model | `--model` | `-m provider/model#variant` | `--model` | `--model` (primary model: planner in `plan`, worker in `solo`); `--worker-model` overrides routing |
| Effort | `--effort` | — | `--effort` | `--effort` |
| Session | `--session-id`, `--resume`, `-c`, `--fork-session` | `-s`, `-c`, `--fork` | `--conversation`, `-c` | `--session-id`, `--resume`, `-c/--continue`, `--fork-session` |
| Agents | `.claude/agents/*.md` | `.opencode/agents/*.md` | UNKNOWN | `.substrate/agents/*.md` |
| Commands | `.claude/commands/*.md` | UNKNOWN | UNKNOWN | `.substrate/commands/*.md` |
| Skills | `.claude/skills/<n>/SKILL.md` | UNKNOWN | `~/.agents/skills/` | `.substrate/skills/<n>/SKILL.md` |
| Config | `settings.json` user<project<local | `opencode.json(c)` | `settings.json` | `settings.json` (JSONC-tolerant): `~/.config/substrate/` < `.substrate/` < `.substrate/settings.local.json` < `--settings` < flags |
| Instruction file | `CLAUDE.md` | `AGENTS.md` (likely) | UNKNOWN | `SUBSTRATE.md` → fallback `CLAUDE.md` → `AGENTS.md` |
| Permission mode | `--permission-mode` | `--auto` | `--mode` | `--permission-mode` (gate semantics, §4.4) |
| Permission rules | `Tool(spec)`, deny>ask>allow | last-match | `permissions.allow` | Claude syntax, deny>ask>allow (applies to worker tools) |
| Allow/deny flags | `--allowedTools/--disallowedTools` | — | — | `--allowed-tools/--disallowed-tools` |
| Worktree | `-w/--worktree` | — | — | `-w/--worktree` (isolate the whole run on a named branch) |
| Budget | `--max-budget-usd` | — | — | `--max-budget-usd` (engine-enforced on **all** backends) |
| Timeout | — | — | `--print-timeout` | `--timeout` |
| Sandbox | settings | — | `--sandbox` | `--sandbox` |
| Exit codes | 0/1, 143 | 0 | 0/1/2 | see §4.6 |

### 4.2 Commands

| Command | Purpose |
|---|---|
| `substrate [prompt]` | Interactive TUI; optional initial prompt (like `claude "q"`). The prompt goes to the governor (front door) unless `--mode` or `--no-governor` is given |
| `substrate -p "<prompt>"` / `substrate run "<prompt>"` | Headless run; prompt may come from stdin; same governor/flag rule; `--no-governor` forces the deterministic path |
| `substrate plan "<prompt>"` | Plan + lint + estimate, then stop (≡ `--permission-mode plan`) |
| `substrate resume [run_id\|session_id]` | Resume a paused or crashed run (also `--resume`) |
| `substrate status [run]` · `tasks [run]` · `cost [run\|--since]` · `report <run>` | Inspection |
| `substrate verify <task>` | Re-run a task's acceptance commands in its worktree (manual) |
| `substrate merge <run>` · `undo [run]` · `discard <run>` | Apply run branch to the current branch; revert last merged batch; drop a run |
| `substrate models` · `agents` · `backends` · `sessions` | Routing table / definitions / adapter capabilities+versions / sessions |
| `substrate config get\|set\|list` · `doctor` · `init` | Configuration and environment health |

### 4.3 Definition formats (compatible-by-design with Claude Code's)

- **Agents** — Markdown + YAML frontmatter, body = system prompt. Fields: `name`, `description`, `role` (`planner|worker|test-writer|reviewer|governor`), `backend?`, `model?`, `effort?`, `tools?`, `disallowedTools?`, `permissionMode?`, `maxTurns?`, `budget?`. Precedence: project `.substrate/agents/` > user `~/.config/substrate/agents/` > built-in `assets/agents/`. `substrate agents import --from claude|opencode` converts foreign definitions.
- **Commands** — Markdown, frontmatter `description`, `argument-hint`, `model?`; body is a prompt template with `$ARGUMENTS`; invoked as `/name` in the TUI or `substrate run "/name args"`.
- **Skills** — `SKILL.md` with `name` + `description` frontmatter. The Planner receives only names/descriptions (progressive disclosure) and may read a skill's file on demand.
- Foreign directories (`.claude/`, `.opencode/`) are **never** read implicitly; import is explicit.

### 4.4 Permissions: two layers

1. **Worker tool permissions** — allow/deny rules in Claude syntax (`Bash(git *)`, `Edit(src/**)`, `mcp__s__t`; deny > ask > allow) translated by each adapter into that backend's mechanism. Workers run unattended, so `ask` is treated as `deny` and a denial becomes a `permission.denied` event.
2. **Run gates** — `--permission-mode` governs when *Substrate* pauses for the human:

| Mode | Plan approval | Cost over threshold | Merge to user branch |
|---|---|---|---|
| `default` | ask | ask | ask |
| `plan` | produce plan, stop | — | — |
| `acceptEdits` | auto (if under cost threshold) | ask | ask |
| `dontAsk` (headless default) | auto (if under threshold) else exit 3 | exit 3 | never; leaves the run branch |
| `bypassPermissions` | auto | auto | auto (sandbox and budgets still apply) |

### 4.5 Sessions
A **session** record (`.substrate/sessions/<session_id>.json`) lists its runs, prompts and mode. `--resume <session_id>` reopens the thread; `substrate resume <run_id>` resumes the *run* (engine replays `events.jsonl`). `-c/--continue` = most recent session in this directory. Backend sessions are internal.

### 4.6 Output and exit codes
- `text` — human summary. `json` — one final object. `stream-json` — NDJSON, key `type`: `system.init`, `run.state`, `plan.ready`, `task.started`, `task.verified`, `task.failed`, `batch.merged`, `usage`, `result`. The final `result` event mirrors Claude's shape: `type:"result"`, `subtype` (`success|error_failed|error_budget|error_needs_human`), `is_error`, `session_id`, `run_id`, `num_tasks`, `total_cost_usd`, `usage{by_role}`, `duration_ms`.
- Exit codes: `0` success · `1` run failed · `2` usage/config error · `3` needs human (approval in `dontAsk`, permission denial, escalation L3) · `4` budget exhausted · `130` SIGINT · `143` SIGTERM.

### 4.7 Interactive UX (v0.3)
Slash commands: `/help /mode /plan /run /status /tasks /cost /models /agents /permissions /config /resume /sessions /undo /doctor /init /clear /exit /hooks`. Keybindings follow Claude Code conventions: `Enter` submit · `Esc` graceful interrupt (engine pauses the run) · `Shift+Tab` cycle permission mode · `Ctrl+C` ×2 exit · `Ctrl+T` toggle task board · `Ctrl+O` verbose feed · `@` file mention · `!` shell passthrough. *These keybindings are from memory, not research; spike S5 (P0.6) verifies them before P5.3.* Status line: model/tier · run state · tasks done/total · cost vs cap. Approval dialogs for plan, cost and merge gates; session picker for `/resume`.

### 4.8 Hooks (v0.3)
Events: `PreRun`, `PostPlan` (may block), `PreTask`, `PostTask`, `PreMerge` (may block), `PostMerge`, `RunFinished`, `Notification`. Command hooks receive JSON on stdin; exit `0` = continue, `2` = block (stderr fed back). Same contract shape as Claude Code hooks.

---

## 5. Run lifecycle and state machine

**Run states:** `CREATED → ROUTING → PLANNING → LINTING → AWAITING_APPROVAL → SETUP → EXECUTING → INTEGRATING → (REVIEWING) → FINISHED`.
Side states: `PAUSED(reason ∈ PauseReason)`, `FAILED`, `CANCELLED`. `PAUSED` is always resumable.

**Task states:** `PENDING → READY → RUNNING → SCOPE_CHECK → VERIFYING → PASSED → MERGING → MERGED`; with `VERIFYING → HEALING → VERIFYING` (once); `FAILED → REPLANNING → READY(g+1)`; terminal/blocked: `BLOCKED` (upstream failed or needs human), `ABANDONED`.

**Mechanics (normative):**
1. State is *derived*: `reduce(state, event) → state` is pure; `nextActions(state, settings) → Action[]` is pure. A separate effect runner executes actions (spawn, verify, merge, …) and appends the resulting events. No other code mutates state.
2. The event log (`.substrate/runs/<run_id>/events.jsonl`, append-only, schema-validated, torn last line tolerated) is the source of truth. Resume = replay.
3. A run lock (`.substrate/state/<run_id>.lock`, pid + heartbeat, stale detection) prevents concurrent engines on one run.
4. **Escalation ladder** (all counters live in state, never in a worker):

| Level | Trigger | Action | Cap |
|---|---|---|---|
| L0 | first verify failure in a generation | engine **resumes the same backend session** once with capped failure output | 1 per generation |
| L1 | second verify failure, scope/protected violation, budget/timeout, merge conflict | `FailurePacket` → Planner rewrites the task spec; next generation runs in a fresh worktree on the **next tier up** in `routing.escalation` | 2 replans per task (max generation 3) |
| L2 | L1 exhausted, or Planner declares a contract defect | Planner amends contracts/manifest; dependents invalidated and re-linted | 2 per run |
| L3 | L2 exhausted, `permission_denied`, `needs_human` | run `PAUSED`, exit code 3 | — |

`permission_denied` and `rate_limited` never replan: the first is a configuration problem (needs a human or an allowlist change), the second backs off and reduces concurrency.

---

## 6. Roles, routing, governor

### 6.1 Roles
| Role | Default tier | Reads | Writes | Notes |
|---|---|---|---|---|
| Governor (front door) | local model, called **directly** by Substrate over an OpenAI-compatible API | your request, repo summary, run status | schema-constrained routing decisions and calls to a fixed typed tool set; clarifying questions; advisory lint | cannot plan, implement, edit the repo, or change caps/verdicts (§6.3) |
| Planner | top tier (config) | repo map, instruction files, skills list, request | manifest, task specs, contract stubs (into the run dir, never the repo) | forbidden from implementation bodies |
| Test-writer | mid tier | spec, contracts | test files only | runs before implementers that list those tests as `protected` |
| Worker | by class (§6.2) | its spec + `read` set | only `write`/`create` set | no git commit, no subagents, no web unless class `search` |
| Reviewer | top/mid (off by default) | final diff + contracts | review report | optional run phase `REVIEWING` |

### 6.2 Routing
The Planner assigns each task a **class** from the configured set; the engine maps class → `{backend, model, effort, budget}`. The Planner cannot name a model. Default class set and mapping are in Appendix B (config values, not code). Generation ≥ 2 moves up `routing.escalation` (default `haiku → sonnet → opus`). Local-model workers (OpenCode + llama.cpp) are an **opt-in routing entry**, justified only by the benchmark (§13), and are capped by `backends.opencode.max_concurrency` (the local server has 2 slots).

### 6.3 Governor (the front door) and router

The governor is how a project **starts**: what you type in the prompt box, or pass to `substrate -p`, goes to the local model first, unless explicit flags (`--mode`, `--no-governor`) select the deterministic path. It may (a) ask up to `max_clarifying_turns` short clarifying questions, (b) choose mode, task class and planner route (schema-constrained output), (c) start and control runs through a **fixed typed tool set** (`start_run`, `plan_only`, `resume_run`, `run_status`, `show_cost`, `cancel_run`, `ask_user`; Appendix A) whose calls the engine validates and executes, and (d) narrate status and give advisory semantic lint. It **cannot plan, implement, edit the repo, or change caps, verdicts or state**: planning and implementation belong to the harnesses and everything else to the engine (I1). This is the one place Substrate itself calls a model, directly, with no harness in between. Conversation state lives in the session record.
Order of decision (first match wins): (1) explicit flags; (2) deterministic rules (named single file + mechanical verb → `solo`/`mechanical`); (3) governor LLM if enabled and `/health` passes within 10 s; (4) default `plan`. Governor calls use `response_format: json_schema` and **thinking disabled** (`chat_template_kwargs.enable_thinking=false`); thinking is allowed only for advisory semantic lint (App. C, S-codes). *Measured on 2026-10-16:* the llama.cpp server (Qwen3.8-27B Q4_K_M, 128k ctx) supports schema-constrained output and native tool calling; with thinking on, a small `max_tokens` is consumed by hidden reasoning and content comes back empty; on one toy request it routed a trivial rename to `medium`/`sonnet` (n=1, not a conclusion). Every routing decision and its eventual outcome is written to the ledger so the rules can be calibrated from data. If the governor is unreachable the engine falls through to rule 4; it never blocks.

---

## 7. Contracts (summary)

Full declarations: **Appendix A** (authoritative; workers implement them as zod schemas with inferred types). Artifact layout:

```text
.substrate/                       (settings.json, agents/, commands/, skills/ are shareable; the rest is gitignored)
  settings.json  settings.local.json  agents/  commands/  skills/
  sessions/<session_id>.json
  state/<run_id>.lock
  runs/<run_id>/
    manifest.yaml                 Manifest (planner output, linted)
    tasks/<task_id>.md            TaskSpec: YAML frontmatter + required sections
    contracts/…                   planner-authored stub files (mirror of repo paths)
    events.jsonl                  engine events (App. D)
    raw/<backend_session>.ndjson  raw backend stream, for debugging only
    packets/<task_id>.g<n>.json   FailurePacket
    reports/<task_id>.g<n>.a<m>.json  WorkerReport
    decisions.md                  planner decision log (rationale per task; fed to replans)
  worktrees/<run_id>/<task_id>/   one git worktree per task generation
```
Task specs are **materialized** into the worktree at `.substrate-task/TASK.md` (excluded through `.git/info/exclude`) because untracked files do not appear in new worktrees `[verified locally 2026-10-16]`. The worker prompt is only: *"Execute the task spec at `<abs path>`. Work only in the current directory. Do not run git commit/push/checkout/reset. Reply with one line: `DONE` or `BLOCKED: <reason>`."*

---

## 8. Workspace, git and merge semantics

- **Branches:** run branch `substrate/runs/<run_id>` from `base_ref`; task branch `substrate/tasks/<run_id>/<task_id>-g<n>`; worktrees under `.substrate/worktrees/` (added to `.git/info/exclude`). Worktrees share one object database and have separate index locks `[verified]`.
- **Contract commit:** the engine applies the Planner's stub files to the run branch and commits them before the first worker spawns, after the contract typecheck passes.
- **Setup:** `manifest.setup` commands (dependency install, codegen) run by the engine with network access **inside each task's worktree** before its worker starts: untracked files such as `node_modules` do not appear in new worktrees `[verified locally 2026-10-16]`, and nothing may be shared between concurrent workers (a warm package cache keeps this fast). Workers run with network denied by default (§10).
- **Workers never commit.** After a session ends the engine (a) computes changed/untracked paths against the `write`/`create` globs; (b) reverts out-of-scope changes and logs `scope_violation` (policy `git.on_scope_violation: revert|fail`, default `revert`, so verification still decides); (c) checks `protected` files are byte-identical (hash before/after; otherwise `protected_modified`, always a failure); (d) verifies; (e) commits explicitly with a pathspec of the allowed set.
- **Merging (per batch):** for each passed task in deterministic order (topological, then task id): preflight with `git merge-tree --write-tree --name-only <run-branch> <task-branch>` (exit 1 ⇒ conflict, lists files; no working tree touched `[verified]`), then merge into an *integration worktree*. A conflict marks the task `FAILED(merge_conflict)` → L1. After the batch, run `manifest.integration_verify`; on failure the engine **bisects deterministically** by re-merging the batch's tasks one at a time to isolate the culprit → `FailurePacket(integration_failed)`.
- **Checkpoints:** the run branch sha after each batch is recorded; `substrate undo` resets to the previous checkpoint.
- **Delivery:** the run branch is never merged into the user's branch without a gate (§4.4); `substrate merge <run>` does it.

---

## 9. Verification, scope and failure handling

- Acceptance commands (`verify[]` in the spec) run **by the engine** in the worktree through the verify runner (sandboxed, timeout per command, process-group kill, stdout/stderr tail caps, scrubbed env). A task passes only if *all* exit 0.
- **Heal (L0):** after the first failed verification the engine resumes the worker's backend session with a prompt containing the failing commands and the capped output tails (≤ 8 KB) and the instruction *"Fix only what these checks indicate. Do not change scope or tests."* Resume is supported by all three backends (`--resume`, `-s`, `--conversation`). The worker never counts attempts and cannot request more.
- **Failure packet** (`FailurePacket`) is assembled **by code**: attempt history, spec path, capped patch + stat, verify output tails, scope violations, worker final message (capped, flagged untrusted), related contract paths, dependents. The Planner never receives a transcript.
- **Replan input** = spec + packet + the contracts the task depends on + repo map + `decisions.md` + dependents' specs. Output = revised spec (L1) or contract/manifest amendment (L2), re-linted before use. Replans start fresh planner sessions; continuity comes from `decisions.md`.
- **Test authorship:** tests that gate an implementation task are written by an earlier `tests`-class task and listed in the implementer's `protected`. Linter L023 (optional `--red-check`) confirms those tests *fail* at the base.

---

## 10. Budgets, safety, sandbox

- **Budgets** (all from settings; planner may request lower, never higher): per run (`max_usd`, `max_tokens`, `max_wall_min`), per task (`max_usd`, `max_tokens`, `timeout_min`, `max_turns`), replan caps (§5). Usage comes from the adapter (`reported`) or is computed from token counts × the pricing table (`computed`, required for `agy`, which reports tokens only). The governor checks on every `usage` event and kills the process group at 100 %, warns at 80 %. Native flags (`--max-budget-usd` on Claude) are belt-and-braces, never the mechanism.
- **Pre-flight estimate:** after linting, the engine estimates cost from class medians in the ledger (settings defaults on first run) plus a retry factor; above `budgets.approval_threshold_usd` it requires approval regardless of mode except `bypassPermissions`.
- **Rate limits:** `error.kind=rate_limit` → exponential backoff, concurrency halved (floor 1), then `PAUSED(rate_limited)`. Default worker concurrency is 3 (2 for the local server). Subscription limits under parallel workers are UNKNOWN (U13).
- **Sandbox:** Linux `bubblewrap` (present on this machine) with read-only root, writable worktree only, network denied (`[verified 2026-10-16]` that `claude -p` runs inside `bwrap --ro-bind / /` with write access limited to the repo, `~/.claude`, `~/.claude.json` and `/tmp`; the network stays on there because the model API needs it); `--sandbox`/settings toggle. Env is allowlisted; secrets patterns are redacted from logs and packets. Worker default denies: `Agent`/subagent tools, `git commit|push|checkout|reset|rebase|clean`, web tools (except class `search`).
- **Prompt-injection stance:** repo content and worker messages are untrusted data; packets mark them so, and no engine decision parses free text from a worker.

---

## 11. Backends

### 11.1 Adapter obligations (all backends)
1. Pass `--model` (and effort where supported) explicitly (I5). 2. Never treat exit code alone as success; read the structured result (I11). 3. Persist the raw stream to `raw/`. 4. Emit `permission.denied` events — Claude: `permission_denials` in the result; agy: stderr scan (soft-deny, exit 0); OpenCode: UNKNOWN (S2). 5. Compute cost when not reported. 6. Support resume. 7. `cwd` = the worktree. 8. Scrubbed env. 9. Verify the installed CLI version against the pinned version in `validateEnvironment()`; `doctor` reports drift. 10. Respect per-backend concurrency caps. 11. Surface rate-limit/auth/crash as typed `error` events.

### 11.2 Per-backend facts (from `research/01`; pins: claude 2.1.301, opencode 2.0.21, agy 1.4.0)

| | Claude Code | OpenCode | Antigravity (`agy`) |
|---|---|---|---|
| Invocation (informative) | `claude -p … --output-format stream-json --verbose --model --effort --session-id --permission-mode dontAsk --permission-prompts none --allowedTools --disallowedTools Agent,… --max-budget-usd` | `opencode run --standalone --format json -m provider/model#variant --agent <a> [-s id]` | `agy -p … --output-format stream-json --model --effort --mode accept-edits --sandbox --print-timeout [--conversation id]` |
| Event key / session id | `type` / `session_id` | `type` / `sessionID` (every event) | `event` / `conversation_id` |
| Usage | `total_cost_usd` + `usage{…}` in `result` | `step_finish.part.tokens` + `.cost` | tokens only |
| Effort | `--effort` | none known (variant? U2) | `--effort` (docs/help disagree on values; U-pin) |
| Budget flag | `--max-budget-usd` | none | none |
| Native headless subagents | yes (20 concurrent, depth 3) — **not used**, workers get `Agent` denied | UNKNOWN | UNKNOWN |
| Known traps | `--bare` skips CLAUDE.md/hooks **but needs an API key**, so it breaks subscription auth ⇒ minimal worker context must come from an agent definition (`omitClaudeMd`), spike S1 | v2 dropped agent fields `permission/tools/prompt/temperature/maxSteps`; tool restriction must go through config (S2); background service interference ⇒ always `--standalone` | soft-deny in `-p` returns exit 0; no cost field; doc conflicts ⇒ pin and test against 1.4.0 |

Local model as a backend: OpenCode custom provider → `http://192.168.1.72:8080/v1` (llama.cpp, tool calling works). This address is user-local and belongs in `settings.local.json`.

---

## 12. Plan linter

Deterministic checks (App. C, `L001–L027`) run in code over `manifest.yaml`, the specs, the stubs and the repo; each yields `Diagnostic{code,severity,task?,message}`. Severity `error` blocks execution; the planner gets the diagnostics and **one** engine-driven resume (up to `planner_format_retries`, default 2) to fix them. Semantic checks (`S001–S004`: ambiguity, missing edge cases, spec/contract mismatch, task too large) use the governor with thinking on and are **advisory only**.

---

## 13. Observability and evaluation

- **Ledger:** every `UsageRecord` is stored with `{run, task, role, backend, model, class, generation, attempt}`. `substrate cost` and `report` show: cost by role/tier/class, first-pass verify rate, heal rate, replans per task, escalations, scope violations, denials, wall-clock, human interventions.
- **Benchmark harness (P6.3):** 6–10 tasks drawn from the user's own repos (user nominates). Arms: **A** one top-tier session (`--mode solo --model <top>`), **B** one cheap-tier session, **C** Substrate `plan` with default routing, **D** Substrate with local-model workers for `mechanical|boilerplate`. Same budget cap per arm, three repetitions where affordable.
- **Hypotheses (to test, not assumptions):** H1 — arm C matches arm A's pass rate on ≥70 % of tasks at lower cost; H2 — Substrate's first-pass verify rate beats arm B; H3 — arm D's pass rate on mechanical/boilerplate is within 10 points of arm C at near-zero marginal cost. Anthropic's +90 % multi-agent figure is a research-eval result and is *not* evidence for coding.

---

## 14. Testing strategy

1. **Unit/property tests** for pure modules (reducer, scheduler, DAG layering, linter, cap helpers, permission-rule parser) — written first by a test-writer (§16 "TF").
2. **Golden tests** for normalizers using *real captured* backend output in `test/fixtures/backends/<name>/` (captured in the spikes).
3. **Fake harness** (`test/fixtures/fake-harness/`): a deterministic binary that emulates each backend's dialect and scenario flags (success, edit files, verify-fail-then-fix, hang, crash, soft-deny, budget overshoot, rate limit, resume). No integration test calls a real model.
4. **Adapter conformance suite** (P3.1; every adapter's tests import it): the same battery runs against `fake` always and against each real backend only with `SUBSTRATE_LIVE=1` and a cost cap.
5. **Scenario suite** (P4.3, written first; scenario 11 lives in P6.1 instead), each against throwaway git repos: (1) all-pass batch; (2) fail → heal → pass; (3) double fail → packet → L1 replan on higher tier → pass; (4) scope violation reverted; (5) protected file modified; (6) permission denial → pause (exit 3); (7) budget kill; (8) timeout kills the whole process group; (9) merge conflict → L1; (10) integration failure → bisect culprit; (11) crash and resume at *every* event boundary (P6.1); (12) rate-limit backoff; (13) planner format retry then success/fail; (14) L2 amendment invalidates dependents; (15) governor down → deterministic fallback; (16) `solo` mode.
6. **Live smoke** (P6.1): one trivial task per available backend, cheapest model, `max_usd 0.10`.

---

## 15. Repository layout and stack

Repo root = this directory (needs `git init`; it is not a repository yet).

```text
package.json  tsconfig.json  vitest.config.ts  .gitignore
SUBSTRATE-PLAN.md  ORCHESTRATOR-PROMPT.md  PLAN.md(historical)  research/  docs/{spikes,reference}/
build/            bootstrap-only: specs/ state/ tools/ packets/ reports/ (see ORCHESTRATOR-PROMPT.md)
contracts/        generated JSON Schemas
src/
  contracts/      zod schemas + inferred types (App. A)
  engine/         reducer, scheduler, budget governor, escalation ladder, run orchestrator
  store/          event store, projections, run lock
  git/            worktrees, scope check, commit, merge, integration, diff
  spec/           parser, linter, stub materializer, ecosystem detect, repo map
  verify/         command runner, sandbox
  backends/       types, process supervisor, ndjson, normalize/*, adapters/*, pricing, conformance/
  roles/          governor, planner, worker, reviewer runners + prompt builders
  config/         loader/merge, permission rules, definitions loader
  ledger/         usage ledger, estimates, reports
  cli/  tui/  hooks/  util/
assets/agents/*.md  assets/templates/
test/{unit,integration,fixtures/{backends,fake-harness,repos}}
bench/
```
**Import boundaries** (checked by `scripts/check-boundaries.mjs`, P0.1): `contracts` and `util` import nothing internal except each other; `backends` imports only `contracts`, `util`; `engine` may import everything except `cli|tui|hooks`; nothing imports `cli|tui`.

**Stack (ASSUMPTIONS — the infra research was dropped to save cost; each pick is revisited by the work package that first needs it):** TypeScript strict, ESM, Node ≥ 22 (dev machine: 26); `zod` (schemas + inference + JSON Schema export); `yaml`; `picomatch`; `node:util` `parseArgs`; `node:child_process` with detached process groups; `vitest`; Ink + React for the TUI (decision rechecked in P5.3 against OpenTUI); `esbuild` for bundling. **No database**: the JSONL event log plus in-memory projection is enough and diffable. Any added dependency needs a decision-log entry.

---

## 16. Implementation roadmap — work packages

**Reading the table.** *Tier*: H = Haiku 5.5, S = Sonnet 5.5, O = Opus 5.5 · *Eff*: lo/med/hi · *TF* (tests-first): `y` = a separate test-writer subagent writes the tests first; they must fail at base and become `protected` for the implementer · *Sz*: S/M/L (sets the worker's tool-call cap) · *Rel*: release cut line. Spike rows (P0.2–P0.6) are researcher tasks with hard tool-call caps and produce `docs/spikes/*.md` plus fixtures. `Verify` commands are what the orchestrator runs itself; `npm test -- <path>` filters vitest by path. Every row also requires `npm run typecheck` and `npm run check:boundaries` to stay green.

**Sizing rule:** a work package is a subsystem slice (typically 4–12 files plus their tests, a few hundred to ~1,500 lines), never one file. One spec, one test-writer and one worker handle a whole package; fragments are merged rather than split. *Sz* maps to turn caps S 40 · M 100 · L 200.

**Cut lines:** **v0.1** = the full engine, **all three adapters** (Claude Code, OpenCode, Antigravity), the governor front door, headless `substrate -p`, the fake-harness suites, live smoke on every installed harness, and the security review (unattended multi-harness workers are the riskiest part, so it ships before first real use). **v0.2** = the interactive surface: TUI, hooks, commands/skills semantics. **v0.3** = benchmark, docs, packaging. Adapter *build order* inside v0.1 is Claude → OpenCode → agy only so the conformance suite is proven on the best-documented contract first (A2). Phase 7 is unscheduled.

### Phase 0 — scaffold and spikes
| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |
|---|---|---|---|---|---|---|---|---|
| P0.1 | Repo scaffold, scripts, boundary check. `package.json` declares **every** npm script any later Verify column uses (`typecheck`, `test`, `check:boundaries`, `export-schemas`, `bench`, `docs:check`, `bundle`), each delegating to `scripts/<name>.mjs`, plus `bin: substrate → bin/substrate.mjs`; later WPs replace the stub scripts, so nobody else edits `package.json` | — | `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `scripts/check-boundaries.mjs`, `scripts/{export-schemas,bench,docs-check,bundle}.mjs` (stubs that exit 0 with a notice), `src/index.ts`, `test/smoke.test.ts` | `npm install && npm run typecheck && npm test && npm run check:boundaries` | H/med | n | S | v0.1 |
| P0.2 | **S1** Claude headless spike: minimal-context worker without `--bare`, resume, denial reporting, `--permission-prompts none`/`dontAsk`, exit codes; measure the fixed input-token overhead of a trivial minimal-context session; capture fixtures (≤6 live calls) | — | `docs/spikes/S1-claude.md`, `test/fixtures/backends/claude/**` | files exist; doc answers U6, U7 or states UNKNOWN | H/hi (researcher) | — | M | v0.1 |
| P0.3 | **S2** OpenCode spike: tool restriction under v2 schema, `#variant` meaning, resume, exit codes, local llama.cpp provider, fixtures; measure the fixed per-session input-token overhead of a trivial prompt (≤6 live calls) | — | `docs/spikes/S2-opencode.md`, `test/fixtures/backends/opencode/**` | answers U1–U3 | H/hi | — | M | v0.1 |
| P0.4 | **S3** agy spike: stream-json fixtures, soft-deny text, conversation-id capture, resume, sandbox, effort values, agent/instruction file names; measure the fixed per-session input-token overhead of a trivial prompt (≤6 live calls) | — | `docs/spikes/S3-agy.md`, `test/fixtures/backends/agy/**` | answers U4, U5 | H/hi | — | M | v0.1 |
| P0.5 | **S4** Pricing table from official pricing pages with `asOf` and source URLs (no invented numbers) | — | `docs/spikes/S4-pricing.json` | JSON validates against the `PricingTable` shape in App. A | H/hi | — | S | v0.1 |
| P0.6 | **S5** UX conventions: slash commands, keybindings, status line of the three harnesses (docs only, capped) | — | `docs/spikes/S5-ux.md` | answers U9 | H/hi | — | S | v0.2 |

### Phase 1 — foundation and state core (no backends)
| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |
|---|---|---|---|---|---|---|---|---|
| P1.1 | **Foundation modules**: contract schemas (App. A as zod, plus JSON Schema export), util (ids, safe paths, glob match, byte caps/tails, redaction, time), config (precedence loader, JSONC, env + flag overlay, permission-rule parser), definitions loader (agents; commands/skills discovery stubs) | P0.1 | `src/contracts/**`, `src/util/**`, `src/config/**`, `scripts/export-schemas.mjs`, `contracts/*.schema.json`, `test/unit/contracts/**`, `test/unit/util/**`, `test/unit/config/**` | `npm test -- test/unit/contracts test/unit/util test/unit/config` | S/hi | y | L | v0.1 |
| P1.2 | **State core**: event store (JSONL append, validation, replay, torn-tail recovery, run lock), reducer, scheduler (DAG layering, overlap serialization, concurrency pool, budget checks), escalation ladder, usage ledger, pricing, estimates, aggregation | P1.1, P0.5 | `src/store/**`, `src/engine/reducer.ts`, `src/engine/scheduler.ts`, `src/engine/ladder.ts`, `src/ledger/**`, `src/backends/pricing.ts`, `test/unit/store/**`, `test/unit/engine/**`, `test/unit/ledger/**` | `npm test -- test/unit/store test/unit/engine test/unit/ledger` | S/hi | y | L | v0.1 |

### Phase 2 — workspace and spec
| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |
|---|---|---|---|---|---|---|---|---|
| P2.1 | **Git, verify, merge**: product workspace (run/task branches, worktrees, spec materialization, scope check, protected hashing, pathspec commit, cleanup), verify runner + bwrap sandbox wrapper, merger (merge-tree preflight, ordered merge, integration gate, bisect, checkpoints) | P1.1 | `src/git/**`, `src/verify/**`, `test/integration/git/**`, `test/integration/verify/**`, `test/integration/merge/**` | `npm test -- test/integration/git test/integration/verify test/integration/merge` | S/hi | y | L | v0.1 |
| P2.2 | **Spec and plan linter**: spec parser (manifest YAML, frontmatter, required sections), ecosystem detection + contract typecheck, repo map, plan linter L001–L027 with S-code hook points | P1.1, P1.2, P2.1 | `src/spec/**`, `test/unit/spec/**` | `npm test -- test/unit/spec` | S/hi | y | L | v0.1 |

### Phase 3 — backends
| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |
|---|---|---|---|---|---|---|---|---|
| P3.1 | **Backend foundation**: process supervisor (process groups, timeouts, SIGTERM→SIGKILL, caps, backpressure), NDJSON reader, fake harness (scenario engine + Claude dialect), **adapter conformance suite** (the shared battery every adapter imports and may not modify) | P1.1, P0.2 | `src/backends/process.ts`, `src/backends/ndjson.ts`, `test/fixtures/fake-harness/**`, `test/conformance/**`, `test/unit/backends/process.test.ts` | `npm test -- test/unit/backends/process test/conformance` | S/hi | n | L | v0.1 |
| P3.2 | **Claude adapter**: normalizer (golden tests from the S1 fixtures) + adapter | P3.1, P0.2, P1.2 | `src/backends/normalize/claude.ts`, `src/backends/adapters/claude.ts`, `test/unit/backends/normalize-claude.test.ts`, `test/integration/backends/claude.test.ts` | `npm test -- test/unit/backends/normalize-claude test/integration/backends/claude` | S/hi | y | L | v0.1 |
| P3.3 | **OpenCode adapter**: normalizer, fake dialect, adapter (per-run config generation, local llama.cpp provider) | P3.1, P0.3, P1.2 | `src/backends/normalize/opencode.ts`, `src/backends/adapters/opencode.ts`, `test/fixtures/fake-harness/dialects/opencode.mjs`, `test/unit/backends/normalize-opencode.test.ts`, `test/integration/backends/opencode.test.ts` | `npm test -- test/unit/backends/normalize-opencode test/integration/backends/opencode` | S/hi | y | L | v0.1 |
| P3.4 | **agy adapter**: normalizer, fake dialect, adapter (soft-deny detection, computed cost) | P3.1, P0.4, P1.2 | `src/backends/normalize/agy.ts`, `src/backends/adapters/agy.ts`, `test/fixtures/fake-harness/dialects/agy.mjs`, `test/unit/backends/normalize-agy.test.ts`, `test/integration/backends/agy.test.ts` | `npm test -- test/unit/backends/normalize-agy test/integration/backends/agy` | S/hi | y | L | v0.1 |

### Phase 4 — roles and the run loop
| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |
|---|---|---|---|---|---|---|---|---|
| P4.1 | **Roles**: role assets and prompt builders (planner, worker, test-writer, reviewer, replan), governor front door (OpenAI-compatible client with tool calling, bounded intake, typed tool set per App. A), rules-first router, advisory semantic lint, route→outcome ledger | P1.1, P1.2, P2.2 | `assets/agents/*.md`, `src/roles/prompts/**`, `src/roles/governor.ts`, `src/roles/governor-tools.ts`, `src/roles/router.ts`, `test/unit/roles/**` | `npm test -- test/unit/roles` | S/hi | y | L | v0.1 |
| P4.2 | **Planner and worker runners**: planner runner (spawn, collect artifacts, lint, engine-driven format retries, contract commit), worker runner (worktree, spawn, scope→verify→heal→report), failure packets, replan loop with escalation ladder and tier escalation | P4.1, P2.1, P2.2, P3.1 | `src/roles/planner.ts`, `src/roles/worker.ts`, `src/engine/packet.ts`, `src/engine/replan.ts`, `test/integration/roles/**`, `test/integration/engine/replan.test.ts` | `npm test -- test/integration/roles test/integration/engine/replan` | S/hi | y | L | v0.1 |
| P4.3 | **Run orchestrator and scenario suite**: the 15 scenarios of §14.5 except #11 (written first, protected), then `Engine.run/resume` (effects runner, gates, merge, integration, cancel, budget kill) | P4.2, P1.2, P2.1, P3.1 | `src/engine/engine.ts`, `src/engine/effects.ts`, `test/integration/scenarios/**` | `npm test -- test/integration/scenarios` | S/hi | y | L | v0.1 |

### Phase 5 — surface
| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |
|---|---|---|---|---|---|---|---|---|
| P5.1 | **CLI**: flags per §4.1; subcommands (run, plan, resume, status, tasks, cost, report, verify, merge, undo, discard, models, agents, backends, sessions, config, doctor, init); session index with `--resume/--continue/--fork-session`; text/json/stream-json output; exit codes; stdin prompt | P4.3, P3.2, P3.3, P3.4, P1.1, P1.2 | `src/cli/**` (command modules self-register through `src/cli/registry.ts`; later WPs add their own command files, so this excludes `bench.ts` and `agents-import.ts`), `src/store/sessions.ts`, `bin/substrate.mjs`, `test/integration/cli/**`, `test/unit/store/sessions.test.ts` | `npm test -- test/integration/cli test/unit/store/sessions` | S/hi | y | L | v0.1 |
| P5.2 | **Hooks, commands, skills**: hooks runner and gate integration, commands and skills semantics, `agents import` | P5.1, P4.3 | `src/hooks/**`, `src/config/commands.ts`, `src/config/skills.ts`, `src/cli/agents-import.ts`, `test/integration/hooks/**`, `test/unit/config/commands.test.ts` | `npm test -- test/integration/hooks test/unit/config/commands` | S/hi | y | L | v0.2 |
| P5.3 | **TUI**: state (slash-command registry, keymap, approval gates; pure) and rendering (Ink: prompt, event feed, task board, status line, dialogs, session picker) | P5.1, P0.6 | `src/tui/**`, `test/unit/tui/**` | `npm test -- test/unit/tui` | S/hi | y | L | v0.2 |

### Phase 6 — evaluation and hardening
| ID | Title | Deps | Write set | Verify | Tier/Eff | TF | Sz | Rel |
|---|---|---|---|---|---|---|---|---|
| P6.1 | **Hardening**: crash/resume chaos tests (kill at every event boundary, corrupt tail, double lock) and live smoke on every installed harness (opt-in, cost-capped) | P4.3, P5.1 | `test/integration/chaos/**`, `test/live/**` | `npm test -- test/integration/chaos` | S/hi | n | M | v0.1 |
| P6.2 | Security review (read-only): sandbox, env scrubbing, redaction, path traversal in globs, credential handling (I12). Each finding becomes a follow-up WP `P6.4.n` created by the orchestrator through a spec-writer with an explicit write set; more than 3 follow-ups need user approval before spawning | P4.3, P2.1 | `docs/reference/security-review.md` | review report written; follow-up WPs (if any) green | O/hi (reviewer) | — | M | v0.1 |
| P6.3 | **Benchmark**: harness (task format, arms A–D, report) and task suite (**user nominates repos/tasks**) | P4.3, P1.2, P5.1 | `bench/**`, `src/cli/bench.ts`, `scripts/bench.mjs`, `test/unit/bench/**` | `npm test -- test/unit/bench` | S/med | y | M | v0.3 |
| P6.4 | **Docs and packaging**: README, generated config + CLI reference, adapter guide, docs check, bundle script | P5.1, P1.1 | `README.md`, `docs/reference/config.md`, `docs/reference/cli.md`, `docs/reference/adapters.md`, `scripts/docs-check.mjs`, `scripts/bundle.mjs` | `npm run docs:check && npm run bundle && npm pack --dry-run` | H/med | n | M | v0.3 |

### Phase 7 — unscheduled
Dispatcher-mode experiment (native subagent fan-out where a backend proves reliable in headless) · ACP backend (needs a spike: per-session model pinning, usage reporting, clean kill) · MCP server exposing Substrate · reviewer role on by default · learned routing from the ledger · daemon/remote-control · further backends.

### Phase gates
| Gate | Passes when |
|---|---|
| G0 | scaffold green; S1–S4 delivered (S5 is needed only before P5.3) |
| G1 | contracts + core unit/property tests green; boundary check green |
| G2 | git/verify/merge integration tests green on throwaway repos; linter catalogue implemented |
| G3 | conformance suite green for `fake`, `claude`, `opencode` and `agy` |
| G4 | all 15 P4.3 scenarios green with fake backends |
| G5 (v0.1) | CLI headless works; chaos tests green; live smoke passes within its cost cap on every installed harness; P6.2 findings resolved or explicitly accepted |

---

## 17. Unknowns, spikes, risks

| ID | Unknown | Resolved by | Blocks |
|---|---|---|---|
| U1 | OpenCode v2: restricting worker tools/permissions headless | P0.3 | P3.3 |
| U2 | OpenCode effort control (meaning of `#variant`) | P0.3 | P3.3 |
| U3 | OpenCode failure exit codes / error events | P0.3 | P3.3 |
| U4 | agy agent definition, instruction file, skill path, sandbox semantics | P0.4 | P3.4, P5.2 |
| U5 | agy resume semantics + conversation id capture | P0.4 | P3.4 |
| U6 | Claude minimal worker context without `--bare` on subscription auth (docs: agent frontmatter `omitClaudeMd: true`, v2.1.271+; S1 measures the actual overhead) | P0.2 | P3.2, P4.1 |
| U7 | Claude `dontAsk` + `--permission-prompts none` behavior; denial reporting | P0.2 | P3.2 |
| U8 | Pricing table | P0.5 | P1.2 |
| U9 | Exact slash-command/keybinding conventions | P0.6 | P5.3 |
| U10 | ACP viability | Phase 7 spike | — |
| U11 | Principles from the Reddit thread | user pastes text (optional) | — |
| U12 | Prior-art beyond the three tools reviewed | optional research | — |
| U13 | Subscription rate limits under parallel workers | P6.3 benchmark; concurrency defaults 2–3 | — |
| U14 | Local-model routing quality | P6.3 arm D; rules-first until then | — |
| U15 | Ink vs OpenTUI | decided at P5.3 start | P5.3 |

**Top risks and mitigations:** (R1) silent under-delivery from soft denials → denial events per backend, conformance test; (R2) cost overrun → engine kill, estimates, approval threshold, phase gates; (R3) CLI drift after updates → version pins, conformance suite, `doctor`; (R4) vague specs → linter, advisory semantic lint, replan caps; (R5) Substrate scope creep → cut lines v0.1/0.2/0.3, MVP on one backend; (R6) bootstrapping without Substrate → ORCHESTRATOR-PROMPT.md defines a manual protocol with the same invariants.

---

## 18. Decision log and assumptions

**Confirmed by the user:** the name **Substrate**; the engine is **TypeScript**; Substrate is its own product and supports Claude Code, Antigravity and OpenCode as peer runners for planning or implementation (no privileged backend, no model runtime of its own); the design must closely mirror those three harnesses; research and detail-heavy design work goes to Haiku 5.5 high-effort subagents; the implementation is driven by an orchestrating agent that uses subagents.

**Resolved by the user:** all three adapters ship in v0.1 (OD2); the local model is called directly by Substrate and is how a project starts, while Substrate still cannot plan or implement by itself (OD3).

**Open decision (the plan shows the current default):**
| # | Question | Current default |
|---|---|---|
| OD1 | Dispatcher mode (an LLM inside a harness fans out workers through native subagents): deferred, first-class in v0.1, or dropped? | deferred, with an `ExecutionStrategy` seam reserved; recommendation: engine-side multi-process stays the default, dispatcher is judged later by benchmark |

**Assumptions (reversible — tell me to change any):**
| # | Decision | Rationale | Reversal cost |
|---|---|---|---|
| A1 | Direct engine-side spawn is the default; dispatcher mode deferred to Phase 7 | principles 11/12 of the research, headless subagents only confirmed on Claude | low (add a mode later) |
| A2 | Adapters are *built* in the order Claude → OpenCode → agy, as build sequencing only: the engine, contracts and conformance suite are backend-neutral and no backend is privileged | Claude's headless contract is the best documented and real samples exist, so it proves the conformance suite first | low |
| A3 | Tests that gate a task are written by a separate earlier task | removes self-grading | low |
| A4 | *(confirmed by the user: TypeScript engine; see above)* | — | — |
| A5 | No database; JSONL event log + projection | zero deps, diffable, replayable | medium |
| A6 | Engine-driven heal via session resume instead of a worker-called verify wrapper | works identically on all backends; worker cannot miscount | low |
| A7 | Engine (not worker) commits | removes git state errors from workers | low |
| A8 | Run branch is never merged into the user's branch without a gate | safety | none |
| A9 | The governor is the default front door, but an unreachable local model never blocks a run: fallback is to treat the prompt as the request in `plan` mode with the default planner and no clarification; `--no-governor` forces that path | the host is on the LAN and may be off | none |
| A10 | Workers default to no web tools and network denied | cost + injection + determinism | low |
| A11 | Default concurrency 3 (2 for local server) | subscription limits unknown | none |

---

## Appendix A — Contract declarations (authoritative; declarations only)

```ts
// ===== identifiers & enums =====
export type RunId = string;                    // "r_" + 12 base32 chars
export type TaskId = string;                   // /^[A-Z][A-Za-z0-9_-]{0,31}$/
export type SessionId = string;                // backend-native, opaque
export type BackendName = "claude" | "opencode" | "agy" | "fake";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type RoleName = "governor" | "planner" | "worker" | "test-writer" | "reviewer";
export type TaskClass = string;                // must be a key of Settings.routing
export type PermissionMode = "default" | "plan" | "acceptEdits" | "dontAsk" | "bypassPermissions";
export type PauseReason = "needs_approval" | "permission_denied" | "budget_exhausted"
  | "rate_limited" | "user_cancel" | "needs_human" | "backend_unavailable";
export type FailureClass = "verify_failed" | "scope_violation" | "protected_modified"
  | "budget_exceeded" | "timeout" | "worker_crashed" | "permission_denied" | "rate_limited"
  | "merge_conflict" | "integration_failed" | "spec_invalid";

export interface Command { run: string; cwd?: string; timeout_s: number; env?: Record<string, string>; }
export interface Budget { max_usd?: number; max_tokens?: number; timeout_min?: number; max_turns?: number; }

// ===== planner artifacts =====
export interface Manifest {
  version: 1; run_id: RunId; goal: string; base_ref: string;
  ecosystem?: "node-ts" | "python" | "rust" | "go" | "other";
  setup: Command[];                            // engine-run once, with network
  contracts: { files: string[]; typecheck: Command[] };
  integration_verify: Command[];               // after every batch merge
  tasks: { id: TaskId; spec: string }[];       // spec = path relative to the run dir
  budget?: { max_usd?: number; max_tokens?: number; max_wall_min?: number };
}
export interface TaskSpecFrontmatter {
  id: TaskId; title: string; class: TaskClass; depends_on: TaskId[];
  read: string[];                              // intended context (budgeted)
  write: string[];                             // existing files it may modify
  create: string[];                            // new files it may create
  protected: string[];                         // must be byte-identical afterwards
  verify: Command[];                           // ALL must exit 0; engine runs them
  effort?: Effort; budget?: Budget;
}
// Required body headings: Objective, Interface, Behavior, Invariants, Edge cases, Guardrails, Out of scope.

// ===== results =====
export interface VerifyResult { cmd: string; exit_code: number | null; timed_out: boolean;
  duration_ms: number; stdout_tail: string; stderr_tail: string; truncated: boolean; }
export interface UsageRecord { backend: BackendName; model: string; input_tokens: number; output_tokens: number;
  cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number;
  cost_usd: number; cost_source: "reported" | "computed"; at: string; }
export interface WorkerReport { task_id: TaskId; generation: number; attempt: number; session_id: SessionId;
  backend: BackendName; model: string; effort?: Effort; status: "passed" | "failed";
  failure_class?: FailureClass; files_changed: string[]; usage: UsageRecord; duration_ms: number;
  verify: VerifyResult[]; denials: { tool: string; reason?: string }[]; final_message: string /* capped */; }
export interface FailurePacket { run_id: RunId; task_id: TaskId; generation: number; failure_class: FailureClass;
  spec_path: string; attempts: WorkerReport[];
  diff: { stat: string; patch_path: string; truncated: boolean };
  verify_output: VerifyResult[]; scope_violations: string[];
  worker_summary: string /* capped, untrusted */; related_contracts: string[]; dependents: TaskId[]; }
export interface Diagnostic { code: string; severity: "error" | "warn" | "info" | "gate";
  task?: TaskId; message: string; path?: string; }

// ===== backend layer =====
export type BackendEvent =
  | { type: "session.started"; session_id: SessionId }
  | { type: "assistant.text"; text: string }
  | { type: "tool.call"; id: string; name: string; input_summary: string }
  | { type: "tool.result"; id: string; ok: boolean; output_summary: string }
  | { type: "permission.denied"; tool: string; reason?: string }
  | { type: "usage"; record: UsageRecord; cumulative: boolean }
  | { type: "subagent"; parent_id?: string; raw: unknown }
  | { type: "error"; kind: "rate_limit" | "auth" | "crash" | "timeout" | "protocol"; message: string }
  | { type: "session.result"; ok: boolean; stop_reason?: string; final_text: string;
      usage?: UsageRecord; exit_code: number | null; structured_output?: unknown };

export interface Capabilities { name: BackendName; version_pin: string; effort: boolean; structured_output: boolean;
  budget_flag: boolean; cost_reported: boolean; resume: boolean;
  permission_denial_signal: "event" | "stderr" | "none"; sandbox_flag: boolean;
  native_subagents_headless: boolean; max_concurrency?: number; }
export interface SpawnRequest { role: RoleName; cwd: string; prompt: string; system_append?: string;
  model: string; effort?: Effort;
  permission: { allow: string[]; deny: string[] };
  json_schema?: object; budget: Budget & { timeout_ms: number };
  env?: Record<string, string>; add_dirs?: string[];
  session?: { id?: SessionId; resume?: SessionId; fork?: boolean }; }
export interface SessionResult { ok: boolean; session_id: SessionId; final_text: string; usage: UsageRecord;
  exit_code: number | null; denials: { tool: string; reason?: string }[]; killed_for?: "budget" | "timeout" | "cancel"; }
export interface SessionHandle { pid: number; events: AsyncIterable<BackendEvent>;
  result(): Promise<SessionResult>; kill(reason: "budget" | "timeout" | "cancel"): Promise<void>; }
export interface EnvReport { ok: boolean; version?: string; pin_matches: boolean; problems: string[]; }
export interface HarnessAdapter { readonly capabilities: Capabilities;
  validateEnvironment(): Promise<EnvReport>; spawn(req: SpawnRequest): SessionHandle; }

// ===== settings (JSONC file; keys) =====
export interface Settings {
  backends: Record<string, { bin?: string; version_pin?: string; max_concurrency?: number; extra?: object }>;
  roles: { planner: Route; reviewer?: Route & { enabled: boolean };
    governor?: { enabled: boolean; endpoint: string; model?: string; enable_thinking: boolean; timeout_s: number;
      max_clarifying_turns: number } };
  routing: Record<TaskClass, Route & { budget?: Budget }>;  // plus `escalation: string[]` chain of route keys
  pricing: PricingTable;
  budgets: { run: { max_usd?: number; max_tokens?: number; max_wall_min?: number }; task: Budget;
    l1_replans_per_task: number; l2_per_run: number; planner_format_retries: number; approval_threshold_usd: number };
  concurrency: { workers: number };
  permissions: { allow: string[]; deny: string[]; ask?: string[] };
  sandbox: { enabled: boolean; network: "deny" | "allow" };
  git: { on_scope_violation: "revert" | "fail"; branch_prefix: string; auto_merge: boolean };
  instructions: { workers: "none" | "project" };
  execution: { strategy: ExecutionStrategy };
  hooks?: Record<string, { command: string; timeout_s?: number }[]>;
}
export interface Route { backend: BackendName; model: string; effort?: Effort; }
export interface PricingTable { asOf: string; sources: string[];
  models: Record<string, { input_per_mtok: number; output_per_mtok: number;
    cache_read_per_mtok?: number; cache_write_per_mtok?: number }>; }

// ===== engine API =====
export interface RunOptions { prompt: string; cwd: string; mode: "auto" | "solo" | "plan";
  permission_mode: PermissionMode; overrides?: Partial<Settings>; resume?: RunId;
  signal?: AbortSignal; onEvent?: (e: EngineEvent) => void; }
export interface RunSummary { run_id: RunId; status: "finished" | "failed" | "paused" | "cancelled";
  pause_reason?: PauseReason; tasks: Record<TaskId, { state: string; generation: number; failure_class?: FailureClass }>;
  usage: { total_usd: number; by_role: Record<string, number> }; branch: string; exit_code: number; }
export interface Engine { run(opts: RunOptions): Promise<RunSummary>; resume(run_id: RunId, opts?: Partial<RunOptions>): Promise<RunSummary>; }
export interface EngineEvent { v: 1; seq: number; ts: string; run_id: RunId; type: string; data: unknown; }  // types: App. D

// ===== execution strategy seam (v1 implements "direct" only; "dispatcher" is reserved, see OD1) =====
export type ExecutionStrategy = "direct" | "dispatcher";

// ===== governor front door =====
export type GovernorTool =
  | { name: "start_run";  args: { request: string; mode?: "solo" | "plan"; permission_mode?: PermissionMode } }
  | { name: "plan_only";  args: { request: string } }
  | { name: "resume_run"; args: { run_id: RunId } }
  | { name: "run_status"; args: { run_id?: RunId } }
  | { name: "show_cost";  args: { run_id?: RunId } }
  | { name: "cancel_run"; args: { run_id: RunId } }
  | { name: "ask_user";   args: { question: string } };
export interface RoutingDecision { mode: "solo" | "plan"; task_class?: TaskClass; planner_route?: string;
  rationale: string; needs_clarification?: string[]; }
```

## Appendix B — Example settings and routing (configuration values, not code)

*Illustrative and Claude-only for brevity. `substrate init` builds the real routing from the harnesses `doctor` detects, and any role may use any backend: for example `planner` on `agy`, `mechanical`/`boilerplate` workers on `opencode` with the local model, `feature` workers on `claude`. Model ids for `opencode` and `agy` come from `opencode models` / `agy models`.*

```jsonc
{
  "roles": {
    "planner":  { "backend": "claude", "model": "claude-opus-5-5", "effort": "high" },   // top tier: user-configurable
    "reviewer": { "enabled": false, "backend": "claude", "model": "claude-opus-5-5", "effort": "high" },
    "governor": { "enabled": true, "endpoint": "http://192.168.1.72:8080/v1", "enable_thinking": false, "timeout_s": 10 }  // user-local → settings.local.json
  },
  "routing": {
    "search":      { "backend": "claude", "model": "claude-haiku-5-5",  "effort": "low" },
    "mechanical":  { "backend": "claude", "model": "claude-haiku-5-5",  "effort": "medium" },
    "boilerplate": { "backend": "claude", "model": "claude-haiku-5-5",  "effort": "medium" },
    "tests":       { "backend": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
    "feature":     { "backend": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
    "refactor":    { "backend": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
    "debug":       { "backend": "claude", "model": "claude-opus-5-5",   "effort": "high" },
    "review":      { "backend": "claude", "model": "claude-opus-5-5",   "effort": "high" },
    "escalation":  ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
  },
  "budgets": { "run": { "max_usd": 5 }, "task": { "max_usd": 0.5, "timeout_min": 20, "max_turns": 60 },
               "l1_replans_per_task": 2, "l2_per_run": 2, "planner_format_retries": 2, "approval_threshold_usd": 2 },
  "concurrency": { "workers": 3 },
  "permissions": { "deny": ["Agent", "Bash(git commit*)", "Bash(git push*)", "Bash(git checkout*)", "Bash(git reset*)", "Bash(git rebase*)", "Bash(git clean*)", "WebFetch", "WebSearch"] },
  "sandbox": { "enabled": true, "network": "deny" },
  "git": { "on_scope_violation": "revert", "branch_prefix": "substrate/", "auto_merge": false },
  "instructions": { "workers": "none" }
}
```
`pricing` is intentionally absent: it is filled from S4 (P0.5) with an `asOf` date. The numbers above are caps chosen to be conservative, not estimates.

## Appendix C — Lint catalogue

`error` blocks execution · `warn` is reported · `gate` requires approval.
| Code | Sev | Check |
|---|---|---|
| L001 | error | Manifest/spec fails schema |
| L002 | error | Duplicate or malformed task id |
| L003 | error | Spec file missing for a task, or orphan spec |
| L004 | error | `depends_on` references an unknown task |
| L005 | error | Dependency cycle |
| L006 | error | Path escapes the repo (absolute, `..`, symlink out) |
| L007 | error | `write` path does not exist (use `create` for new files) |
| L008 | warn | Dependency-ready tasks overlap on write/create sets → engine auto-serializes by id |
| L009 | error | A task's write/create intersects another task's `protected` (unless that task is the owner `tests` task) |
| L010 | error | No `verify` command |
| L011 | error | Verify binary not found or `cwd` invalid |
| L012 | error | Verify references a test path that does not exist and no earlier task creates it |
| L013 | error | Placeholder text (`TODO`, `FIXME`, `TBD`, `...`, `<placeholder>`) in Interface/Behavior |
| L014 | error | Required section missing or empty |
| L015 | error | `class` not in routing table |
| L016 | error | Budget missing or above per-task cap |
| L017 | error | `read` set exceeds the context budget (file count/bytes) → split the task |
| L018 | error | Contract stubs fail typecheck |
| L019 | error | Interface references a contract file that does not exist |
| L020 | warn→error (config) | Implementation body in spec (long code block containing function bodies) |
| L021 | warn | `integration_verify` empty |
| L022 | gate | Estimated cost above approval threshold |
| L023 | warn (error with `--red-check`) | Verify already passes at base (test is meaningless) |
| L024 | warn | `tests`-class task writes non-test paths, or non-tests task writes test paths |
| L025 | warn | Requested run budget above cap (clamped) |
| L026 | warn | Task count above `max_tasks` (default 40) |
| L027 | error | `protected` path does not exist at base and is not created by an earlier task |
| S001–S004 | advisory | Governor semantic checks: ambiguity, missing edge cases, spec/contract mismatch, task too large |

## Appendix D — Engine event types

`run.created` · `run.routed` · `plan.started` · `plan.produced` · `plan.lint` · `plan.approved` · `plan.rejected` · `contracts.committed` · `setup.done` · `batch.started` · `task.ready` · `task.worktree.created` · `task.session.started` · `task.session.ended` · `task.scope.checked` · `task.verify.started` · `task.verify.finished` · `task.healing` · `task.passed` · `task.failed` · `task.merged` · `task.blocked` · `replan.started` · `replan.finished` · `batch.merged` · `integration.started` · `integration.finished` · `usage.recorded` · `run.paused` · `run.resumed` · `run.budget.warning` · `run.budget.exceeded` · `run.finished`. Every event is an `EngineEvent` with a monotonically increasing `seq`.

## Appendix E — Changes from `PLAN.md` (Valence)

| Original | Substrate |
|---|---|
| Layer 3 LLM "mechanical dispatcher" | Removed from the default path; engine fans out one process per task (A1) |
| Worker counts its own strikes and writes the Failure Packet | Engine owns counters; heal = engine-driven session resume; packet built by code |
| Worker runs verification | Engine runs all acceptance commands and owns the verdict |
| `.tasks/` in the main tree | Run directory + materialized `TASK.md` in each worktree (untracked files don't reach worktrees) |
| "Halt the entire batch" vs "preserve successes" (contradictory) | Siblings finish; only dependents block; `FailurePacket` per failed task |
| Single `failedTask` in `BatchRunResult` | Per-task reports; no batch-level single failure |
| Local LLM validates plans and routes | Deterministic linter; governor advisory and optional; rules-first routing |
| Unbounded replans | Escalation ladder with caps and tier escalation |
| Tests written by the worker | Separate `tests`-class tasks; `protected` paths |
| Prose signatures in specs | Real stub files compiled before workers spawn |
| Hardcoded model names | Routing table in config |
| HAL with three methods | `HarnessAdapter` v2: capabilities, version pin, `spawn` returning an event stream + kill |

## Appendix F — Research provenance

`research/01-harness-conventions.md` (read: digest + unified copy table; real Claude stream-json sample captured) and `research/02-principles-and-prior-art.md` (read: digest). Local measurements made during planning: harness CLI versions and flags; llama.cpp server profile (model, context, slots, tool calling, schema-constrained output, thinking-token behavior); git worktree behavior (untracked files absent in new worktrees; `merge-tree --write-tree` conflict detection; shared object DB, per-worktree index).
