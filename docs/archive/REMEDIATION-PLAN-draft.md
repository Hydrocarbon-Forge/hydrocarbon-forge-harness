# Substrate remediation plan (R-series)

Status: DRAFT for approval · Date: 2026-10-17 · Authority: SUBSTRATE-PLAN.md (v2) stays authoritative; this document only adds work packages (WPs) that make the shipped code do what v2 says.

## 0. Why this exists

An audit of `main` at `82c0f44` (all 24 WPs MERGED, 870/870 tests green) found that the engine passes its tests by faking work, and that a large part of the real implementation is never called. A green suite does not mean a working harness. Four patterns account for almost everything:

1. **Fakes in the production path.** `FakeAdapter` is the engine default (`src/engine/engine.ts:92,231`); the CLI never passes a real adapter. `effects.ts` writes fake worker edits (`:969-993`), a hardcoded heal prompt (`:815`), and keys behaviour off test strings like `"First attempt done"` (`:1045`).
2. **Dead real modules.** `runWorker`, `runPlanner`, `executeReplan`, `scheduleNextTasks`, `EventStoreImpl`, `appendRouteOutcome`, `aggregateLedger`, `generateRepoMap`, `detectEcosystem`, governor tool execution and semantic lint are tested but have no non-test caller. `effects.ts` runs a cut-down inline copy instead.
3. **Producer/consumer mismatches.** The engine emits `task.passed`, `usage.recorded`, `batch.merged{batch}`; the CLI reads `task.verified`, `usage`, `batch.merged{checkpoint_ref}`. CLI tests seed the names the CLI expects, so they pass.
4. **Documented but absent.** `SUBSTRATE_*` env layer, `bench`/`agents-import` commands, `assets/agents` loading, real pricing, instruction-file discovery, most flags in `docs/reference/cli.md`, and ~10 settings keys with no reader.

Goal restated from v2 §1/§4: **`substrate "<idea>"`, with or without `--model`, starts at the local-model governor (when configured), is planned by a frontier harness, executed by routed workers in isolated worktrees, verified by code, merged only when it passes, and delivered to the user's branch through a gate.** All three harnesses (Claude Code, OpenCode, agy) must actually be driven.

## 1. Scope

### In scope
Everything needed for v0.1's definition in v2 §16 ("the full engine, all three adapters, the governor front door, headless `substrate -p`, fake-harness suites, live smoke on every installed harness") to be *true*, plus the honest docs for it.

### Explicitly out of scope (per owner, 2026-10-17)
- **Security hardening.** Substrate wraps three harnesses that own their sandboxing and permission models. Dropped: P6.2 follow-ups (`P6.4.x`, SEC-001..010), bubblewrap/network-deny for workers, env scrubbing, credential-file permissions.
- Consequences to record in `build/state/decisions.md`: G5's "P6.2 findings resolved or explicitly accepted" is satisfied by *explicit acceptance*; `sandbox.enabled` default becomes `false` (verify-runner bwrap stays as an opt-in, no longer fails open silently when enabled: it errors).
- **Kept because it is correctness, not security:** workers must not `git commit/push/checkout/reset/rebase/clean` and must not spawn subagents (the engine owns commits, plan I2/A7). The scope check and protected-file hash check also stay: they are how the engine decides pass/fail.

### Deferred (v0.2 per v2 §16, not part of this plan)
TUI render entry point and slash-command dispatch (P5.3), hooks (P5.2), commands/skills semantics, benchmark execution. Bare `substrate` with no prompt prints help and says the TUI is not available yet. Hooks and the TUI internals were not audited in depth: audit before scheduling them.

