# Binding decisions

Status: FINAL as of 2026-10-17. If any other document (`SUBSTRATE-PLAN.md`, `README.md`, `docs/reference/*`, `research/*`, old specs under `build/specs/`) disagrees with this file, **this file wins**. If you find a conflict this file does not settle, stop and write it to `docs/plan/BLOCKED.md`; do not choose silently.

## What Substrate is (one paragraph)
Substrate is a CLI that other agents (mainly "Hermes") and people call to get coding work done cheaply and reliably. It asks one strong **planner** model to turn a request into a plan, then runs cheaper **worker** models on the plan's tasks, one headless harness process per task in its own git worktree, verifies every task with real commands, and merges only what passes. Control flow is ordinary code, not an LLM. It drives three existing harnesses: Claude Code (`claude`), OpenCode (`opencode`) and Antigravity (`agy`).

## Architecture
- **A1. Execution model.** One headless harness process per task, each in its own git worktree. The engine (TypeScript code) is the orchestrator: it sequences tasks, assembles prompts, runs verify commands, commits, merges and escalates. There is **no orchestrator LLM** and **no native subagents**; workers get the `Agent`/subagent tool denied.
- **A2. Roles.** Planner (strong model), worker (medium model), a cheap "fast" model for easy task classes, test-writer (a worker of class `tests`), reviewer (optional, off by default). The **governor / local triage model is retired from the default path.** Existing governor code stays compiled and untouched until work package R5.4 (optional) removes it. Do not wire it, extend it, or add tests for it.
  2026-10-20 (owner): the governor and the local-model front-door idea were dropped; the deterministic router replaces them; the governor code was deleted.
- **A3. Models per provider ("profile").** Each provider (`claude`, `opencode`, `agy`) has a profile of up to three model slots, each `{model, effort}`: `plan` (strongest), `work` (medium), `fast` (optional, cheapest). A run needs a planner provider and a worker provider; the planner may come from a different provider than the workers. Task classes map to slots: `search`, `mechanical`, `boilerplate` use `fast` (or `work` if `fast` is absent); `tests`, `feature`, `refactor` use `work`; `debug`, `review` use `plan`. The escalation chain on replan is `fast → work → plan`, skipping repeats. The planner never names a model.
- **A4. Caller interface.** Callers are mostly agents. The interface is the CLI plus JSON: a request schema (file or stdin), machine-readable validation errors (exit 2), `--output-format json|stream-json` results, and a question/resume protocol (exit 3 with `questions`, answered via resume). No TTY is assumed. An MCP server is **not** in scope.
- **A5. Local model.** A local llama.cpp model is only ever a **worker route** through an OpenCode custom provider, configured by the user in `settings.local.json`. Its address is never written into committed files. Spawn prompts and specs never contain a raw IP or port.
- **A6. Security is out of scope.** Substrate wraps harnesses that have their own sandboxes and permission systems. Dropped: bubblewrap/network denial for workers, environment scrubbing, credential-file permissions, the P6.2 follow-ups (`P6.4.x`, SEC-001..SEC-010). `sandbox.enabled` defaults to `false`; if a user enables it and `bwrap` is missing, the command errors instead of silently running unsandboxed. **Kept, because it is correctness:** workers must not `git commit/push/checkout/reset/rebase/clean` and must not spawn subagents (the engine commits); scope checks and protected-file hash checks decide pass/fail.
- **A7. Central model and usage reporting is a core feature.** `substrate models` lists models by provider and overall; `substrate usage` reports tokens and cost across all harnesses. See "Reporting" below.
- **A8. Durable vs disposable state.** In a user's project, `.substrate/charter.md` (the project's main idea) and `.substrate/archive/` (compact records of finished runs) are durable and committable; `runs/`, `worktrees/`, `state/`, `sessions/`, `ledger/` and `settings.local.json` are runtime and gitignored. See "Charter and archive" below. In this repo, `docs/plan/DECISIONS.md` and `docs/DESIGN` material are durable; `docs/plan/wp/` and `docs/plan/IMPLEMENTATION-PLAN.md` are disposable once the R-series is done and move to `docs/archive/`.

