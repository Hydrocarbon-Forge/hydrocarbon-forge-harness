# Implementation plan (R-series)

Read `START-HERE.md` first, then `docs/plan/DECISIONS.md`. This file lists every work package (WP) in order. The detailed spec of each WP is `docs/plan/wp/<ID>.md`. Progress is tracked in `docs/plan/PROGRESS.md`. Reference only: `docs/plan/reference/AUDIT-FINDINGS.md` explains the `C-*` / `S-*` finding ids cited below.

## Why this plan exists
The code in `src/` was written as scaffolding: many modules are tested but never called, the engine fakes worker output, the CLI cannot start, and reports read events the engine never emits. The WPs below make the existing design real. **Start with R0.1.** Do not start any other WP before R0.1 is DONE.

## Rules that apply to every WP
1. Do the WP's `Do` list completely. A WP is DONE only when every command under its `Done when` passes **and** `npm run typecheck`, `npm test`, `npm run check` pass (the `check` script exists from R0.1 on).
2. Wiring counts. New code must be called from a CLI entry path, and the WP's proof command must show it working through the CLI or the E2E driver. Code reachable only from tests is not done.
3. When a WP finishes, delete every entry in `scripts/debt-allowlist.json` whose `until` equals the WP id (from R0.1 on), and keep `npm run check` green.
4. Stay inside the WP's `write`/`create` lists. If you must touch another file, stop and note it in `docs/plan/BLOCKED.md`.
5. Never add test-only branches, magic strings, or fake data to `src/`.

## Order and dependencies
```
R0.1 → R0.2 → R0.3
R0.1 → R0.4 → R0.5 (also needs R0.2)
R0.1 → R0.6   (do it right after R0.1; required before R1.2)
R0.1 → R1.7                      R0.3 → R1.1
R0.4, R0.5 → R1.2 → R1.3
              R1.2 → R1.4 → R2.1
R1.1 → R1.5 → R1.6 → R1.8
R0.3, R1.5 → R2.2 → R2.3, R2.4, R2.5 (need R1.7; R2.5 needs R2.1)
R2.3-R2.5 → R2.6 → R2.7 ;  R1.4, R2.1 → R2.8
R2.7, R1.6 → R2.9 → R2.10
R2.2, R1.7, R2.9 → R3.1 → R3.2 → R3.3 (needs R2.3) → R3.4 → R3.5
R3.3 → R3.6 → R3.7 ;  R3.3 → R3.8
R2.9, R1.8 → R4.1 ;  R3.1, R4.1 → R4.2 ;  R2.4, R2.9 → R4.3
R3.2 → R4.4 → R4.5 (needs R3.1) ;  R2.7, R2.8, R3.4 → R4.6
R4.2, R2.8 → R5.1 ; all → R5.2 → R5.3 → R5.4 → R5.5 ; R5.6 optional
```
Size: S ≈ 40 turns, M ≈ 100, L ≈ 200. Write sets are the files you may change.

---

## Phase R0: tripwires and cleanup

### R0.1 Tripwire scripts and `npm run check`  [S] deps: none  **START HERE**
Goal: make scaffolding impossible to hide. Static checks that fail the build for dead code, fake data in `src/`, event mismatches, and settings keys nobody reads, with a tagged debt list so the build stays green while the debt is paid down.
Write/create: `scripts/check-wired.mjs`, `scripts/check-events.mjs`, `scripts/check-settings.mjs`, `scripts/check-purity.mjs`, `scripts/check-plan.mjs` (already exists, keep), `scripts/debt-allowlist.json`, `scripts/lib/scan.mjs`, `package.json` (scripts only), `test/unit/scripts/*.test.ts`, `test/fixtures/check/**`.
Do: see `docs/plan/wp/R0.1.md` (fully specified).
Done when: `npm run check` passes with a populated allowlist; each script fails on seeded violations in `test/fixtures/check`.

### R0.2 Fake harness that edits files  [M] deps: R0.1
Goal: fake `claude`, `opencode` and `agy` executables that behave like the real CLIs for everything Substrate uses and can really change files, so tests never need the engine to fabricate edits.
Write: `test/fixtures/fake-harness/**`, `test/conformance/**`.
Do:
- Scenario file (JSON, path in env `FAKE_SCENARIO_FILE`): per call index, `edits` (write/append files relative to the process cwd), `reply` text, `exit_code`, `usage` (input, output, cache_read, cache_write), `delay_ms`, and failure modes `crash`, `hang`, `rate_limit`, `permission_denial`. A scenario can also hold `plan: {files: {path: content}}` for a planner call (writes `manifest.yaml`, `tasks/*.md`, stubs, then replies `PLAN READY` or writes `QUESTIONS.md` and replies `NEEDS INPUT`).
- "Fail then fix": call 1 writes bad content and call 2 (resume of the same session) writes correct content.
- Three executables with the real flag shapes and output dialects: claude (`-p`, `--output-format stream-json`, `--session-id`/`--resume`, `--model`, result event with usage and `total_cost_usd`), opencode (`run --format json -m provider/model#variant [-s id]`, events including `step_finish` with token counts), agy (`-p --output-format stream-json --model --conversation id`, usage with tokens only). Session ids: UUID for claude, opaque for the others; resume continues the call counter.
- Conformance tests parse every dialect's output with the real normalizers (`src/backends/normalize/*.ts`) and assert non-zero input and output tokens and correct session ids.
Done when: `npx vitest run test/conformance` passes; a test spawns each executable in a temp dir, a scenario edits a file, and the file contents on disk change.
Audit refs: S-M9, C-H1.

