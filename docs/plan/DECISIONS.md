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
| Run budget exhausted | *Superseded 2026-10-23: there is no run budget, so no run pauses for its cost. See the note of 2026-10-23.* Run `PAUSED(budget_exhausted)`, exit 4. A single task timeout or per-task budget exceeded is an L1 trigger. |
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

## Note 2026-10-21 (R12.1): spend and time limits are opt-in; planner budgets are estimates (superseded in part, 2026-10-23: see the last note)

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

## Note 2026-10-21 (R12.2): a check that cannot run is a warning; a single-task plan is not verified again

The owner's rule (2026-10-21): a check that cannot run is a warning, never a failed run; fewer gates beat more tests. The rule now:
- The final `integration_verify` has four outcomes. `passed` and `failed` are verdicts: `failed` is a commands-ran-and-one-exited-non-zero-with-ordinary-output result, and it still fails the run with exit 1. `could_not_run` is no verdict: the setup failed, a command was not found or could not be executed (exit 127 or 126), a command could not start, the output carries a tool-missing marker (`src/engine/verify-markers.ts`), or the command timed out. A `could_not_run` run finishes with exit 0 and lands as usual; the progress warning and the summary (`Verification: not run (<reason>)`) say the work is not verified as a whole, and `result.json` carries `verification: "not_run"` and `verification_note`.
- A `merge --partial` whose check could not run lands with a stderr warning; a failed check still refuses.
- A plan with exactly one task and at least one `integration_verify` command records `integration.skipped` (`reason: single_task`) and is not verified again: the task's own verify ran in its worktree, and the run branch is base plus that task. A plan with no `integration_verify` command is unchanged.
- Bisect runs only for a `failed` verdict.

Code and tests: `src/engine/verify-outcome.ts`, `src/engine/verify-markers.ts`, `test/unit/engine/verify-outcome.test.ts`, `test/e2e/integration-setup.test.ts`; known issue 71.

## Note 2026-10-21 (R12.3): plan lint blocks only a plan that cannot run (2026-10-23: L016, L022 and L025 are removed; see the last note)

The owner's policy (2026-10-21): plan-lint false positives rejected valid plans twice (L009 and L012 on the first snake run, L011 on `d=$(mktemp -d)`), and each rejection cost a paid planner retry or a failed run. A check that cannot run, or a rule that only guesses, must not block. The engine already enforces scope (a change outside a task's write set is dropped at merge), each task's verify and the final verify, so most pre-flight lint rules were redundant gates. The rule now:
- A blocker is the only error. It refuses the plan and costs a planner format retry. A blocker is a plan that cannot be scheduled or would corrupt the engine's state: a manifest that does not parse or fails its schema; a task spec that is missing, outside the run directory, unreadable or unparsable; a duplicate or invalid task id; `depends_on` naming an unknown task; a dependency cycle; a contract file outside the repository. The table in `docs/reference/plan-lint.md` lists each rule's severity.
- Every other rule is a warning: write-set and scope overlap, protected paths, verify binary and cwd, the read set, the contract typecheck (a type error and a checker that cannot run alike), placeholder tokens, required sections, budgets, class and route checks, test structure and style. A warning never refuses a plan and never costs a retry. Warnings are recorded and shown to the reviewer (R12.3 outputs, see the cli reference).
- Unknown task classes are not a blocker: routing has a fallback for every class.
- L022 (the estimate above the approval threshold) stays a `gate`. *Superseded 2026-10-23: L022 is removed and the approval pause with it.* It was never a blocker and does not refuse or retry.

Code and tests: `src/spec/rules.ts`, `src/roles/planner.ts` (`ingestPlanDraft`), `test/unit/spec/lint-severity.test.ts`, `test/e2e/planner-retry-post-contract.test.ts`; known issue 24.

## Note 2026-10-21 (R12.4): a failed final check gets up to two code repairs; the check is never loosened

The owner's policy (2026-10-21): Substrate's own checks must not stop good work, and a run that ends on a failed check must not come back to the owner for a CODE failure. Ownership of a failed final check: an environment mismatch is Substrate's (R12.2, a warning); a WRONG or uncheckable check goes to the planner (not implemented in R12.4, known issue 73); a CODE failure is a worker's job. The rule now:
- A failed final `integration_verify` for a real reason (the commands ran and one exited non-zero) gets up to `integration.repair_attempts` repair attempts (default 2, range 0 to 5; 0 turns it off). A check that could not run, a one-task plan and a run with repair off are not repaired.
- A repair worker runs in a worktree off the integration HEAD and may not loosen the check: an attempt that changes nothing, deletes or renames away a test file, adds a skip marker, or touches `.substrate/` is rejected and counts as a failed attempt. The worker may end with `CHECK-UNFIXABLE: <reason>` when only a change outside the code can fix the check; that stops the attempts at once.
- A passing repair is merged into the integration branch, the run branch advances to it, and the check runs again on the merged result. A repair that is merged and then fails the re-run stays on the run branch, as a merged task's work does.
- The repair never pauses the run for an answer. The run's budget, its time limit and `substrate stop` apply to the repair worker as to any worker.
- Exhausted repairs fail the run as a failed check did before, with the repair outcomes listed. The culprit search runs only then.