## Reporting (A7 detail)
- Primary numbers everywhere: **input tokens, output tokens, cost**. Cache read/write and reasoning tokens are secondary and shown only with `--cache` / in JSON.
- A usage record is `{backend, model, input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?, reasoning_tokens?, cost_usd, cost_source}`. `cost_source` is `reported`, `computed` or `unknown`. **Never report an unknown cost as $0 and never drop a record because a price is missing**: record the tokens with `cost_source: unknown` and `cost_usd: 0`, and make reports show "unknown" for those rows.
- Each usage event also carries `role`, `task_id`, `generation`, `attempt` and `class` so reports can group by them.
- Storage: append-only JSONL at `.substrate/ledger/usage.jsonl` (project) mirrored to `$XDG_STATE_HOME/substrate/usage.jsonl` (default `~/.local/state/substrate/usage.jsonl`) unless `usage.global` is `false`. Each line includes the project path.
- Model listing: claude has no list command: use its documented aliases (`haiku`, `sonnet`, `opus`, `fable`) plus every model id in settings and the price table. OpenCode: parse `opencode models`. agy: parse `agy models`. Cache results in `.substrate/state/models.json`; refresh on `--refresh`.

## Charter and archive (A8 detail)
- `.substrate/charter.md`: free Markdown, optional frontmatter `version: v1`. It states what the project is for and its standing constraints. The planner receives it (capped at 4 KB) on every plan. It is never overwritten automatically.
- `.substrate/archive/<version>/<run_id>/`: written automatically when a run reaches a terminal state: `summary.md` (goal, outcome, tasks, tokens in/out, cost, what was learned), `manifest.yaml`, `tasks/`, `decisions.md`, `usage.json`. `.substrate/archive/<version>/INDEX.md` has one line per run.
- The planner receives the five most recent summaries of the **current** version (capped at 6 KB). Starting a new version (`substrate charter bump v2`) keeps the charter and leaves older versions' archives out of planner context. Implementation details of an old version never leak into the new one.

## Resolved contradictions in SUBSTRATE-PLAN.md
| Topic | Decision |
|---|---|
| Worker network | Not denied (Claude needs it to reach its API; security is out of scope). |
| Run budget exhausted | Run `PAUSED(budget_exhausted)`, exit 4. A single task timeout or per-task budget exceeded is an L1 trigger. |
| `substrate plan` | Always stops after plan + lint + cost estimate, whatever the cost. |
| Worktree path | `.substrate/worktrees/<run_id>/<task_id>-g<n>/`; task branch `substrate/tasks/<run_id>/<task_id>-g<n>`; run branch `substrate/runs/<run_id>`. |
| `routing.escalation` | List of model ids resolved through the profile slots (A3), not aliases. |
| stream-json event names | The engine event names in SUBSTRATE-PLAN Appendix D are canonical. §4.6's older names are replaced by a mapping table generated from the event catalog (R1.2). |
| `bypassPermissions` merge | Auto-merge into the user's branch only if `git.auto_merge` is `true`; otherwise leave the run branch for `substrate merge`. |
| Solo mode | One worker in a worktree, no planner or manifest. Verify commands come from repeatable `--verify "<cmd>"`, else the detected ecosystem default, else the run warns and only scope and budget checks apply. The engine commits to a task branch under the run branch. L0 heal applies. |
| Planner output protocol | The planner writes files into its working directory (the run directory). Only if it cannot write files, the engine accepts fenced blocks with info string `<lang>:<relative path>`. Contract stubs live at `<run dir>/<repo-relative path>`. See `assets/prompts/README.md`. |
| Planner questions | A `QUESTIONS.md` file plus the finish line `NEEDS INPUT` pauses the run (exit 3) and surfaces the questions to the caller. |
| `.substrate/` in git | `substrate init` writes `.substrate/.gitignore` for runtime paths. It does not add `.substrate/` to `.git/info/exclude`. |
| Release tag | New work packages use `v0.3`. |
| `-w/--worktree` flag | Removed. It was never implemented and agent callers do not need a named run branch (R1.8). |
| Bare `substrate` | No arguments: print help. There is no TUI: the inert scaffold in `src/tui/` is deleted by R0.7. Any other first word that is not a command is a prompt (so a single-word prompt works). |
| Prompts | All prompt text lives in `assets/agents/*.md` and `assets/prompts/**` (already written). Code loads and renders them; it never contains prompt text. |