### R0.3 E2E driver and smoke test  [M] deps: R0.2
Goal: tests that run the **built CLI** with the **real adapters** against the fake executables.
Create: `test/e2e/helpers/run-substrate.ts`, `test/e2e/helpers/repo.ts`, `test/e2e/global-setup.ts`, `test/e2e/smoke.test.ts`. Write: `vitest.config.ts`.
Do:
- Global setup builds `dist/substrate.mjs` once (`npm run bundle`).
- `runSubstrate({files, scenario, args, env, stdin})` creates a temp git repo with the given files, writes `.substrate/settings.json` and `settings.local.json` pointing `backends.<name>.bin` at the fake executables, runs `node dist/substrate.mjs` with a timeout, and returns `{exitCode, stdout, stderr, runDir, events}` (parsed `events.jsonl`).
- `smoke.test.ts` has two tests, both written with `it.fails(...)` so the suite stays green now and turns red as soon as the feature works, which forces whoever finishes the feature to remove the marker: (a) a full `run` (planner scenario, worker scenarios, verify, ready to merge); the marker is removed by R3.8; (b) `node bin/substrate.mjs --help` exits 0; the marker is removed by R1.1.
Done when: `npm test` passes with both `it.fails` tests present; `npx vitest run test/e2e` reports them as expected failures.

### R0.4 Split `effects.ts`  [M] deps: R0.1
Goal: make later WPs touch separate files. No behavior change.
Write/create: `src/engine/effects.ts`, `src/engine/actions/{route,plan,approve,setup,task,solo,replan,merge,integrate,finish,shared}.ts`, `test/fixtures/golden/**`.
Do: first capture normalized `events.jsonl` (timestamps and generated ids replaced) from the 15 existing scenarios into `test/fixtures/golden/`. Move each action's implementation into its own module; keep `runEffectsLoop`, `nextActions`, `emit`, `appendRunEvent` in `effects.ts` and re-export every symbol other files import from it. No renames, no logic edits, no cleanup.
Done when: all tests pass; golden comparison passes; `wc -l src/engine/effects.ts` is under 400 and each action file under 450.

### R0.5 Remove fabrications and test hacks  [M] deps: R0.2, R0.4
Goal: delete everything in `src/` that fakes results or detects tests. Failures will now be honest.
Write: `src/engine/actions/*.ts`, `src/engine/engine.ts`, `src/spec/parser.ts`, `src/util/log.ts` (create), `test/integration/scenarios/**`, `test/integration/engine/**`, `test/fixtures/golden/**` (delete).
Do:
- Delete the fallback that writes `export const val_<task>_g<n> = 1;` and `// modified <task>` into files (task and solo actions). Changed files come from git only.
- Delete `isForcedVerifyFail`, `isL2Scenario` and the strings `"First attempt done"`, `"Attempt 1"`, `"Attempt 2"`, `"L2 contract amendment"`.
- Delete the stack-sniffing block in `parseManifest` (`new Error().stack?.includes("parser.test.ts:79")`) and fix the test it was working around.
- Delete the merge action's `rmSync` sweep of untracked files. Replace it with a preflight: if the user's checkout has uncommitted changes to tracked files, fail with a clear error and exit 2. Never delete user files.
- Replace every `console.log("[DEBUG]..."))` with `log.debug(...)` from the new `src/util/log.ts` (writes to stderr, only when `SUBSTRATE_DEBUG=1`).
- Rework the 15 scenario tests to drive the fake harness `edits`/`fail then fix` scenarios (R0.2) instead of engine-written content. Delete the golden files.
Done when: `npm test` and `npm run check` pass with the allowlist entries tagged `R0.5` removed; `git grep -n 'val_\${' src` is empty.
Audit refs: C-H1, C-H8, C-H19, C-M7.

### R0.6 Dead-export analysis  [M] deps: R0.1
Goal: catch the exact failure that created this repo's problems: functions that are exported and even imported, but never called. Module-level reachability (R0.1) cannot see them.
Create: `scripts/check-dead-exports.mjs`, `test/unit/scripts/check-dead-exports.test.ts`, `test/fixtures/check/dead-exports/**`. Write: `scripts/check-wired.mjs` (call the new analysis), `scripts/debt-allowlist.json`, `package.json`.
Do: with the TypeScript compiler API (`typescript` is already a devDependency), load `tsconfig.json`, and for every exported function, class, const and type-valued re-export in `src/**` (excluding `src/tui/**` until it is un-deferred), list references from other files that are not import or export specifiers. A symbol is LIVE if it is referenced from a LIVE declaration or from top-level code of a file reachable from `src/cli/dispatcher.ts` or `src/index.ts`; iterate to a fixed point so that code used only by dead code is also dead. Everything else is DEAD. Report DEAD symbols as `file:line name`. The allowlist gains a `dead` list with `{symbol, path, until}` entries; stale entries (now live) fail the check. Generate the initial `dead` entries with `--init-allowlist` and tag them with the WP that will wire them (mapping in `docs/plan/wp/R0.6.md`).
Done when: the fixture test proves `import {a} from "./a"` with no call is reported DEAD and a chain A→B (A dead) reports both; `npm run check` passes with the generated entries; the known dead symbols (`runWorker`, `runPlanner`, `executeReplan`, `scheduleNextTasks`, `appendRouteOutcome`, `aggregateLedger`, `generateRepoMap`) appear in the allowlist.
Audit refs: C-H21.

---

## Phase R1: the CLI starts and tells the truth