Code and tests: `src/engine/actions/repair.ts`, `src/engine/repair-guard.ts`, `assets/prompts/worker/repair.md`, `src/engine/actions/integrate.ts`, `test/e2e/integration-repair.test.ts`, `test/unit/engine/repair-guard.test.ts`; known issues 73 to 76.

## Note 2026-10-22 (R14): a web UI served by an always-on local service

The owner asked on 2026-10-22 for a browser UI for Substrate. This note supersedes the "Out of scope: A TUI" line for one thing only: a browser UI served by `substrate ui`. There is still no terminal UI, and bare `substrate` still prints help.

The rule now:
- The UI is a user-level daemon, run by `substrate ui serve` (foreground, for systemd) or `ui start`. It shows the jobs of every project registered on the machine (`$XDG_STATE_HOME/substrate/projects.json`), not only the current directory.
- It binds to the loopback interface only, reached as `localhost`. The port is chosen on the first start and stored in the user-level config file `ui.json` next to `settings.json`. A port, an IP address or a LAN address is never written into a committed file, a spec or a prompt (rule 8).
- Chat with the planner, and the amendments it may write, follow the semantics in `docs/design/web-ui.md` section 7. Tasks already running or passed are never changed by chat. A live run applies an amendment through the engine inbox; a stopped run applies it on resume through the normal plan re-ingest path. The engine validates an amendment with plan lint, blockers only.
- Security stays out of scope (A6). The UI adds no authentication, TLS or remote access. The contract in `docs/design/web-ui.md` section 5 is binding for the server and client work packages.

Amended 2026-10-22 (owner): the bind address is configurable through the `host` key of `ui.json` or the `--host` flag, and defaults to `localhost`. When the UI is bound to any other address, the POST Host-header guard is skipped and the `X-Substrate-UI` header guard stays; the owner accepted the resulting exposure, since the service has no authentication (A6).

Design and API contract: `docs/design/web-ui.md`.

## Note 2026-10-22 (R13.1): environment trouble is a warning or a retry, never a failed run

The owner's run `r_OVMJVL27O53V` failed for two environment reasons: a plan's `setup` (`cd ui && npm install`) ran in task worktrees where `ui/` did not exist and turned into `worker_crashed` with no worker ever running, and the L2 replan passed its whole prompt as a command-line argument and died with `E2BIG`, which ended the run as `internal_error`. The rule now, in four parts:
- **Setup failure is a warning.** A plan's `setup` that fails in a task worktree emits `task.setup.failed` (a warning, shown in progress). The worker still runs, and its prompt carries the failed command and the last ~1 KB of its output (`assets/prompts/worker/setup-failed.md`) so it can repair its own environment. A setup failure never fails the task and never counts a heal or replan. The integration worktree and `merge --partial` already treat a failed setup as a check that could not run (R12.2), a warning; they are unchanged.
- **Prompts go over stdin.** The claude adapter writes the prompt to the child's stdin instead of passing it as an argument, so a long prompt cannot exceed the argument size limit. opencode and agy still pass the prompt as an argument; they are not changed here, and the same argument-size hazard remains there (not yet checked against their documented CLIs).
- **An unstartable spawn retries twice.** A harness process that cannot start at all (E2BIG, ENOENT, EAGAIN, before any output) is retried inside the same attempt after 2 seconds and then 5 seconds, through one helper (`src/backends/spawn.ts`) that the worker, planner and replan spawns all call. A start that still fails fails the attempt with the spawn error in plain words. Retries never touch the heal or replan counters.
- **A crashed replan gives up one task.** A replan whose planner session cannot start is not an `internal_error`: the task takes the `giveUp` path (`task.failed`, `can_replan: false`, with the spawn error as the detail), its dependents are skipped, independent tasks continue, and the run ends `failed` with a readable reason.

Code and tests: `src/backends/process.ts`, `src/backends/spawn.ts`, `src/backends/adapters/claude.ts`, `src/roles/worker.ts`, `src/engine/replan.ts`, `src/git/setup.ts`; `test/e2e/environment-trouble.test.ts`, `test/integration/engine/replan.test.ts`, `test/unit/backends/claude-stdin.test.ts`.