## 2. Decisions this plan makes (override any of them)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Governor role | Stay with v2: intake front door only (mode, class, planner route, clarifying questions, and the 7 typed tools executed by the engine). It never plans or implements. v1's "local model picks planner_model / validates plans" is **not** restored. | v2 Appendix E reversed it deliberately. Governor semantic lint (S001–S004) is wired as advisory. |
| D2 | "Idea → everything" entry | `substrate "<prompt>"` and `substrate run "<prompt>"` and `-p`. Any non-command first word (including a single word) is a prompt. | Plan §4.2; audit L2. |
| D3 | `--model` / no model | `--model` = planner model in `plan`, worker model in `solo` (as §4.1). No `--model` → routing table. `substrate init` builds routing from harnesses `doctor` detects and the owner's model map (claude main sonnet-5-5 / fast haiku-5-5; agy gemini-3.8-flash; opencode models from `opencode models`). | §4.1, App B line 613; decisions.md lines 7–8. |
| D4 | Worker network | Do not deny network (resolves the §10 contradiction with `claude -p`). | Security waived. |
| D5 | Budget vs replan | Run budget exhausted → `PAUSED(budget_exhausted)`, exit 4. Task timeout / per-task budget → L1. | Resolves §5 L1 vs §4.6/P4.3. |
| D6 | `substrate plan` | Always stops after plan + lint + estimate, regardless of cost. | §4.2 `plan ≡ --permission-mode plan`; P4.3 B2 falls through today. |
| D7 | Worktree layout | `.substrate/worktrees/<run_id>/<task_id>-g<n>/`; task branch `substrate/tasks/<run_id>/<task_id>-g<n>`. | Fixes cross-run collision (audit M18); amend §7 to match §8. |
| D8 | Escalation chain | `routing.escalation` is a list of **model ids** (as App B), engine resolves backend via the routing table. | Audit/review-P4 contract drift. |
| D9 | stream-json | Appendix D event names are canonical; the §4.6 list is replaced by a documented mapping table generated from the event catalog. | One source of truth (R1.2). |
| D10 | `bypassPermissions` merge | Auto-merge into the user's branch only if `git.auto_merge: true`; otherwise leave the run branch. | Reconciles §4.4 with A8. |
| D11 | Governor down | Rules-first router, then default `plan`. | §6.3 rule order; scenario 15. |
| D12 | Solo verify command | Add repeatable `--verify "<cmd>"`; else detected ecosystem default; else warn and run scope + budget only. Solo uses a worktree and commits to a task branch under the run branch. | Plan is silent; this satisfies I2/I4/§8. |
| D13 | Release tag for new WPs | `v0.3` (≤ current `release_target`, so no user-gated raise). | `state.mjs` `relLte`. |
| D14 | `bin` strategy | `bin/substrate.mjs` loads `dist/substrate.mjs` (built on `prepare`), not TS source. | No TS loader in deps. |
| D15 | Local endpoint | Never in committed files. `settings.local.json` only; WP specs and spawn prompts say "the governor endpoint from settings.local.json" and never contain the raw IP:port. | S2 spike; decisions.md line 30 (raw IP in spawn prompt broke the harness). |

## 3. How we stop this recurring (R0 builds these first)

The original gates were satisfiable by scaffolds. R0 adds gates that are not:

1. **Wiring tripwire** (`npm run check:wired`): every `src/**` module must be reachable from `src/cli/dispatcher.ts` or `src/index.ts`. Exceptions live in `scripts/wired-allowlist.json`, each entry tagged with the WP that removes it. The allowlist must be empty at R5.3.
2. **Producer/consumer check**: every emitted event type must be in the catalog and have a consumer (reducer, CLI or documented sink); every consumed type must have an emitter.
3. **Settings reader check**: every leaf key of the `Settings` schema has a reader in `src/**` or an allowlist entry tagged with its WP.
4. **No test code in `src/`**: `src/** → test/**` imports fail the build; `FakeAdapter` moves under `test/`.
5. **No stdout noise**: `console.*` is banned in `src/engine|backends|roles|git|verify|spec` (use `src/util/log.ts`, stderr, off by default). CLI output goes through one writer.
6. **Black-box E2E**: tests run the **built CLI** with the **real adapters** against fake `claude`/`opencode`/`agy` binaries (R0.2) that really edit files, honour session ids, and emit usage. `FakeAdapter` remains only for adapter-conformance tests.
7. **Live gate** (`npm run gate:g5`): fails unless `doctor`-detected harnesses each have a recorded passing live run (R5.2). A skipped live test is a failure in gate mode.
8. **Reviewer checklist** (given to `substrate-reviewer` each phase): for each WP, name the CLI command that reaches the feature and the E2E test that proves it.