### R1.1 Entry point, build and signals  [M] deps: R0.3
Goal: `substrate` starts, and Ctrl-C stops everything cleanly.
Write: `bin/substrate.mjs`, `package.json`, `scripts/bundle.mjs`, `src/index.ts`, `src/cli/signals.ts` (create), `src/cli/dispatcher.ts` (signal plumbing only), `src/engine/engine.ts` (honour `signal`), `test/e2e/entry.test.ts`, `test/smoke.test.ts` (delete).
Do: `bin/substrate.mjs` runs `dist/substrate.mjs` (print "run `npm run bundle`" if missing); `prepare` script builds; `package.json` gets a `files` list (`bin`, `dist`, `assets`), a real description, no "(scaffold)"; `src/index.ts` exports `runCli` and the version; bundling copies `assets/` to `dist/assets/`. SIGINT/SIGTERM abort an `AbortController` passed through `runCli` into `Engine.run`; the engine kills child process groups, records `run.paused{user_cancel}`, releases the lock, exits 130/143; a second signal exits immediately.
Also remove the `it.fails` marker from the `--help` test in `test/e2e/smoke.test.ts`.
Done when: after `npm run bundle`, `node bin/substrate.mjs --help` exits 0; the E2E test starts a hanging fake worker, sends SIGINT, asserts exit 130, no live child pids, and a successful `resume`.
Audit refs: S-H1, C-M19, S-M5, S-L3.

### R1.2 Event catalog and typed emit  [M] deps: R0.4, R0.5
Goal: one definition of every engine event, used by producers and consumers.
Create: `src/contracts/events.ts`, `src/engine/emit.ts`. Write: `src/engine/actions/*.ts`, `src/engine/reducer.ts`, `src/engine/effects.ts`, `test/unit/engine/**`.
Do: zod discriminated union on `type` for every event in SUBSTRATE-PLAN Appendix D plus `plan.ready`, `integration.failed`, `tasks.invalidated`, `task.verify.started`; exact `data` shapes. All actions emit through the typed `emit`. `usage.recorded` data becomes `{record, role, task_id?, generation?, attempt?, class?}` at all five emit sites. `batch.merged` data becomes `{batch, checkpoint_ref}`. Reducer handles `integration.failed`, `tasks.invalidated`, pause reasons, and records checkpoints. `appendRunEvent` validates against the catalog.
Done when: `npm run check:events` passes with no `R1.2` allowlist entries; reducer unit tests cover each new case.
Audit refs: C-H6 (reducer part), C-M15, S-M9.

### R1.3 Status, tasks, report, summary and clean output  [M] deps: R1.2
Goal: every read-side command shows what really happened; output streams are clean.
Write: `src/cli/output.ts`, `src/cli/commands/{status,tasks,report,run,plan,resume}.ts`, `src/cli/stream-map.ts` (create), `test/integration/cli/**`.
Do: consume catalog events only. Run summary and `status` count PASSED and MERGED correctly; `tasks` shows every real state; text mode prints per-task progress lines to stderr and the final summary to stdout; `--output-format json` prints exactly one JSON object; `stream-json` prints NDJSON only, with the mapping table in `stream-map.ts` (engine event → output `type`); `report` shows goal, duration, task table (state, generation, attempts), tokens in/out and cost, files changed, verify outcomes. Rewrite CLI tests to consume logs produced by running the engine (injected `FakeAdapter` in tests), never hand-seeded event names.
Done when: tests pass; `git grep -nE '"(task.started|task.verified)"|"usage"' src/cli` finds nothing; a JSON-mode test parses stdout with `JSON.parse`.
Audit refs: S-H2, S-H3, S-M3 (status/tasks/report), C-H19.

### R1.4 Usage ledger and budget totals  [M] deps: R1.2
Goal: one place that records every usage event, and correct budget math.
Create: `src/ledger/usage.ts`, contract `UsageLedgerEntry`. Write: `src/ledger/index.ts`, `src/engine/actions/*.ts`, `src/engine/reducer.ts`, `src/config/index.ts` (add `usage.global`, default true), `src/contracts/index.ts`, `test/unit/ledger/**`.
Do: `appendUsage` writes `.substrate/ledger/usage.jsonl` and, unless `usage.global` is false, mirrors to `$XDG_STATE_HOME/substrate/usage.jsonl` (default `~/.local/state/substrate/usage.jsonl`); each line has `{v, ts, project, run_id, task_id?, generation?, attempt?, role, class?, backend, model, effort?, input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?, reasoning_tokens?, cost_usd, cost_source}`. The engine appends on every `usage.recorded`. `rebuildFromEvents(runDir)` regenerates a run's lines. Remove the state mutation that double counts (`state.usage.total_usd = currentTotal`); budget checks use reducer state plus the pending event; a `usage` event with `cumulative: true` is converted to a delta per session id. Remove the dead `data.max_usd` read.
Done when: unit tests cover double-count regression, cumulative conversion, mirror on/off; an engine test shows one ledger line per usage event.
Audit refs: C-H7, C-H20 (ledger), S-H4 (writer).

### R1.5 Settings schema and CLI overrides  [M] deps: R1.1
Goal: model flags work and overrides merge instead of clobbering.
Write: `src/contracts/index.ts`, `src/config/index.ts`, `src/util/merge.ts` (create), `src/engine/engine.ts`, `src/cli/commands/{run,plan,resume}.ts`, `src/engine/actions/solo.ts`, tests.
Do: add optional `roles.worker` (a `Route`), type `routing.escalation` as a list of model ids, default `sandbox.enabled` to false and make an enabled sandbox without `bwrap` an error. `--model` = planner model in plan mode, worker model in solo; `--worker-model` sets `roles.worker`; neither may make settings validation fail. `--timeout <seconds>` converts to the engine's unit (document it). Deep-merge overrides (`budgets`, `sandbox`, `permissions`) with `src/util/merge.ts` instead of a shallow spread; `--max-budget-usd` changes only `budgets.run.max_usd`. Solo reads `roles.worker` instead of the hardcoded fallback.
Done when: unit tests for merge; a dispatcher-level test runs `run --model x --worker-model y` and gets past settings loading (exit is not 2).
Audit refs: C-H18, S-H8, C-M10, C-M13, S-M2.