## Out of scope (do not build, do not "scaffold")
A TUI (the existing scaffold is deleted by R0.7), hooks, slash commands, skills semantics, MCP server, benchmark execution, security work (A6), the governor (A2), an orchestrator LLM (A1), native subagents (A1), packaging for npm publication.

## Note 2026-10-20 (R7.2): explicit models and a git repository before a run

This changes A3 in one respect. Profile slots still hold each provider's default models in settings, but `run` and `plan` no longer take a model from them. A model counts only when the caller names it on the command line (`--plan`, `--work`, `--model`, `--worker-model`) or in the request payload. `run` in auto or plan mode needs a planner and a worker model, `run` in solo mode needs the worker model, and `plan` needs the planner model. Missing models exit 2 before any run state exists.

`run` and `plan` also need a git repository before anything else starts. An empty directory is initialised with one empty commit. A non-empty directory that is not a repository exits 2 before any spend.

Supersedes the R6.4 rule that a named planner forces `plan` in auto mode: with both models mandatory, a named planner carries no signal. The router decides plan vs solo in auto; `--mode plan` forces planning.

## Note 2026-10-21 (R8.1): graceful failure, changes two rows above

- `.substrate/` in git (table above, "does not add `.substrate/` to `.git/info/exclude`") is changed. `.substrate/` is now added to the repository's local exclude file at run start, so a run never shows as untracked in the user's checkout. The owner approved this for graceful failure (criterion a).
- Failed tasks are no longer kept for a human to resume by default. A task that the replan ladder cannot continue, with no QUESTIONS.md, is failed for good (`task.failed` with `can_replan: false`); its dependents are skipped (`task.skipped`); the run ends failed (exit 1). A pause with exit 3 remains only for real questions and for the permission and rate-limit pauses. The planner-questions row above is unchanged.
- A merge conflict drops the conflicting task without a replan (`merge_conflict`, `can_replan: false`); the message names the tasks it collided with.
- A finished (merged or failed) run removes its worktrees and task branches; the run branch and the failed work's evidence (`packets/<task>-g<n>.patch` and the attempt reports) are kept under the run directory.

## Note 2026-10-21 (R10.1): a finished run merges by default, superseding the `bypassPermissions merge` row

The row `bypassPermissions merge` (table above, "Auto-merge into the user's branch only if `git.auto_merge` is `true`") is superseded. The owner asked, after a finished run's summary said `Merged: no` and `run: substrate merge <id> (or pass the merge flag next time)`, why it did not merge automatically. The owner's decision: a run that finishes successfully merges into the user's branch by default.

Why: the caller of Substrate (an agent such as Hermes, or a person) expects the requested change to appear in the project when the run succeeds. Having to remember a flag or a follow-up command left finished work stranded on a run branch.

The rule now:
- `git.auto_merge` defaults to `true`. `--no-merge` and the request's `merge: false` keep one run on its run branch. `--merge` and `merge: true` land one run even when the setting is `false`. Precedence: the flag or the request field, then the project setting, then the default.
- The safety net: nothing lands unless the run ends `finished` with every task passed and integration verify passed. A failed, partial, paused, interrupted or budget-stopped run never lands, and `substrate plan` never lands. A dirty checkout (uncommitted tracked changes) refuses the landing. A run lands only into the branch it started on: if the user switched branches meanwhile, or HEAD is detached, it does not merge. A conflict at landing is refused with the files named, leaving no merge state.
- `substrate merge <run>` is unchanged: it merges into the current branch, because the user chose it.

## Note 2026-10-21 (R10.3): a resume keeps the landing and the worker count its run recorded

The R10.1 precedence (the flag or the request field, then the project setting, then the default) applies to a new run. A resume now reads the landing its run recorded on `run.created` (`merge`) before the setting, so a `--no-merge` run stays on its branch when resumed without flags. `--merge` or `--no-merge` on the resume still wins. The worker count is recorded the same way (`concurrency`), and `--concurrency` on a resume wins. Runs logged before R10.3 have neither field and use the setting, as before. Code: `src/cli/commands/resume.ts`, `src/engine/engine.ts`.


