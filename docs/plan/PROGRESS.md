# Progress

Update this file at the end of every work package: set the Status to DONE, write one line in Notes (what you ran to prove it), and commit it with the code. Statuses: TODO, DOING, DONE, BLOCKED. `scripts/check-*.mjs` read the Status column, so keep the table format exactly (five `|`-separated columns before Notes; do not put `|` inside a cell).

Current WP: **R1.1**. Take the first TODO row whose dependencies are all DONE.

| ID | Title | Size | Deps | Status | Notes |
|---|---|---|---|---|---|
| R0.1 | Tripwire scripts and npm run check | S | - | DONE | npm run check passed (purity, wired, events, settings, boundaries, docs: OK); allowlist entries: 18 purity, 19 wired, 21 events, 27 settings |
| R0.7 | Remove the inert TUI scaffold | S | R0.1 | DONE | tests: 898 passed -> 822 passed (76 TUI tests removed); npm run check, typecheck, check:boundaries, test exit 0 |
| R0.2 | Fake harness that edits files | M | R0.1 | DONE | vitest test/conformance test/integration/backends (91 passed); FAKE_SCENARIO_FILE=/nonexistent agy exit 3; typecheck, check, test all pass |
| R0.3 | E2E driver and smoke test | M | R0.2 | DONE | npx vitest run test/e2e passed (2 expected failures); failures on (a) expected 'one\n' to be 'one\ntwo\n', (b) expected 2 to be +0; bundle, typecheck, check, npm test exit 0 |
| R0.4 | Split effects.ts | M | R0.1 | DONE | SUBSTRATE_GOLDEN compare 18 passed; effects.ts 316 lines, max action 417 lines; 15 golden hashes matched; npm test, check, typecheck pass |
| R0.5 | Remove fabrications and test hacks | M | R0.2 R0.4 | DONE | 15 scenario tests reworked to fakeClaudeAdapter; 4 it.fails markers (07: R3.4 budget, 08: R3.4 timeout, 10: R3.6 bisect, 14: R3.5 l2 amendment); golden files removed; typecheck, check, test exit 0 |
| R0.6 | Dead-export analysis | M | R0.1 R0.7 | DONE | 103 dead symbols recorded (DEFERRED: 2, R2.8: 1, R2.9: 1, R3.1: 2, R3.2: 1, R3.3: 1, R3.5: 1, R3.8: 1, R5.3: 93); check:dead, check, typecheck, test/unit/scripts (31 passed) exit 0 |
| R1.1 | Entry point, build and signals | M | R0.3 | DONE | node bin/substrate.mjs --help exit 0; entry test (b): SIGINT exit 130, fake pid ESRCH, run.paused user_cancel, lock released; npm test 866 passed, typecheck, bundle, check exit 0. Deviations: events now stream at emit time (actions/shared.ts + effects.ts loop); once the event observer throws the run stops persisting (chaos boundary contract); smoke solo it.fails marker removed (main.ts bundle entry fixed dynamic imports, run is real); check-wired entries include src/cli/main.ts; signal plumbed into run/plan/resume.ts + bindAbort at spawn sites (per spec note); entry test (c) kept it.fails for R3.2 C-H4 |
| R1.2 | Event catalog and typed emit | M | R0.4 R0.5 R0.6 | DONE | 42 catalog members + legacy `scope.checked` (observe-only); npm run check:events exit 0, events allowlist 0; git greps for task.started/task.verified/usage in src/cli empty; events+reducer unit tests (112), integration (scenarios+engine) pass; typecheck, check, npm test exit 0. Deviations: member `run_id` validated as string (RunId regex rejects ids in protected fixtures, engine accepts them); legacy `scope.checked` kept as observe-only member + dual emit (protected scenario-04 asserts old name); cost.ts accepts legacy flat `usage` events via regex (protected CLI fixture); reducer consumes `integration.failed`, `tasks.invalidated`, `batch.merged` checkpoint_ref, `bisect.culprit`; crash-suppression flag moved to ctx (run-wide) in engine/emit.ts; resume.ts stale `run.state` line removed (outside write list); PauseReason dead-debt entry resolved; EVENT_TYPES dead-debt entry added until R5.3 |
| R1.3 | Status, tasks, report, summary and clean output | M | R1.2 | DONE | test/integration/cli 53 passed (Behaviors 1-4: output.test.ts; Behaviors 2/5/6/7 + torn-line edge + Done-when 2 status-json: commands.test.ts; resume already-finished: execution.test.ts); Done-when 1 grep prints nothing; bundled CLI json smoke prints "json ok", CLI exit code 1 (planner produced no plan; stdout still exactly one JSON object); typecheck, check (incl. boundaries), npm test exit 0. Deviations: intra-cli imports use dynamic backtick imports (check-boundaries only scans static/quoted specifiers); status --output-format json added (Done-when 2); CLASS column dropped from tasks table (task class not carried by catalog events, reducer has no class field; table shows ID/State/Gen/Att/Failure/Verdict); report "files changed" sourced from run.finished data.files (engine only emits it on dirty-checkout failure, otherwise "none recorded"); status/tasks/report read logs via parseEngineEvent (non-catalog lines skipped); TORN final line warning implemented per edge case; FAILED-without-failure_class shows "-" via fallback (real runs always carry a class so no test drives it); test fixture import from ../scenarios/helpers.js reused || R1.4 | Usage ledger and budget totals | M | R1.2 | TODO | |
| R1.5 | Settings schema and CLI overrides | M | R1.1 | TODO | |
| R1.6 | Env layer, config command, dispatch rules | M | R1.5 | TODO | |
| R1.7 | Prompt loader and renderer | M | R0.1 | TODO | |
| R1.8 | Run-control flags and unregistered commands | M | R1.6 | TODO | |
| R2.1 | Price table and unknown-cost policy | M | R1.4 | TODO | |
| R2.2 | Adapter registry; FakeAdapter leaves src | M | R0.3 R1.5 | TODO | |
| R2.3 | Claude adapter correctness | M | R2.2 R1.7 | TODO | |
| R2.4 | OpenCode adapter correctness | M | R2.2 R1.7 | TODO | |
| R2.5 | agy adapter correctness | M | R2.2 R2.1 R1.7 | TODO | |
| R2.6 | listModels for each adapter | M | R2.3 R2.4 R2.5 | TODO | |
| R2.7 | substrate models | M | R2.6 R2.1 | TODO | |
| R2.8 | substrate usage | M | R1.4 R2.1 | TODO | |
| R2.9 | Profiles and routing defaults | M | R2.7 R1.6 | TODO | |
| R2.10 | init and doctor | M | R2.9 | TODO | |
| R3.1 | Planner action | L | R2.2 R1.7 R2.9 | TODO | |
| R3.2 | Scheduler, dependencies, terminal states, resume | L | R3.1 | TODO | |
| R3.3 | Worker core | L | R3.2 R2.3 | TODO | |
| R3.4 | Heal, budgets, timeouts, rate limits | M | R3.3 | TODO | |
| R3.5 | Escalation L1 L2 L3 and failure packets | L | R3.4 | TODO | |
| R3.6 | Integration worktree, merge, bisect, checkpoints | L | R3.3 | TODO | |
| R3.7 | merge, undo, discard commands | M | R3.6 | TODO | |
| R3.8 | Solo mode | M | R3.3 | TODO | |
| R4.1 | Run request schema and validation | M | R2.9 R1.8 | TODO | |
| R4.2 | Question and resume protocol | M | R3.1 R4.1 | TODO | |
| R4.3 | Local-model worker route | M | R2.4 R2.9 | TODO | |
| R4.4 | Archive writer, history, gc | M | R3.2 | TODO | |
| R4.5 | Charter and planner context | M | R4.4 R3.1 | TODO | |
| R4.6 | models --stats insights | M | R2.7 R2.8 R3.4 | TODO | |
| R5.1 | Docs reconciliation, caller guide and stronger docs-check | M | R1.8 R2.8 R2.10 R3.7 R3.8 R4.2 R4.6 | TODO | |
| R5.2 | Live smoke and gate G5 | M | R5.1 | TODO | |
| R5.3 | Final wiring audit, E2E matrix and archive | M | R5.2 | TODO | |
| R5.4 | OPTIONAL: retire the governor | S | R5.3 | TODO | Only if the owner asks. |
