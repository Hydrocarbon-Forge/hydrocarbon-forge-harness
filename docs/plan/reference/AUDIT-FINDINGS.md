# Audit findings (reference only)

From an audit of `main` at `82c0f44` on 2026-10-17. Work packages cite these ids as "Audit refs". You do not need to read this file to do a WP; the spec has everything required. `C-*` = core runtime, `S-*` = CLI surface. WAIVED = out of scope (DECISIONS A6). DEFERRED = not part of this plan.

## Core runtime
| Id | Finding |
|---|---|
| C-H1 | Engine writes fake worker edits (`export const val_<task>_g<n> = 1;`) when the worker reports no changed files |
| C-H2 | L0 heal prompt is a hardcoded string, not the real verify output |
| C-H3 | Heal recreates the worktree (destroying attempt 1) then resumes the session as if intact |
| C-H4 | After a pause or crash with a task RUNNING, `resume` drops remaining work and exits 0 |
| C-H5 | Tasks with `depends_on` never become READY; run still reports success |
| C-H6 | Integration failure loops forever (no reducer case, unbounded loop) |
| C-H7 | Budget totals double count (state mutated in effects, then reduced again) |
| C-H8 | Merge step deletes untracked user files and switches branches in the user's checkout |
| C-H9 | Solo mode skips verify, scope check and commit, and reports success |
| C-H10 | Planner gets no output contract; manifest written to disk is ignored |
| C-H11 | `system_append` is never passed to any adapter |
| C-H12 | Worker permission rules are hardcoded, not enforced, and in the wrong syntax |
| C-H13 | Workers have no sandbox (WAIVED) |
| C-H14 | L1 replan discards the planner's reply; the spec is never rewritten |
| C-H15 | Approval gates can never be cleared |
| C-H16 | `merge` accepts failed runs |
| C-H17 | `undo` does not revert and prints success |
| C-H18 | `--model` / `--worker-model` set `roles.worker`, which the strict schema rejects (exit 2) |
| C-H19 | `console.log("[DEBUG]...")` on stdout corrupts json and stream-json output |
| C-H20 | Default pricing is a placeholder; nothing writes the usage ledger; `cost` is always $0 |
| C-H21 | Real modules never called: `runWorker`, `runPlanner`, `executeReplan`, `scheduleNextTasks`, `EventStoreImpl`, `appendRouteOutcome`, `aggregateLedger`, `generateRepoMap`, `detectEcosystem` |
| C-H22 | Routing: class table missing, `route.backend` ignored, deterministic rule unreachable |
| C-H23 | `manifest.setup` failures are swallowed |
| C-M1 | Verify sandbox fails open (WAIVED) |
| C-M2 | A failed task commit is swallowed and the task still counts as passed |
| C-M3 | Raw stream is written inside the worktree, causing a scope violation on every run |
| C-M4 | Session id is not a UUID but Claude requires one |
| C-M5 | L2 re-readies every task, skips re-lint, uses a hardcoded prompt |
| C-M6 | Failure packet is mostly empty |
| C-M7 | Test-only hooks in the production engine |
| C-M8 | Rate-limit handling: string matching, no backoff, mutates shared settings |
| C-M9 | Per-task and run budgets mostly unenforced; timeout never armed for 60 min or more |
| C-M10 | Several CLI flags accepted but have no effect |
| C-M11 | Settings keys with no reader |
| C-M12 | Instruction-file discovery (`CLAUDE.md`, `AGENTS.md`, `SUBSTRATE.md`) absent |
| C-M13 | CLI overrides clobber nested config (shallow spread) |
| C-M14 | No write-set overlap serialisation between parallel tasks |
| C-M15 | Event log not schema-validated |
| C-M16 | `safeParseManifest` falls back to unvalidated YAML |
| C-M17 | Contract stubs are committed before typecheck; the ref update has no expected old value |
| C-M18 | Worktree names collide across runs; `discard` targets a path that is never created |
| C-M19 | Ctrl-C leaves detached workers running |
| C-L1 | `backends` command imports the test `FakeAdapter` |
| C-L2 | Lint diagnostics containing `run_id` are silently dropped |

## CLI surface
| Id | Finding |
|---|---|
| S-H1 | `bin/substrate.mjs` imports `dispatcher.js`, which does not exist: cannot start |
| S-H2 | Run summary and `status` show 0 passed on success |
| S-H3 | `tasks` never shows a passed task; no live progress |
| S-H4 | `cost` always $0.00 (wrong event name, ledger never written) |
| S-H5 | `undo` is a stub |
| S-H6 | `merge` accepts failed runs and bypasses `src/git/merger.ts` |
| S-H7 | `resume --session-id` ignored |
| S-H8 | `--timeout` is minutes, documented as seconds |
| S-H9 | `verify` argument order wrong; silently verifies another task |
| S-H10 | Sandbox covers verify only and fails open (WAIVED) |
| S-H11 | `SUBSTRATE_*` environment layer not implemented |
| S-H12 | `bench` and `agents-import` not registered |
| S-H13 | `assets/agents` read by nothing at runtime |
| S-H14 | P6.2 security findings unremediated (WAIVED) |
| S-H15 | Live smoke gate cannot run |
| S-M1 | Default pricing is a placeholder |
| S-M2 | Flags parsed but ignored |
| S-M3 | Documented flags and fields not implemented |
| S-M4 | `discard` incomplete |
| S-M5 | Ctrl-C does not cancel the engine |
| S-M6 | Settings keys with no consumer |
| S-M7 | TUI slash commands are no-ops (DEFERRED) |
| S-M8 | `docs:check` masks unwired commands |
| S-M9 | Tests overclaim; fixtures diverge from the engine |
| S-L1 | `config get/list` show the raw project file |
| S-L2 | Single-word prompts error out |
| S-L3 | Package identity still "scaffold" |
| S-L4 | `src/cli/index.ts` is an unimported duplicate |
| S-L5 | `backends` lists the test-only `fake` adapter |
| S-L6 | Built-in commands and skills resolve against `process.cwd()` |
| S-L7 | `--allowed-tools` comma form |
| S-L8 | Plan contradicts itself on TUI/hooks versions |