## Note 2026-10-21 (R10.4): a run that did not finish is resumable; reverses the R8.3 rule (known issue 41)

The owner reversed the R8.3 rule that a failed run is not resumable (`failure_class: not_resumable`). The owner's reason: any stopped run should be continuable, "make it be able to be resumed if stopped for whatever reason, so I guess it should write completed jobs somewhere", and "allow more control".

The rule now:
- Any run that did not end `finished` is resumable: paused, interrupted, budget-stopped, stopped uncleanly, internal error, and failed. A finished run still says it is finished, and prints the merge hint when it is not merged.
- Passed work is already durable: it is on the run branch and in the event log. A resume keeps it and does not plan again when a plan was accepted.
- Failed tasks are retried instead of dropped for good: they return to the queue as a new generation with a fresh attempt counter and a fresh replan ladder, on a worktree and branch made from the run branch's current HEAD. Their skipped dependents return to the queue. The run spend counts against the run budget.
- The user-visible guarantee stays: failed work never lands in the user's branch. A run lands only when it finishes with every task passed and integration verify passed.
- The reopening is recorded as one journal event, `run.reopened` (reason `planning`, `setup` or `tasks`, with `failed_tasks`, `skipped_tasks`, `kept_tasks`). The reducer is the only place that changes the states, so a replay of the log gives the same state.

Code: `src/engine/engine.ts` (`endedFailed`, `reopenData`), `src/engine/reducer.ts` (`run.reopened`, `ladder_base`), `src/engine/ladder.ts`, `src/engine/actions/integrate.ts`, `src/engine/failed-run.ts`, `src/cli/commands/resume.ts`.

## Note 2026-10-21 (R12.1): spend and time limits are opt-in; planner budgets are estimates

The owner's instruction (2026-10-21): "there's no need, that seems like it will just stop agents that end up taking too long because their task is actually hard". This supersedes the budget-default rows above: "Run budget exhausted" (the exit 4 row, and its clause that a per-task budget exceeded is an L1 trigger, which now needs a per-task cap the caller set) and "Solo mode" (its budget checks run only when a cap is set).

The rule now:
- `budgets.run.max_usd`, `budgets.task.max_usd`, `budgets.task.timeout_min` and `budgets.approval_threshold_usd` are unset by default. An unset limit applies nowhere: no `--max-budget-usd` reaches a harness, no run pauses for its cost, no task is killed for its cost or time, and the estimate never pauses a run for approval.
- The caller sets a limit with `--max-budget-usd`, `SUBSTRATE_MAX_BUDGET_USD`, `--timeout`, the settings keys, or the request's `budget` object. A set limit is enforced as before.
- The planner's `budget` fields (`max_usd`, `max_tokens`, `timeout_min`, `max_turns` in a task spec; `max_usd` in the manifest) are advisory. They feed the cost estimate and nothing else.
- Cost is still shown live (`status`, `watch`, the summary). `substrate stop <id>` ends a run at any time.

Code and tests: `test/e2e/limits-optin.test.ts`; known issue 69.


## Note 2026-10-21 (R12.2): the plan's setup runs in the integration worktree; the base check is removed

The owner's run `r_ZEEOKTFXRD33` failed its final check because `npx tsc` ran in the integration worktree, where the plan's `setup` (`npm install --no-save typescript@5`) had never run. Setup ran only in each task worktree. The rule now:
- The plan's `setup` commands run once in every worktree that runs a check: each task worktree before its worker, the integration worktree before the final `integration_verify`, and the throwaway worktree of `merge --partial`. They run in that worktree's own cwd, with the same timeouts and environment, through one helper (`src/git/setup.ts`).
- The base check (R3.6 behaviour 8, R7.11) is removed. `integration_verify` runs once, on the merged run branch, and the final verify decides the run. No note about the base commit is printed, and `integration.started` carries no `base_verify_passed` field (the schema keeps it optional so older logs still read).
- The bisect keeps its anchor: when the final verify fails, the base commit is verified once, inside the bisect, and a passing base lets it name the culprit (R9.1). A passing run never runs that base verify, and no note about the base is printed.

Code and tests: `test/e2e/integration-setup.test.ts`, `test/e2e/integration-base.test.ts`; known issue 70.