Every WP spec must list under *Guardrails*: "Not done if the feature is reachable only from tests" and carry `npm run check` in its verify list.

## 4. Work packages

Tier/Eff: H/S/O + lo/med/hi. Sz: S 40, M 100, L 200 turns. TF = tests-first. Write sets abridged; specs refine them. `effects.ts` is split in R0.3 so later WPs have disjoint write sets.

### Phase R0: guardrails and removal of fakes

| ID | Title | Rel | Sz | Tier/Eff | TF | Deps | Write set |
|---|---|---|---|---|---|---|---|
| R0.1 | Wiring, event, settings and test-import tripwires | v0.3 | M | S/hi | y | — | `scripts/check-*.mjs`, `scripts/wired-allowlist.json`, `package.json` scripts, `test/unit/scripts/**`, `src/util/log.ts` |
| R0.2 | Fake `claude`/`opencode`/`agy` binaries and black-box E2E driver | v0.3 | L | S/hi | n | — | `test/fixtures/fake-harness/**`, `test/e2e/helpers/**`, `test/e2e/smoke.test.ts` (xfail until R2.1) |
| R0.3 | Split `effects.ts` into per-action modules (no behaviour change) | v0.3 | M | S/hi | n | R0.1 | `src/engine/effects.ts`, `src/engine/actions/**` |
| R0.4 | Remove fabricated edits, test hooks, destructive sweep, debug logging | v0.3 | M | S/hi | y | R0.2, R0.3 | `src/engine/actions/**`, `test/integration/scenarios/**`, `test/integration/engine/**` |