### R1.6 Env layer, config command, dispatch rules  [M] deps: R1.5
Goal: documented configuration works.
Write: `src/config/index.ts`, `src/cli/commands/config.ts`, `src/cli/dispatcher.ts`, tests.
Do: precedence, lowest to highest: built-in defaults, user `~/.config/substrate/settings.json`, project `.substrate/settings.json`, `.substrate/settings.local.json`, `--settings <file>`, `SUBSTRATE_*` environment, flags. Implement exactly the environment variables in the table in `docs/reference/config.md` (lines ~50-64). `config get|list` show the merged result; `config set <key> <value> [--local]` validates against the schema and writes `settings.json` or `settings.local.json`. Dispatcher: no arguments prints help and exits 0; a first token that is not a command is a prompt (single words included).
Done when: precedence tests (one per layer); `substrate "refactor"` reaches `run`.
Audit refs: S-H11, S-L1, S-L2.

### R1.7 Prompt loader and renderer  [M] deps: R0.1
Goal: prompts come from `assets/`, rendered by code, never written in TypeScript.
Create: `src/prompts/index.ts`, `src/prompts/render.ts`. Write: `src/roles/prompts/*.ts` (become thin wrappers), `src/cli/commands/agents.ts`, `scripts/bundle.mjs` (copy assets), `scripts/check-purity.mjs` (add rule), tests.
Do: `loadAgentBody(role)`, `loadTemplate(path)`, `render(template, vars)` (error on a missing variable or a leftover `{{...}}`; empty values become `(none)`), `assembleSystem(role, {class})` per the table in `assets/prompts/README.md`, override order project → user → built-in; built-in directory resolved relative to the installed package (`dist/assets` or `../assets`), never `process.cwd()`. Existing prompt builders keep their exported signatures and call the loader; delete the inline prompt text. `substrate agents` lists built-in plus project definitions. Purity rule: no string literal starting with "You are the Substrate" in `src/`.
Done when: a test renders every template under `assets/prompts` with sample variables and checks the variable names match the README table; `node dist/substrate.mjs agents` lists the five built-in agents.
Audit refs: S-H13 (loader), C-H11 (assembly side).

### R1.8 Run-control flags and unregistered commands  [M] deps: R1.6
Goal: flags in the docs do what they say.
Write: `src/cli/dispatcher.ts`, `src/cli/commands/{run,resume,verify,sessions,backends,doctor}.ts`, `src/cli/{bench,agents-import}.ts`, tests.
Do: `resume <run_id|session_id>`, `--session-id`, `run --resume <run_id>`, `-c/--continue` (latest session), `--fork-session` (new session id, same history) all select what they name and fail clearly on an unknown id. `verify <task> [--run <id>] [--timeout s]` finds the run containing the task (latest unless `--run`) and errors if that task's worktree is missing (no fallback to another task). `--allowed-tools/--disallowed-tools` split on commas and flow into `permissions`. `-w/--worktree <name>` names the run branch. Register `bench` and `agents import --from claude|opencode` in the dispatcher. `--output-format json` works for `sessions`, `backends`, `doctor`.
Done when: one test per flag; `node dist/substrate.mjs bench --help` and `agents import --help` work.
Audit refs: S-H7, S-H9, S-H12, S-M2, S-L7.

---

## Phase R2: backends, models and usage reporting

### R2.1 Price table and unknown-cost policy  [M] deps: R1.4
Goal: real default prices, and no usage ever lost or reported as a fake $0.
Create: `src/backends/default-pricing.ts` (data from `docs/spikes/S4-pricing.json`, same `asOf` and `sources`). Write: `src/contracts/index.ts` (`cost_source` gains `"unknown"`), `src/backends/pricing.ts`, `src/backends/normalize/{agy,opencode,claude}.ts`, `src/backends/adapters/opencode.ts`, `src/config/index.ts`, tests.
Do: settings `pricing.models` overlays the built-in table by model id. `calculateCostUsd` returns `{cost_usd, cost_source}`: unlisted model → `{0, "unknown"}` and never throws; computed cost excludes cache tokens when no cache rate exists. The opencode adapter passes the pricing table to its normalizer and computes cost when the harness reports 0 for a priced model. Delete the agy adapter's silent catch around usage (log and emit an `error{protocol}` event).
Done when: unit tests for priced, unpriced and no-cache-rate cases; an agy normalizer test with an unpriced model yields a usage record with `cost_source: unknown` and the stream continues.
Audit refs: C-H20, S-M1.

### R2.2 Adapter registry; FakeAdapter leaves `src/`  [M] deps: R0.3, R1.5
Goal: the CLI drives the real adapters.
Create: `src/backends/registry.ts`. Write: `src/engine/engine.ts`, `src/engine/actions/*.ts`, `src/cli/commands/{run,plan,resume,backends}.ts`, `test/conformance/fake-adapter.ts` (stays under `test/`), tests, `test/e2e/adapters.test.ts`.
Do: `createAdapters(settings)` builds claude, opencode and agy adapters from `backends.<name>.{bin,version_pin,max_concurrency}`. `EngineImpl({settings, adapters?})` has no default adapter import from `test/`; the engine picks the adapter from each route's `backend` and fails with pause reason `backend_unavailable` if it is missing. `substrate backends` no longer lists `fake`. Tests inject `FakeAdapter` explicitly.
Done when: `git grep -n "fake-adapter" src` is empty; the E2E test runs `substrate run` and asserts the fake `claude` executable was invoked with the expected `--model`; allowlist entries tagged `R2.2` are removed.
Audit refs: known FakeAdapter default, S-L5, C-L1, C-H22 (backend part).