## Note 2026-10-23: gates fail soft; the plan and the state agree; one task's failure stays with that task

The owner's instruction (2026-10-23): Substrate's own checks kept stopping good work. The rule now, in four parts:
- **Placeholder text is a warning at spec load (a).** The spec parser (`src/spec/parser.ts`) no longer throws for TODO, FIXME, TBD, `...` or `<placeholder>` in Interface or Behavior. Rule L013 reports the finding as a warning, through the one detector `findPlaceholders` (`src/spec/placeholders.ts`). An ellipsis counts only as the whole content of a line or bullet, or as `etc...`; a bare `...` in a sentence and call shorthand in backticks are not placeholders. Real markers stay TODO, FIXME and TBD as uppercase whole words.
- **The manifest and the live state agree (b).** A replan (L1 or L2) and an amendment rewrite the manifest; the engine then emits `plan.synced` (`src/engine/plan-sync.ts`, `src/contracts/events.ts`), which registers every manifest task the state lacks, updates the dependencies and write sets of tasks that have not started, and abandons pending tasks the manifest no longer names. The loop also reconciles whenever the manifest text changes, so a resume or a crash after the rewrite is repaired. A task that has started is never changed. A dependency that names no task of the plan is dropped and reported, never silently kept. Rule L004 is a warning for that reason (it was a blocker in the R12.3 list above, which this note supersedes for that one line). A task starts only after all its dependencies are merged.
- **A check or a rule that cannot pass the plan is a warning (c).** A missing required heading in an L1 or L2 spec is the REPLAN warning, as L014 is in the planner; the contract typecheck does not refuse an L2 or amendment (R12.3 already makes it a warning). An L1 or L2 that a warning would have refused now goes through. The routing of a failure that belongs to another task's scope was open here; it is resolved by the note of 2026-10-23 (item 88) below.
- **One task's failure stays with that task (d).** An exception inside one task's worker, heal or replan action is recorded as that task's `task.failed` (`can_replan: false`, the error text in `detail`, `src/engine/effects.ts` `taskExceptionData`): the task is BLOCKED, its dependents are skipped, and the other tasks keep running. Only an exception outside any single task stays a run-level internal error. A run that ends with some tasks merged and others failed or skipped has summary status `partial`. Its exit code stays 1 and its internal state stays FAILED, so `resume` still retries only the blocked and skipped tasks (R10.4), and `merge --partial` still lands the merged ones. The owner should confirm that exit 1 with status `partial` is the intended caller contract.

Superseded wording, for the record: R8.1 said "the run ends failed (exit 1)" for a run that lost a task. It now ends with status `partial` when some tasks merged, and `failed` otherwise; the exit code is unchanged.

Code and tests: `src/spec/parser.ts`, `src/spec/placeholders.ts`, `src/spec/rules.ts` (L004, L013), `src/engine/plan-sync.ts`, `src/engine/reducer.ts` (`plan.synced`, `run.amended`), `src/engine/replan.ts`, `src/engine/amendment.ts`, `src/engine/effects.ts`, `src/engine/engine.ts`; `test/unit/spec/placeholders.test.ts`, `test/unit/spec/parser.test.ts`, `test/unit/engine/plan-sync.test.ts`, `test/unit/engine/events.test.ts`, `test/unit/spec/lint-severity.test.ts`.

## Note 2026-10-23 (owner: caps/approval/turn limits removed)

The owner decided on 2026-10-23: Substrate is only asked to do work that is already approved, and its own limits and gates kept stopping good work. This note supersedes the spend, time, approval and turn rules above. Changes made to the statements above, each marked in place:
- **Spend, token and time caps are removed.** The settings keys `budgets.run.*` (`max_usd`, `max_tokens`, `max_wall_min`), `budgets.task.*` (`max_usd`, `max_tokens`, `timeout_min`, `max_turns`) and the env var `SUBSTRATE_MAX_BUDGET_USD` are removed. `--max-budget-usd` and `--timeout` are accepted and ignored with a warning, and the request's `budget` object is accepted and ignored. A settings file that still has the removed keys loads; they are dropped at load (`src/config/index.ts`, `dropRemovedKeys`). No cap reaches a harness: `--max-budget-usd` is not passed to claude, no worker, planner or repair session has a timeout, and no run pauses for its cost or time. Cost is still reported (status, watch, summary, usage).
- **Turn limits are removed.** No turn limit is passed to a harness and none is enforced by the engine. The spec's `budget.max_turns` stays an advisory field.
- **Approval is removed.** The estimate never pauses a run; lint rule L022 and the approval threshold are removed; the `default` permission mode no longer pauses for approval. A plan that passes lint goes to setup. `plan.lint` reports the advisory estimate as `estimated_usd`. A run that a log wrote as paused for approval resumes as approved.
- **Retry counts stay.** `budgets.l1_replans_per_task`, `budgets.l2_per_run` and `budgets.planner_format_retries` are the retry ladder's counts. The owner did not say whether they are turn limits; they are kept (open question, see `docs/known-issues.md`).
- **`substrate config unset <key> [--local]`** removes a key from the project or local settings file, so the key takes its default again.
- **Time limit and exit 4.** The wall-clock limit and the budget stop are removed; exit 4 is not produced by new runs.
- Rules L016, L022 and L025 are removed; their tests are removed.