- **R0.1.** Implements §3 items 1–5. Starts red with a full allowlist generated from the audit; each later WP must delete its entries. Done when `npm run check` runs in CI/pretest and fails on a seeded violation (tested).
- **R0.2.** Extend the existing fake harness (P3.1/P3.3/P3.4 already describe claude/opencode/agy dialects; verify and fill gaps) so a scenario file drives: file edits in `cwd`, `DONE`/`BLOCKED` replies, verify-fail-then-fix, crash, hang, rate limit, permission denial, budget overshoot, session resume by id, usage events, plus planner replies that write a real `manifest.yaml`/specs. Provide `runSubstrate({repo, scenario, args, env})` that builds the CLI once, creates a throwaway git repo, points `backends.<n>.bin` at the fake, and returns exit code, stdout/stderr and the run directory. Done when a plain `run` E2E exists, is marked xfail with a reason, and a conformance test proves each dialect parses with the real normalizers.
- **R0.3.** Behaviour-preserving. Gate: all existing tests pass unchanged **and** `events.jsonl` for the 15 scenarios is identical (timestamps normalised) before and after.
- **R0.4.** Delete: fabricated file writes, `isForcedVerifyFail`/`isL2Scenario`, the `rmSync` untracked-file sweep (merge refuses with a clear error if the user's checkout has conflicting tracked changes until R3.5 moves merging to an integration worktree), every `[DEBUG]` log. Rework scenarios to use fake-harness edit scenarios. Done when no scenario depends on engine-written content.

> Until R0.4 lands, do not run `substrate run`/`merge` against a repository you care about: the merge step deletes untracked files.

### Phase R1: the CLI starts and tells the truth

| ID | Title | Rel | Sz | Tier/Eff | TF | Deps | Write set |
|---|---|---|---|---|---|---|---|
| R1.1 | Entry point, build, packaging, signals | v0.3 | M | S/med | n | R0.1 | `bin/substrate.mjs`, `package.json`, `scripts/bundle.mjs`, `src/index.ts`, `src/cli/signals.ts`, `test/e2e/entry.test.ts` |
| R1.2 | Event catalog and honest status/tasks/cost/report/summary | v0.3 | L | S/hi | y | R0.3, R0.4 | `src/contracts/events.ts`, `src/engine/emit.ts`, `src/engine/reducer.ts`, `src/ledger/**`, `src/cli/{output,format}.ts`, `src/cli/commands/{status,tasks,cost,report}.ts`, `src/cli/commands/run.ts` (output only), tests |
| R1.3 | Flags, config layering, env layer, dispatch rules, init/doctor | v0.3 | L | S/hi | y | R1.1 | `src/cli/dispatcher.ts`, `src/cli/commands/{run,plan,resume,verify,config,init,doctor,agents,models,sessions}.ts`, `src/config/**`, `src/contracts/index.ts` (settings), `src/cli/{bench,agents-import}.ts` registration, tests |

- **R1.1.** `bin` runs the built bundle; `prepare` builds; `files` includes `dist/` and `assets/`; remove "(scaffold)" identity and the `SUBSTRATE_SCAFFOLD` smoke test; real `main`/`exports`. SIGINT/SIGTERM actually cancel: the engine receives the abort signal, the process group is killed, the run lock released, `run.finished`/`PAUSED` recorded, exit 130/143. Done when an E2E test spawns the bin, sends SIGINT mid-run, and `resume` continues.
- **R1.2.** Typed event catalog (Appendix D + `plan.ready`) used by `emit`, reducer and CLI; stream-json mapping table generated from it (D9). Fixes: passed/merged counts, `tasks` states, per-task live progress lines, `cost` from `usage.recorded` and the ledger (`usage.jsonl` appended by the engine; `aggregateLedger` wired), single-source budget totals (remove the state mutation that double counts), schema-validated `appendRunEvent`, clean stdout for `json`/`stream-json`. CLI tests must be rewritten to consume **engine-produced** logs (recorded from E2E runs), never hand-seeded event names.
- **R1.3.** Fixes: `--model`/`--worker-model` (add an optional `roles.worker` route or route override to the schema: today they exit 2); `--timeout` seconds (convert to `max_wall_min`); deep-merge CLI overrides into settings; `resume --session-id`, `run --resume/--continue/--fork-session` actually select/continue; `verify <task>` per §4.2 (arg order, no silent fallback); `--allowed-tools` comma/variadic; `-w/--worktree` implemented or removed from help; `SUBSTRATE_*` env layer per `config.md`; `config get/list` show merged config, `set` validates; register `bench` and `agents-import`; D2 dispatch rule; `init` (`--force`, `settings.local.json`, harness detection, real default pricing from `docs/spikes/S4-pricing.json`, routing per D3); `doctor` (git ≥ 2.30, version-pin drift, governor health); `agents` loads built-in `assets/agents` via a package-relative `builtinsDir`; `models` dumps pricing; documented-but-unparsed flags either implemented or deleted from docs (decided per flag in the spec). Settings keys with no reader get a reader in their owning WP or are removed.

### Phase R2: real backends

| ID | Title | Rel | Sz | Tier/Eff | TF | Deps | Write set |
|---|---|---|---|---|---|---|---|
| R2.1 | Adapter registry, backend selection, pricing | v0.3 | L | S/hi | y | R0.2, R1.2, R1.3 | `src/backends/registry.ts`, `src/backends/pricing.ts`, `src/engine/engine.ts`, `src/cli/commands/{run,plan,resume,backends}.ts` (adapter wiring), `test/conformance/fake-adapter.ts` (moved), tests |
| R2.2 | Adapter correctness against the real harness protocols | v0.3 | L | S/hi | y | R2.1 | `src/backends/adapters/*.ts`, `src/backends/normalize/*.ts`, `src/backends/process.ts`, fixtures, tests |

- **R2.1.** `EngineImpl` takes an adapter *registry*; `FakeAdapter` import and `"fake"` in user-visible lists removed from `src/`. Per-route `backend` chooses the adapter; `backends.<name>.bin`, `version_pin`, `max_concurrency` are read. Pricing: ship `S4` numbers as the default table, `models` shows it, `computeUsageRecord` used for opencode/agy, unlisted-model policy is "warn + cost `unknown`, budget on tokens" (never throw, never report $0 silently). First E2E (`run` against fake claude) goes green here.
- **R2.2.** Session ids are real UUIDs mapped from `task/generation/attempt`; raw stream goes to `runs/<id>/raw/` (outside the worktree; fixes the scope violation on every run); `system_append` implemented per harness (claude flag, opencode agent file, agy equivalent from S3); allow/deny tool syntax translated per harness (Claude rule syntax such as `Bash(git commit*)`); typed `error` events (`rate_limit`, `auth`, `crash`) instead of string matching; `DONE`/`BLOCKED` parse. Each adapter replays its recorded fixtures **and** is exercised through the fake binary E2E. A live check (R5.2) confirms flags against installed versions (pins: claude 2.1.301, opencode 2.0.21, agy 1.4.0).

### Phase R3: the engine runs on the real modules

| ID | Title | Rel | Sz | Tier/Eff | TF | Deps | Write set |
|---|---|---|---|---|---|---|---|
| R3.1 | Planner on `runPlanner`, approval flow, instruction files | v0.3 | L | S/hi | y | R2.1 | `src/engine/actions/{plan,approve}.ts`, `src/roles/planner.ts`, `src/roles/prompts/planner.ts`, `src/spec/**` (repo map, instruction discovery), tests |
| R3.2 | Scheduler, DAG readiness, terminal states, resume | v0.3 | L | S/hi | y | R3.1 | `src/engine/{scheduler,reducer}.ts`, `src/engine/actions/{setup,schedule}.ts`, `src/engine/engine.ts`, `src/store/**`, tests |
| R3.3 | Worker pipeline: setup, spawn, scope, verify, heal, commit | v0.3 | L | S/hi | y | R3.2, R2.2 | `src/engine/actions/task.ts`, `src/roles/worker.ts`, `src/git/workspace.ts`, `src/verify/**`, tests |
| R3.4 | Escalation L1/L2/L3, failure packets, budgets | v0.3 | L | S/hi | y | R3.3 | `src/engine/actions/replan.ts`, `src/engine/{replan,packet,ladder}.ts`, tests |
| R3.5 | Integration worktree, merge, bisect, checkpoints, undo, discard | v0.3 | L | S/hi | y | R3.3 | `src/engine/actions/{merge,integrate}.ts`, `src/git/{merger,workspace}.ts`, `src/cli/commands/{merge,undo,discard}.ts`, tests |
| R3.6 | Solo mode | v0.3 | M | S/hi | y | R3.3 | `src/engine/actions/solo.ts`, tests |

- **R3.1.** The plan action calls `runPlanner` (system prompt from the `planner` definition, output contract, repo map, `CLAUDE.md`/`AGENTS.md`/`SUBSTRATE.md` discovery per `instructions.workers`, corrective retries up to `planner_format_retries`). Manifest accepted from the run directory **or** fenced output, then schema-validated (delete the unvalidated `safeParseManifest` fallback). Contract stubs are typechecked **before** being committed; the stub commit uses an expected-old-value ref update. Approval: `plan.approved` is emitted by `resume`/`--permission-mode`/interactive prompt so a gated run can proceed; `AWAITING_APPROVAL` is reachable. D6 enforced.
- **R3.2.** Dependents become READY as their dependencies PASS/MERGE; write-set overlap serialisation; `concurrency.workers` honoured. The run's terminal state is *derived*, never defaulted to "finished": a run with unfinished tasks, pauses or blocked tasks returns the right exit code (1/3/4). Resume reconstructs RUNNING/SCOPE_CHECK/VERIFYING tasks (resume the session or re-ready) at every event boundary, as scenario 11 requires. Reducer gains cases for `integration.failed`, `tasks.invalidated`, pause reasons.
- **R3.3.** Replace the inline worker action with `runWorker`: worktree per task generation (D7), `manifest.setup` failures **fail the task visibly**, spawn with the routed `{backend, model, effort}` (backend honoured), changed paths computed from git, scope revert/fail, protected-hash check, real verify, L0 heal that resumes the same session with **real** capped failure tails and **keeps** the worktree, pathspec commit whose failure fails the task, per-task `max_usd/max_tokens/max_turns/timeout` enforced from usage events, rate-limit backoff (exponential, concurrency halved, floor 1, then `PAUSED(rate_limited)`).
- **R3.4.** L1 uses `executeReplan`: the planner's revised spec is parsed, written, re-linted, and the next generation runs it in a fresh worktree on the next ladder tier; L2 amends contracts/manifest, invalidates **only** dependents, re-lints; L3 pauses with exit 3. `FailurePacket` fully populated (attempts, diff, verify output, scope violations, worker summary, related contracts, dependents). Run budget enforcement per D5, 80% warning event.
- **R3.5.** Merge happens in an integration worktree, never in the user's checkout and never deleting user files. Per batch: merge-tree preflight, merge, `integration_verify`, bisect to a culprit `FailurePacket(integration_failed)`, bounded loop. Checkpoint recorded in `batch.merged` and the reducer. CLI: `merge <run>` refuses non-successful runs, uses `src/git/merger.ts`, supports `--dry-run`/`--abort-on-conflict`; `undo` reverts to the previous checkpoint on the run branch (with `--hard`), errors if none; `discard` removes worktrees (`git worktree remove`/prune), task + run branches, and records cancellation, with `--force` killing live harness processes. D10 applied.
- **R3.6.** One worker in a worktree, no planner/manifest; scope check, verify per D12, engine commit to a task branch, L0 heal applies, budgets apply, same events as plan mode. Scenario 16 passes through the CLI.

### Phase R4: governor front door (the local-model entry)

| ID | Title | Rel | Sz | Tier/Eff | TF | Deps | Write set |
|---|---|---|---|---|---|---|---|
| R4.1 | Governor configuration, health, init/doctor integration | v0.3 | S | S/med | y | R1.3 | `src/config/**`, `src/roles/governor.ts` (health only), `src/cli/commands/{init,doctor,config}.ts`, tests |
| R4.2 | Governor loop: clarification, tool execution, semantic lint | v0.3 | L | S/hi | y | R4.1, R3.1, R3.6 | `src/roles/{governor,governor-tools,router}.ts`, `src/engine/actions/route.ts`, `src/cli/prompt.ts`, tests |
| R4.3 | Routing table, per-class routes, local-model worker route | v0.3 | M | S/hi | y | R4.2, R2.1 | `src/config/**` (routing defaults), `src/roles/router.ts`, `src/engine/{ladder}.ts`, `src/backends/adapters/opencode.ts` (provider config), docs recipe, tests |

- **R4.1.** `roles.governor` in the settings schema with documented defaults (disabled until an endpoint exists). `substrate config set roles.governor.endpoint <url>` writes to `settings.local.json` (never the committed file). `doctor` reports governor health (`/health`, fallback `/v1/models`). Secrets/addresses never land in committed paths.
- **R4.2.** Governor receives the request + repo summary; supports up to `max_clarifying_turns` of `ask_user` (interactive prompt on a TTY; in headless mode `ask_user` follows a documented policy: proceed with the governor's best `RoutingDecision` and log the unanswered question). The engine **executes** `start_run`, `plan_only`, `resume_run`, `run_status`, `show_cost`, `cancel_run` against `Engine`, validating arguments and refusing anything that changes caps or verdicts. Semantic lint S001–S004 run after deterministic lint, advisory. Every routing decision and outcome is appended to `routes.jsonl` (`appendRouteOutcome` wired). Unreachable governor never blocks (D11). `--no-governor` and `--mode` honoured end to end. Tested with an in-process mock OpenAI-compatible server, plus the live check in R5.2.
- **R4.3.** Ship the Appendix B class table as default routing (`search … review`, `escalation`), resolved per task class; `route.backend` selects the adapter; the deterministic single-file rule is reachable with the governor off. Document and test the local-model route: OpenCode custom provider (`@ai-sdk/openai-compatible`, base URL from `settings.local.json`) as an **opt-in** worker route for `mechanical|boilerplate`, concurrency capped by `backends.opencode.max_concurrency` (2). `init` writes the routing it can honestly support from detected harnesses (D3).

### Phase R5: truth, gates, release

| ID | Title | Rel | Sz | Tier/Eff | TF | Deps | Write set |
|---|---|---|---|---|---|---|---|
| R5.1 | Docs reconciliation and stronger docs-check | v0.3 | M | H/med | n | R1.3, R3.5, R4.3 | `README.md`, `docs/reference/**`, `scripts/docs-check.mjs`, SUBSTRATE-PLAN.md amendments (D4–D12, §7 layout) |
| R5.2 | Real live smoke and the G5 gate | v0.3 | M | S/hi | n | R2.2, R4.2, R3.5 | `test/live/**`, `scripts/gate-g5.mjs`, `package.json` scripts |
| R5.3 | Final wiring audit and E2E matrix | v0.3 | M | S/hi (reviewer) | n | all | `test/e2e/**`, `build/reports/review-R.md` |

- **R5.1.** README/cli.md/config.md/adapters.md describe only what exists (bare `substrate` → help, TUI v0.2). `docs-check` additionally verifies: every documented flag is parsed and read, every documented command is reachable from the dispatcher, every documented env var is read, every settings key in docs has a reader.
- **R5.2.** `npm run test:live` runs a real `plan`-mode **and** a full run on a toy repo ("add a function and its test") per installed harness within a cost cap, plus a governor round trip against the local endpoint when reachable. `npm run gate:g5` fails if any `doctor`-detected harness lacks a recorded pass or if a live test was skipped. Results recorded in `build/reports/live-smoke.json`.
- **R5.3.** Tripwire allowlist must be empty. E2E matrix, all through the built CLI + real adapters + fake binaries: the 16 §14 scenarios; governor-driven run (mock server); local-model worker route (fake opencode); SIGKILL mid-run then `resume`; `merge`/`undo`/`discard` on a temp repo; `--output-format json|stream-json` parse cleanly; each harness dialect. Reviewer signs the checklist in §3.8.

### Dependency summary

```
R0.1 ──┬─ R0.3 ─ R0.4 ─┐
R0.2 ──┘               ├─ R1.2 ─┐
R1.1 ─ R1.3 ───────────┘        ├─ R2.1 ─ R2.2 ─┐
                                │               ├─ R3.1 ─ R3.2 ─ R3.3 ─┬─ R3.4
                                │               │                      ├─ R3.5
                                │               │                      └─ R3.6
R1.3 ─ R4.1 ───────────────────────────────────────────── R4.2 ─ R4.3 ─ R5.x
```
Parallel pairs once their dependencies are met: R0.1‖R0.2, R1.1‖R0.3, R3.4‖R3.5‖R3.6 (disjoint write sets after R0.3), R4.1‖R3.x.

## 5. Coverage of audit findings

Core-runtime findings are `C-`, surface findings `S-`, as numbered in the two audit reports. WAIVED = security out of scope.

| WP | Findings addressed |
|---|---|
| R0.1 | C-H21, C-M11, S-M8 (guards) · L1/L5 test-import |
| R0.2 | S-M9 (fixtures), E2E foundation |
| R0.3 | enabler for all R3 |
| R0.4 | C-H1, C-H8 (deletion), C-H19, C-M7 |
| R1.1 | S-H1, C-M19, S-M5, S-L3 |
| R1.2 | S-H2, S-H3, S-H4, C-H7, C-H19, C-M15, S-M3 (status/tasks/cost/report) |
| R1.3 | C-H18, S-H7, S-H8, S-H9, S-H11, S-H12, S-H13 (loader), C-M10, C-M11, C-M13, S-M2, S-M3, S-M6, S-L1, S-L2, S-L7 |
| R2.1 | known FakeAdapter default, C-H20, S-M1, C-H22 (backend), S-L5 |
| R2.2 | C-H11, C-H12, C-M3, C-M4, C-M8 (typed errors) |
| R3.1 | C-H10, C-H15, C-M12, C-M16, C-M17 |
| R3.2 | C-H4, C-H5, C-M14 |
| R3.3 | C-H1 (real), C-H2, C-H3, C-H23, C-M2, C-M8, C-M9, C-M18 |
| R3.4 | C-H14, C-M5, C-M6, C-M9 |
| R3.5 | C-H6, C-H8, C-H16, C-H17, S-H5, S-H6, S-M4, C-M18 (discard) |
| R3.6 | C-H9 |
| R4.1 | known governor off-by-default / endpoint unconfigured |
| R4.2 | known governor tools/ask_user/semantic lint unwired, C-L2 |
| R4.3 | C-H22, plan §6.2 local worker route |
| R5.1 | S-M8, S-L8, doc claims (README lines 88–110, 158–162, 178, 199–236, 253–261) |
| R5.2 | S-H15, G5 live half |
| R5.3 | S-M9, C-H21 final |
| WAIVED | C-H13, S-H10, C-M1, S-H14, SEC-001..010 |
| Deferred | S-M7 (TUI slash no-ops), hooks, commands/skills (L6/L8), TUI render |

## 6. Running it through the build pipeline

The existing orchestrator can run these WPs, with caveats found in `build/state/decisions.md`:

- **Register without wiping state.** `state.mjs init-from-plan --force` rebuilds `state.json` and erases every status. Instead: append the R-series rows to SUBSTRATE-PLAN.md §16 (phase = ID prefix, e.g. `R0`; same column layout as the existing table, check the header before pasting), append the IDs to `state.json` `order`, and run `node build/tools/state.mjs set phase:R0 approved` for each phase. A small `state.mjs add` subcommand would be cleaner but ORCH §4 forbids editing tools without the owner's approval.
- **Use the Claude agents, not OpenCode.** `guard.mjs` is a Claude Code hook; under OpenCode it did not run and a worker edited `main` outside scope. Run R-series under Claude Code with `.claude/agents/substrate-*` (note: the worker files currently hardcode haiku/medium for S, M and L: align them with the WP Tier before use).
- **Run `scope.mjs --revert` before every merge**, restate the worktree rule in each spawn prompt, never remove a worktree before its WP merges (decisions.md lines 12–21).
- **Spawn prompts must not contain the raw LAN IP:port** (D15).
- **Serial first.** R0 → R1 → R2 → R3 are mostly serial because `effects.ts`/event contracts are shared; parallelise only the pairs listed above.
- **Review gate per phase** with the §3.8 checklist; phase R5 review is mandatory before declaring v0.1 real.
- The contradictions list in §2 should also be written into SUBSTRATE-PLAN.md (R5.1) so the plan and code agree.

## 7. Suggested order of work and first steps

1. Approve this plan (or tell me which decisions D1–D15 to change).
2. Do R0.1 and R0.2 directly in a Claude Code session (small, define every later gate; guard hooks are active there).
3. R0.3 → R0.4 immediately after, so the destructive merge sweep and fabricated edits are gone before anyone runs the CLI on a real repo.
4. Hand R1–R5 to the pipeline phase by phase, reviewing each phase gate yourself since the previous gates were satisfiable by scaffolds.

## 8. Risks and open items

- Everything above is derived from reading code; only a handful of probes were executed. H4–H9 in the core audit were *traced, not run*: R0.2's E2E tests will confirm or refute them before they are fixed.
- The real harness CLIs are barely exercised by the existing tests. R2.2/R5.2 will likely surface protocol surprises (UUID session ids, tool-rule syntax, `--bare`/auth, OpenCode v2 flags, agy soft denies).
- `claude -p` under subscription limits with 3 parallel workers is an open question in the plan (U13). The benchmark WP is deferred; limits will be learned from live runs.
- Plan contradictions #12/#13 (local endpoint in committed files; context size 128k vs 65536k): the plan docs already contain the address; remove it from committed docs in R5.1 and keep it in `settings.local.json`, and make the governor's repo-summary budget configurable.
- Hooks, the TUI internals, `store/sessions.ts`, and the OpenCode/agy adapter internals were not audited in depth.