### R2.3 Claude adapter correctness  [M] deps: R2.2, R1.7
Goal: claude spawns match the real CLI and report honest usage.
Write: `src/backends/adapters/claude.ts`, `src/backends/normalize/claude.ts`, `src/contracts/index.ts` (`SpawnRequest.raw_dir`), tests, `docs/spikes/S1-claude.md` (read only).
Do: session ids are UUIDs (the engine generates one per task/generation/attempt); `system_append` goes through the flag documented in S1 (verify with `claude --help` if installed); raw stream is written to `req.raw_dir` (the run directory), never inside the worktree; permissions use Claude's rule syntax (`Bash(git commit*)` etc.) and always deny `Agent`; the usage record's model is the actual id from `modelUsage`, not the requested alias; result usage is per invocation so emit `cumulative: false`; map result subtypes and stderr to typed errors `rate_limit`, `auth`, `crash`; `permission_denials` become denials.
Done when: normalizer and adapter tests with the existing claude fixtures pass; E2E asserts the fake claude received UUID session id, system text and deny rules; with `claude` installed, `SUBSTRATE_LIVE=1 npx vitest run test/live/claude-args.test.ts` (create) passes.
Audit refs: C-H11, C-H12, C-M3, C-M4, C-M8.

### R2.4 OpenCode adapter correctness  [M] deps: R2.2, R1.7
Goal: opencode spawns work, the temp agent file never trips scope checks, and usage is recovered.
Write: `src/backends/adapters/opencode.ts`, `src/backends/normalize/opencode.ts`, tests.
Do: the generated per-run agent file lives in the worktree's `.opencode/agents/` and is added to the worktree git exclude and to the scope-ignore list, and is deleted after the run; the deny action is `subagent` (not `subagents`) and every entry maps through `TOOL_MAP`; when no `step_finish` event arrives, run `opencode session export <id> --standalone` and read tokens from it, otherwise record zero tokens with `cost_source: unknown`; replace the `process.stdout.write` warning with `log.warn`; the usage model is `provider/model` without the variant; `system_append` is the agent file body.
Done when: tests with all existing opencode fixtures pass; a test with a stream lacking `step_finish` uses a stubbed `session export` output.
Audit refs: C-M3 (opencode part), C-H12 (opencode part), C-H11.

### R2.5 agy adapter correctness  [M] deps: R2.2, R2.1, R1.7
Goal: agy runs report usage and cannot silently change git state.
Write: `src/backends/adapters/agy.ts`, `src/backends/normalize/agy.ts`, tests, `docs/spikes/S3-agy.md` (read only).
Do: follow S3 for flags. If agy has no working deny mechanism for the live binary, set `permission_denial_signal: "stderr"` and say so in a comment; the engine's HEAD-unchanged check (R3.3) is the safeguard. Without a verified system-prompt mechanism, prepend `system_append` to the prompt under a `SYSTEM RULES` heading. Remove the passthrough of `FAKE_SCENARIO`/`AGY_LIVE` to the real binary's environment. `result.usage` is conversation-cumulative: per-step usage is the record; the session total is the sum of steps, not the cumulative value (fixes double counting on resume). Tokens only → cost computed from the price table (`unknown` when unpriced).
Done when: tests with all agy fixtures; a resume fixture test proves usage is not double counted.
Audit refs: C-M8 (agy), agy notes in the usage map.