Code and tests: `src/config/index.ts`, `src/contracts/index.ts`, `src/engine/effects.ts`, `src/engine/engine.ts`, `src/engine/actions/*.ts`, `src/roles/worker.ts`, `src/roles/planner.ts`, `src/backends/*`, `src/cli/commands/config.ts`, `src/cli/commands/run.ts`; `test/unit/config/config-command.test.ts` (unset cases), `test/unit/config/unset.test.ts`.

## Note 2026-10-23 (owner: no-output idle watchdog replaces the removed timeout)

The owner runs Substrate 24/7, and a harness process that hangs with no output would now wait forever, because the wall-clock timeout went with the other limits. The rule now:
- **The idle watchdog is a hang detector, not a limit.** A harness session (worker, planner, planner chat, repair or replan) that writes no stdout or stderr for `watchdog.idle_minutes` is killed with kill reason `timeout`. The default is 30 minutes; `0` turns it off; fractional minutes are allowed; `substrate config unset watchdog.idle_minutes` returns it to 30.
- **It is classified like any task failure.** The task fails with failure class `timeout` and the message `no output for <N> min`, and the normal retry and heal ladder applies. A killed planner session fails its planning attempt with the same message. It is never a run-level crash.
- **Slow but active sessions are never killed.** Any chunk on either stream counts as output. There is no total-time cap; the wall-clock timeout is not reintroduced.
- Code: `spawnSupervisedProcess` (`src/backends/process.ts`, `idleTimeoutMs`), each adapter's spawn, `createAdapters` (`src/backends/registry.ts`), `idleMinutesOf` and `IDLE_MINUTES_DEFAULT` (`src/contracts/index.ts`), and the message in `src/roles/worker.ts` and `src/roles/planner.ts`. Reference: `docs/reference/config.md`, `### watchdog`. Known issue 93.

## Note 2026-10-23 (owner, item 88): a failure in another task's files goes to the task that owns them

A replan of one task cannot change another task, so a check that fails on files another task owns used to escalate to L2 and dead-end the task. The engine now routes it. The rules:
- **Ownership** is the manifest's per-task `write` and `create` sets (from each task spec). The failing output (the failing check command, its stdout and stderr tails) names the owned paths as whole tokens; a directory entry matches its prefix.
- **Routing is taken only when** the output names exactly one other task's files and none of the failed task's own files. Otherwise the ladder runs as before. That covers: no owner named; two owners; the owner is BLOCKED, ABANDONED or FAILED; the owner depends on the failed task (a cycle); the failed task already took 2 routings (`MAX_OWNER_ROUTINGS_PER_TASK`, counted from the `plan.synced` events that carry `owner_route`).
- **`defer`** (the owner has not merged): the failed task gains a dependency on the owner. It is held in PENDING and released when the owner has merged.
- **`fix`** (the owner has merged): a new task `<owner>-FIX<n>` is added to the manifest. It owns exactly the failing files, depends on the owner, and runs the failing check commands. Its spec body is `assets/prompts/planner/owner-fix-spec.md`. The failed task gains a dependency on the fix task and is held in PENDING until the fix has merged.
- The routed plan is linted like any replanned plan. If it does not lint, the files are put back and the ladder runs.
- Both routes emit `plan.synced` with an `owner_route` field (`kind`, `owner`, `files`, and `fix_task` for a fix), so the log shows the routing.

Code and tests: `src/engine/owner-routing.ts`, `src/engine/replan.ts` (`routeToOwner`), `src/engine/actions/replan.ts` (`recordedOwnerRoutings`), `src/contracts/events.ts` (`PlanSyncedEvent.owner_route`); `test/unit/engine/owner-routing.test.ts`, `test/e2e/owner-routing.test.ts`.