### R2.6 `listModels()` for each adapter  [M] deps: R2.3, R2.4, R2.5
Goal: ask each harness what models it offers.
Create: contract `ModelInfo = {id, display?, efforts: Effort[], source: "cli"|"static"|"settings"}`. Write: `src/contracts/index.ts` (`HarnessAdapter.listModels(): Promise<ModelInfo[]>`), the three adapters, `test/conformance/fake-adapter.ts`, `test/fixtures/backends/{opencode,agy}/models.txt`, tests.
Do: claude: static aliases `haiku`, `sonnet`, `opus`, `fable` plus every model id in settings and the price table (there is no list command). opencode: run `opencode models --standalone`, parse its output (capture a real fixture if the binary is installed; otherwise write the fixture from the format in `docs/spikes/S2-opencode.md` and put "UNVERIFIED" in the fixture's header). agy: run `agy models`, same rules. Effort lists: claude uses the `Effort` enum; opencode variants per family from S2; agy: low/medium/high, plus xhigh/max only where S3 says the model accepts them.
Done when: parser tests for both fixtures; fake harness answers `models` in each dialect.
Audit refs: models enumeration gap.

### R2.7 `substrate models`  [M] deps: R2.6, R2.1
Goal: Hermes or a person can see every available model, by provider and overall.
Write: `src/cli/commands/models.ts`, `src/cli/model-catalog.ts` (create), `src/config/index.ts` (cache path), tests.
Do: `substrate models [--provider claude|opencode|agy] [--refresh] [--output-format json]`. For each provider: installed, version, whether the version matches the pin, and models with id, efforts, price per million input/output tokens (or "unpriced"), and which profile slots currently use them. Text mode prints a table per provider then an "all models" summary; JSON prints the same structure (stable schema `ModelCatalog`). Results cache in `.substrate/state/models.json` (24 hours; `--refresh` bypasses). An uninstalled provider is listed as `installed: false` with no models, never an error.
Done when: tests for text and JSON; `node dist/substrate.mjs models --output-format json | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))"` exits 0 in the E2E fixture.
Audit refs: `substrate models` gap, S-M3 (models).

### R2.8 `substrate usage`  [M] deps: R1.4, R2.1
Goal: one command shows tokens and cost across every harness.
Create: `src/cli/commands/usage.ts`. Write: `src/cli/commands/cost.ts` (becomes an alias of `usage`), `src/cli/dispatcher.ts`, `src/ledger/usage.ts`, tests.
Do: `substrate usage [--by model|provider|role|run|task|class|day] [--since 7d|2026-10-01] [--provider P] [--model M] [--run ID] [--all-projects] [--cache] [--output-format json]`. Default grouping is `model`. Default columns: group, runs, calls, input tokens, output tokens, cost (with "unknown" shown when any row in the group has `cost_source: unknown`, plus the number of unknown rows). `--cache` adds cache read, cache write and reasoning tokens. Reads the project ledger; `--all-projects` reads the global mirror. `cost` keeps working as an alias. Rebuild the ledger from `events.jsonl` with `usage --rebuild`.
Done when: tests over a fixture ledger for every `--by` value; E2E run then `usage --by role` shows planner and worker rows with non-zero input/output tokens.
Audit refs: S-H4, C-H20.

### R2.9 Profiles and routing defaults  [M] deps: R2.7, R1.6
Goal: the plan/work/fast model triple per provider (A3) drives routing.
Write: `src/contracts/index.ts` (`profiles`, `defaults`), `src/config/index.ts`, `src/roles/router.ts`, `src/engine/ladder.ts`, tests.
Do: `profiles.<provider> = {plan:{model,effort?}, work:{...}, fast?:{...}}`; `defaults = {planner_provider, worker_provider}`. Route resolution per task class follows DECISIONS A3; explicit `routing.<class>` entries still override. The planner route comes from the planner provider's `plan` slot, workers from the worker provider's slots. The escalation chain is `fast → work → plan` of the worker provider with repeats removed (`escalation` entries are model ids). A missing provider in profiles is a validation error that names the missing field (exit 2).
Done when: unit tests for each class mapping, missing `fast`, mixed providers, escalation; `substrate models` shows slot usage.
Audit refs: C-H22.

### R2.10 `init` and `doctor`  [M] deps: R2.9
Goal: first-run setup produces working config.
Write: `src/cli/commands/{init,doctor}.ts`, tests.
Do: `substrate init [--force] [--provider P --plan model[:effort] --work model[:effort] --fast model[:effort]]` creates `.substrate/settings.json` (with built-in pricing referenced, not placeholders), `.substrate/.gitignore` for runtime paths (`runs/`, `worktrees/`, `state/`, `sessions/`, `ledger/`, `settings.local.json`), `.substrate/charter.md` stub, and detects installed harnesses to propose profiles (never inventing model ids: it lists what `substrate models` finds and asks the caller to choose via flags; headless with no flags writes only the providers it can verify). `doctor` checks git ≥ 2.30, each adapter's `validateEnvironment` including pin drift, that settings validate, that profiles name models the harness lists (warn if not), and prints how to fix each problem.
Done when: tests; E2E `init` then `doctor` exits 0 with fake binaries.
Audit refs: S-M1, S-M3 (init/doctor).

---

## Phase R3: the engine runs on the real modules

### R3.1 Planner action  [L] deps: R2.2, R1.7, R2.9
Goal: planning uses `runPlanner` and the prompt library.
Write: `src/engine/actions/{plan,approve}.ts`, `src/roles/planner.ts`, `src/spec/{repomap,ecosystem,index}.ts`, `src/roles/prompts/planner.ts`, tests.
Do: the plan action calls `runPlanner` with prompts from `assets/` (`planner/request.md`, system = planner agent + `planner/format.md`). The planner runs with write access to the run directory only. Accept files written to the run directory; if there is no `manifest.yaml`, fall back to fenced `<lang>:<path>` blocks. Delete the inline `extractFencedFiles` path and the unvalidated `safeParseManifest` fallback: invalid YAML is a lint error. Finish lines: `PLAN READY`; `NEEDS INPUT` (a `QUESTIONS.md` must exist; pause the run with reason `needs_human`, exit 3, questions in the `result`); anything else is a format error. Format retries resume the same planner session using `planner/correction.md`. Contract stubs are typechecked before being committed and the stub commit updates the run ref with an expected old value. Instruction files (`CLAUDE.md`, `AGENTS.md`, `SUBSTRATE.md`, in that order of preference per `instructions.workers`) are discovered and passed. `plan` mode (`substrate plan`) always stops after plan + lint + estimate. `plan.approved` is emitted by approval flow or `resume`, so a gated run can continue.
Done when: E2E: fake planner scenario (valid plan; invalid plan then corrected; `NEEDS INPUT`) behaves as described; allowlist entries tagged `R3.1` removed.
Audit refs: C-H10, C-H15, C-M12, C-M16, C-M17, C-H21 (planner, repomap, ecosystem).

### R3.2 Scheduler, dependencies, terminal states, resume  [L] deps: R3.1
Goal: tasks run in dependency order and the run's final state is truthful.
Write: `src/engine/{scheduler,reducer,engine}.ts`, `src/engine/actions/{setup,shared}.ts`, `src/store/{event-store,run-lock}.ts`, tests.
Do: dependents become READY when their dependencies PASS/MERGE; write-set overlap serialization via `scheduleNextTasks`; `concurrency.workers` honoured (no `?? 4` fallback). The run status and exit code are derived from state, never defaulted to "finished": unfinished, paused or blocked work yields exit 1, 3 or 4 as appropriate. Resume rebuilds RUNNING/SCOPE_CHECK/VERIFYING tasks (resume the session if one exists, else re-ready the task) at every event boundary. Use `EventStoreImpl` for the run log and take the run lock for the whole run.
Done when: E2E for a 3-task DAG with a dependency chain, a pause then `resume`, and a kill -9 then `resume`; allowlist entries tagged `R3.2` removed.
Audit refs: C-H4, C-H5, C-M14, C-H21 (scheduler, event store).

### R3.3 Worker core  [L] deps: R3.2, R2.3
Goal: a task runs in its own worktree and is judged by code.
Write: `src/engine/actions/task.ts`, `src/roles/worker.ts`, `src/git/{workspace,scope,commit}.ts`, `src/verify/runner.ts`, tests.
Do: `runWorker` replaces the inline worker action. Worktree `.substrate/worktrees/<run_id>/<task_id>-g<n>/` (never reused across runs); `manifest.setup` failures fail the task visibly; spawn with the routed backend, model, effort and the prompt assembly in `assets/prompts/README.md`; changed paths from git; scope revert/fail per setting; protected-file hash check; HEAD and branch must be unchanged (a worker that committed or switched branches is a `scope_violation`); verify via the verify runner; commit only the allowed pathspec and treat a failed commit as a task failure. Solo and plan tasks share this code.
Done when: E2E: passing task, scope violation reverted, protected file modified, worker that commits; allowlist entries tagged `R3.3` removed.
Audit refs: C-H1 (real behaviour), C-H23, C-M2, C-M18, C-H21 (worker).

### R3.4 Heal, budgets, timeouts, rate limits  [M] deps: R3.3
Goal: the first retry is informed and limits are enforced.
Write: `src/engine/actions/task.ts`, `src/roles/worker.ts`, `src/engine/ladder.ts`, tests.
Do: L0 heal resumes the same session in the same worktree (never recreate it) with `assets/prompts/worker/heal.md` rendered from real verify output (≤ 8 KB); per-task `max_usd`, `max_tokens`, `max_turns` and `timeout_min` enforced from usage events (no `< 3600000` cutoff); run budget exhaustion pauses with exit 4 and a warning event at 80%; rate limits are detected from typed `error{rate_limit}` events, back off exponentially, halve concurrency (floor 1, on a copy of settings, never mutating shared defaults) then pause `rate_limited`.
Done when: E2E fail-then-fix, budget overshoot, hang timeout, rate limit; the heal prompt in the event log contains the real failing command output.
Audit refs: C-H2, C-H3, C-M8, C-M9.

### R3.5 Escalation L1/L2/L3 and failure packets  [L] deps: R3.4
Goal: failures replan for real.
Write: `src/engine/actions/replan.ts`, `src/engine/{replan,packet,ladder}.ts`, tests.
Do: L1 uses `executeReplan` with `planner/replan-l1.md`; the revised `tasks/<id>.md` is parsed, re-linted and written, then the next generation runs in a fresh worktree on the next ladder model; `ESCALATE:` replies go to L2. L2 uses `planner/replan-l2.md`, re-lints the amended plan, invalidates only dependents (never merged tasks), and runs at most `l2_per_run` times. L3 pauses with exit 3. `FailurePacket` is complete (attempts, diff and patch path, verify output, scope violations, worker summary, related contracts, dependents). Per-task timeout and budget failures trigger L1; run budget does not.
Done when: E2E scenarios 3 and 14 from SUBSTRATE-PLAN §14 pass; allowlist entries tagged `R3.5` removed.
Audit refs: C-H14, C-M5, C-M6, C-H21 (replan).

### R3.6 Integration worktree, merge, bisect, checkpoints  [L] deps: R3.3
Goal: merging never touches the user's checkout.
Write: `src/engine/actions/{merge,integrate}.ts`, `src/git/{merger,workspace}.ts`, tests.
Do: per batch: merge-tree preflight, merge in an integration worktree, run `integration_verify`; on failure bisect deterministically and produce `FailurePacket(integration_failed)`; the loop is bounded; `batch.merged` records `checkpoint_ref`; remove all writes to the user's working tree and any branch switching in it.
Done when: E2E merge conflict → L1; integration failure → culprit found; a test proves untracked and modified user files are untouched.
Audit refs: C-H6, C-H8.

### R3.7 `merge`, `undo`, `discard` commands  [M] deps: R3.6
Write: `src/cli/commands/{merge,undo,discard}.ts`, tests.
Do: `merge <run>` refuses runs that did not finish successfully, uses `src/git/merger.ts`, supports `--dry-run` and `--abort-on-conflict`, honours `git.auto_merge`. `undo [run] [--hard]` resets the run branch to the previous recorded checkpoint, errors when none exists, and never prints success otherwise. `discard <run> [--force]` removes worktrees (`git worktree remove`/`prune`), task and run branches, kills live harness processes with `--force`, and records cancellation.
Done when: E2E for each command including refusals.
Audit refs: S-H5, S-H6, S-M4, C-H16, C-H17.

### R3.8 Solo mode  [M] deps: R3.3
Write: `src/engine/actions/solo.ts`, `src/spec/ecosystem.ts`, `src/cli/commands/run.ts` (`--verify`), tests.
Do: one worker in a worktree, no planner/manifest; repeatable `--verify "<cmd>"`, else detected ecosystem default, else warn; scope check, verify, L0 heal, budgets, engine commit to a task branch under the run branch; same events as plan mode. Remove the `git add -A` path. This is the WP that removes the `it.fails` markers in `test/e2e/smoke.test.ts` (the full plan-mode smoke must pass by now).
Done when: E2E scenario 16; smoke test passes without `it.fails`.
Audit refs: C-H9.

---

## Phase R4: caller interface, archive and insights

### R4.1 Run request schema and validation  [M] deps: R2.9, R1.8
Create: `src/contracts/request.ts`, `src/cli/request.ts`. Write: `src/cli/commands/{run,plan}.ts`, tests.
Do: `RunRequest` = `{goal, planner?:{provider,model?,effort?}, worker?:{provider,model?,effort?}, mode?, verify?: string[], budget?, permission_mode?, context?: string[]}` (no `scope` field: nothing would enforce it, and a field that is accepted but ignored is not allowed). `substrate run --request <file|->` reads it; flags `--plan <provider[:model[:effort]]>` and `--work <...>` build the same object; positional prompt = `goal`. A run needs a planner provider and a worker provider from the request or from `defaults`; otherwise exit 2. Validation failures print one JSON object `{error:"invalid_request", problems:[{field, message, fix}]}` and exit 2. Explicit model or effort overrides the profile slot; unknown models for a listed provider are rejected with the list of valid ids.
Done when: tests for valid, missing provider, unknown model, conflicting flags and file; E2E run from a request file.

### R4.2 Question and resume protocol  [M] deps: R3.1, R4.1
Write: `src/cli/commands/{run,resume,status}.ts`, `src/engine/actions/plan.ts`, `src/contracts/events.ts`, tests.
Do: when the planner returns `NEEDS INPUT` (or a gate needs a decision), the run pauses with exit 3 and the final `result` (JSON and stream-json) contains `{subtype:"needs_input", run_id, questions:[{id,text,default}]}`. `substrate resume <run> --answers <file|->` accepts `{answers:[{id,text}]}`, appends them to the planner context, and continues; answering with nothing uses each question's default. `status` shows pending questions.
Done when: E2E: ask, pause, answer, continue to a finished plan; unanswered resume with defaults.

### R4.3 Local-model worker route  [M] deps: R2.4, R2.9
Write: `src/backends/adapters/opencode.ts`, `src/config/index.ts`, `docs/reference/local-model.md` (create), tests.
Do: `backends.opencode.provider = {id, npm:"@ai-sdk/openai-compatible", base_url, models:{...}}` (read from `settings.local.json` only) is written into the per-run OpenCode config; `substrate config set backends.opencode.provider.base_url <url> --local` works; a profile slot can name such a model; concurrency honours `max_concurrency`. Committed files and generated prompts never contain the address.
Done when: E2E with the fake opencode asserts the generated config has the provider; a test asserts `git grep` finds no IP:port in committed config.

### R4.4 Archive writer, `history`, `gc`  [M] deps: R3.2
Create: `src/archive/index.ts`, `src/cli/commands/{history,archive,gc}.ts`. Write: `src/engine/actions/finish.ts`, `src/cli/dispatcher.ts`, tests.
Do: on a terminal run state the engine writes `.substrate/archive/<version>/<run_id>/` (`summary.md`, `manifest.yaml`, `tasks/`, `decisions.md`, `usage.json`) and appends a line to `INDEX.md`; `substrate archive <run>` does it manually; `substrate history [--all-versions] [--output-format json]` lists archived runs; `substrate gc [--older-than 30d]` removes `runs/<id>` data of archived runs only. `summary.md` states goal, outcome, task table, tokens in/out and cost, and what was learned (from `decisions.md`).
Done when: tests; E2E finished and failed runs both archive.

### R4.5 Charter and planner context  [M] deps: R4.4, R3.1
Create: `src/charter/index.ts`, `src/cli/commands/charter.ts`. Write: `src/engine/actions/plan.ts`, tests.
Do: `substrate charter show|set <file|->|bump <version>`; the planner request fills `{{charter}}` (4 KB cap) and `{{history}}` (the five most recent summaries of the current version, 6 KB cap); old versions are excluded unless `--history-all`. The charter is never written automatically.
Done when: tests for caps and version exclusion; E2E shows both in the planner prompt.

### R4.6 `models --stats` insights  [M] deps: R2.7, R2.8, R3.4
Write: `src/cli/model-catalog.ts`, `src/cli/commands/models.ts`, `src/ledger/usage.ts`, tests.
Do: `substrate models --stats [--since 30d]` adds per model: tasks run, first-pass verify rate, heal rate, replans, average input and output tokens per task, average cost per passed task (or "unknown"). Computed from the ledger and run event logs; models without data show "no data".
Done when: tests over fixture runs; E2E after two runs shows non-empty stats.

---

## Phase R5: truth and gates

### R5.1 Caller guide for agents  [S] deps: R4.2, R2.8
Create: `assets/prompts/caller/substrate-caller.md`, `docs/reference/caller-guide.md` (same content). Do: a short guide an agent such as Hermes can load: list models, pick providers, build a request, run, handle `needs_input`, read usage. Every command shown must be executed against the E2E fixture by a test (copy the commands into a test table).
Done when: the test runs each documented command and checks exit codes.

### R5.2 Docs reconciliation and stronger docs-check  [M] deps: all R1-R4
Write: `README.md`, `docs/reference/**`, `scripts/docs-check.mjs`, `SUBSTRATE-PLAN.md`.
Do: README, cli.md, config.md, adapters.md describe only what exists (no TUI claims, no governor default). `docs-check` also verifies: each documented flag is parsed in `src/cli`, each documented command is reachable from the dispatcher, each documented `SUBSTRATE_*` variable is read, each documented settings key has a reader. Mark SUBSTRATE-PLAN.md sections superseded by DECISIONS.md.
Done when: `npm run docs:check` passes with the new rules; seeded-violation tests.

### R5.3 Live smoke and gate G5  [M] deps: R5.2
Write: `test/live/**`, `scripts/gate-g5.mjs`, `package.json`.
Do: `npm run test:live` runs a full `run` on a toy repo ("add a function and its test") for each installed harness within a cost cap of $0.25 each; `npm run gate:g5` fails if any installed harness lacks a recorded pass in `.substrate/ledger/live-smoke.json` or if a live test was skipped. Security is out of scope (DECISIONS A6).
Done when: on this machine `npm run gate:g5` passes for every installed harness (record which).

### R5.4 Final wiring audit and E2E matrix  [M] deps: R5.3
Create: `test/e2e/matrix.test.ts`. Do: the 16 scenarios of SUBSTRATE-PLAN §14 through the CLI with real adapters and fake executables; governor-free request run; local-model route; SIGKILL then resume; merge/undo/discard on a temp repo; JSON and stream-json parse cleanly; every dialect. `scripts/debt-allowlist.json` must be empty.
Done when: `npm test` and `npm run check` pass with an empty allowlist.

### R5.5 Archive the R-series  [S] deps: R5.4
Do: move `docs/plan/wp/` and `docs/plan/IMPLEMENTATION-PLAN.md` and `docs/plan/PROGRESS.md` to `docs/archive/<date>-r-series/`; keep `docs/plan/DECISIONS.md`; update `START-HERE.md` to the post-remediation state. Done when: `npm run docs:check` passes.

### R5.6 OPTIONAL: retire the governor  [S] deps: R5.4
Only on the owner's instruction. Delete `src/roles/{governor,governor-tools}.ts`, the `roles.governor` setting, `assets/agents/governor.md`, their tests, and the update to `test/unit/roles/assets.test.ts` (4 agents instead of 5).
