# BLOCKED

## R1.6 — spec contradicts the check tripwire (Done-when #4 is unsatisfiable)

**Status: RESOLVED by owner on 2026-10-18.** The owner directed: skip the deletion for now and perform it after the seven keys are implemented by their consumer WPs (R3.1 / R3.4 / R3.7). R1.6 proceeded with everything else in its spec; the seven `until: "R1.6"` entries were left in `scripts/debt-allowlist.json`, `npm run check` passes, and the deferral is recorded in `docs/plan/PROGRESS.md` Notes. Original analysis below.

### The conflict

`docs/plan/wp/R1.6.md`, Done-when #4 requires **both**:

1. `npm test`, `npm run typecheck` and `npm run check` exit 0, **and**
2. `Delete any scripts/debt-allowlist.json entry whose until is R1.6`.

These two clauses are mutually exclusive as of R1.6. The seven `until: "R1.6"` entries in `scripts/debt-allowlist.json` (lines 180–203 and 276–279) are:

- `budgets.run.max_tokens`
- `budgets.task.max_turns`
- `execution.strategy`
- `git.auto_merge`
- `git.branch_prefix`
- `instructions.workers`
- `sandbox.network`

`scripts/check-settings.mjs` (run by `npm run check`) fails on any settings schema leaf that is not read in `src/` (excluding `src/contracts/**`, `src/config/**`, `src/cli/commands/config.ts`) and not present in the allowlist. The seven keys above are **not read anywhere in `src/` yet**, and R1.6 cannot make them read:

- The R1.6 env table (Behavior 1) reads only `SUBSTRATE_SETTINGS`, `SUBSTRATE_CONFIG_DIR`, `SUBSTRATE_PROJECT_DIR`, `SUBSTRATE_MAX_BUDGET_USD` (→ `budgets.run.max_usd`), `SUBSTRATE_MODEL` (→ `roles.planner.model`), `SUBSTRATE_WORKER_MODEL` (→ `roles.worker.model`), `SUBSTRATE_PERMISSION_MODE`, `SUBSTRATE_OUTPUT_FORMAT`. None of the seven keys.
- The only R1.6-writable file that the scanner inspects is `src/cli/dispatcher.ts`; the dispatcher has no role in reading those keys, and `src/cli/commands/run.ts` (where a flag-based read would naturally live) is **not** in R1.6's write list.
- The keys' actual consumers are later WPs: R3.1 (`instructions.workers`), R3.4 (`budgets.run.max_tokens`, `budgets.task.max_turns`), R3.7 (`git.auto_merge`).

Deleting the entries therefore breaks `npm run check`; keeping them violates the delete clause.

### Exact evidence (re-verified)

Current state — check passes:

```
$ node scripts/check-settings.mjs
OK
```

With the seven `until: "R1.6"` entries removed from a copy of the allowlist (`/tmp/allowlist-no-r16.json`):

```
$ node scripts/check-settings.mjs --allowlist /tmp/allowlist-no-r16.json
unread-settings-key src/contracts/index.ts:1 Settings key "budgets.run.max_tokens" is not read anywhere in src/
unread-settings-key src/contracts/index.ts:1 Settings key "budgets.task.max_turns" is not read anywhere in src/
unread-settings-key src/contracts/index.ts:1 Settings key "execution.strategy" is not read anywhere in src/
unread-settings-key src/contracts/index.ts:1 Settings key "git.auto_merge" is not read anywhere in src/
unread-settings-key src/contracts/index.ts:1 Settings key "git.branch_prefix" is not read anywhere in src/
unread-settings-key src/contracts/index.ts:1 Settings key "instructions.workers" is not read anywhere in src/
unread-settings-key src/contracts/index.ts:1 Settings key "sandbox.network" is not read anywhere in src/
FAIL: 7 violation(s)
```

### Root cause

The allowlist seed was set by R0.1 (`docs/plan/wp/R0.1.md` line 80, and the hard-coded `assignUntil` in `scripts/check-settings.mjs` lines 176–204), which assigned `until: "R1.6"` to exactly these seven keys — an assumption that R1.6 would consume them. The R1.6 spec (written later) never assigns consumption of those keys to this WP; that work landed in R3.1/R3.4/R3.7. Nothing in R1.6.md, DECISIONS.md, or AUDIT-FINDINGS.md records this assumption or its withdrawal.

### What was not done (and why)

- The seven entries were **not** deleted: doing so makes `npm run check` fail, violating Done-when #4's own first clause.
- No reads of the seven keys were added to `src/cli/dispatcher.ts` to satisfy the scanner: that would be a scanner-pleasing workaround with no behavioural meaning, and it would edit a file for a reason the spec never assigns it (START-HERE §8: "Do not guess, do not work around").
- `scripts/debt-allowlist.json` is also not in R1.6's write list; START-HERE §4.6 anticipates spec-directed deletions, but the deletion itself is unsatisfiable, so no deletion was made.
- The rest of R1.6 (env layer, config command, dispatch rules, tests) was **not** started, because the WP cannot be proven done per its Done-when and START-HERE §4.6/§8.

### Options for the owner

1. Amend R1.6 Done-when #4: reassign the seven entries to the WPs that actually consume them (`until: R3.1` for `instructions.workers`; `R3.4` for `budgets.run.max_tokens` and `budgets.task.max_turns`; `R3.7` for `git.auto_merge`; and the consuming WPs for `execution.strategy`, `git.branch_prefix`, `sandbox.network`), update `assignUntil` in `scripts/check-settings.mjs` to match, and have R1.6 delete only entries it actually consumes (none, as written).
2. Or keep the entries at `until: "R1.6"` and remove the delete clause from R1.6 Done-when #4 (the consumer WPs delete them).
3. Or explicitly instruct R1.6 to read the seven keys in the dispatcher (not recommended — no behavioural meaning).

Until the spec is amended, R1.6 remains blocked and not DONE.

## R2.6 — spec-mandated `ModelInfo` zod schema conflicts with the contract catalogue test

**Status: RESOLVED by owner on 2026-10-18.** The owner directed option 1: add `ModelInfo` to `EXPECTED_DECLARATIONS` in `test/unit/contracts/schemas.test.ts` (the hard-coded list is stale relative to `IMPLEMENTATION-PLAN.md` line 198, which assigns the `ModelInfo` contract to R2.6). The one-line test change was applied with a comment citing this decision, the full suite is green, and R2.6 was committed. Original analysis below. R2.6 is otherwise complete: its five Done-when items all pass today (`npx vitest run test/unit/backends/list-models.test.ts` 26 tests, the two `bin ... | diff -` proofs print `same`, `npx vitest run test/conformance` passes, `npm run typecheck` and `npm run check` exit 0; no `scripts/debt-allowlist.json` entry has `until: R2.6`). The block is the full suite: one test fails that R2.6 cannot make pass without editing a file outside its write/create lists.

### The conflict

`docs/plan/wp/R2.6.md` Interface mandates `export const ModelInfo = z.object({...})` in `src/contracts/index.ts` ("the type and zod object"). `test/unit/contracts/schemas.test.ts` asserts contracts export exactly its hard-coded `EXPECTED_DECLARATIONS` list ("No added contract-type schemas beyond Appendix A"), which does not include `ModelInfo`, and `ModelInfo` is not in Appendix A (`SUBSTRATE-PLAN.md`). The test file is in neither R2.6's write nor create lists. So the WP cannot be fully green: either the schema must be exported (Interface verbatim, test fails) or the test's list must be amended (file not editable by R2.6). START-HERE §10 also forbids weakening or editing an existing test to make it pass.

Related deviation already recorded in PROGRESS Notes: `listModels` was made optional on `HarnessAdapter` so the protected `test/integration/backends/claude.test.ts` wrapper and `test/integration/roles/fixtures.ts` stub (which do not implement `listModels`) still typecheck.

### Evidence

```
$ npm test
FAIL test/unit/contracts/schemas.test.ts > exports exactly the Appendix A declarations (no renames, no extras)
AssertionError: expected [ 'ModelInfo' ] to deeply equal []
```

Everything else passes: 1177 passed | 1 failed | 2 skipped.

### Options for the owner

1. Add `"ModelInfo"` to `EXPECTED_DECLARATIONS` in `test/unit/contracts/schemas.test.ts` (the catalogue list is stale relative to `IMPLEMENTATION-PLAN.md` line 198, which assigns the `ModelInfo` contract to R2.6), or otherwise amend the catalogue test's exemption list.
2. Amend Appendix A in `SUBSTRATE-PLAN.md` to add `ModelInfo`, then option 1 becomes simply fixing the stale copy.
3. Make `ModelInfo` type-only in contracts (no zod const export) — contradicts the R2.6 Interface snippet, so not recommended.

Nothing was worked around while this was open; the owner resolved it with option 1, as recorded at the top.

## R2.7 — `substrate models --provider/--refresh` cannot reach the command through the bundle

**Status: RESOLVED by owner on 2026-10-18.** The owner directed option 1: `provider` (string) and `refresh` (boolean) were added to `CLI_OPTIONS` in `src/cli/dispatcher.ts` with two optional `ParsedCliFlags` fields and the `flags` mapping, exactly as `from`/`run` are done; `models.ts` reads `ctx.flags`. `models --provider claude` and `--refresh` are now provable E2E through the bundle (`test/e2e/models.test.ts` drives both flags through `dist/substrate.mjs`), the full suite is green, and R2.7 was committed. Original analysis below.

### The conflict

`docs/plan/wp/R2.7.md` Interface: `substrate models [--provider claude|opencode|agy] [--refresh] [--output-format json|text]`, and the guardrail requires the command to be proven "through the bundle with fake harnesses". But in `src/cli/dispatcher.ts`:

- `CLI_OPTIONS` (lines 72–95) contains no `provider` or `refresh`; `parseCliArgs` copies parsed values into `flags` only for known options, and its `ParsedCliFlags` has no `provider`/`refresh` fields.
- `runCli` (lines 260–264) exits 2 with `Error: Unknown option '--provider'` for any command except `bench`.
- `CommandContext.rawArgs` is `positional`, and `parseArgs` puts option values in `values`, never in positionals — so `--provider`/`--refresh` can never appear in `rawArgs` from the bundle either.

The established pattern for command-local flags is membership in `CLI_OPTIONS` plus a `flags` mapping (`from` for `agents import`, `run` for `verify`; `agents.ts` reads `ctx.flags.from`). R2.7 would need the same two entries in `src/cli/dispatcher.ts`, a file it does not list.

### Evidence (bundle, 2026-10-18)

```
$ node dist/substrate.mjs models --provider claude
Error: Unknown option '--provider'
exit=2
$ node dist/substrate.mjs models --refresh
Error: Unknown option '--refresh'
exit=2
```

The edge-case message the spec wants (`Error: unknown provider foo`, exit 2) is emitted by the command, so `--provider` must reach the command with its value; the dispatcher currently prevents that.

### Options for the owner

1. Add `provider` (string) and `refresh` (boolean) to `CLI_OPTIONS` in `src/cli/dispatcher.ts` and map them into `flags` with two optional `ParsedCliFlags` fields, exactly as `from`/`run` are done; `models.ts` reads `ctx.flags`. About 4 lines in one file outside R2.7's lists. This makes `models --provider claude --output-format json` and `--refresh` provable E2E through the bundle. Recommended.
2. Have `models.ts` scan `ctx.rawArgs` for the flags: passes integration tests that construct `rawArgs` directly, but through the bundle the options are still rejected by the dispatcher before the command runs, so the Interface line can never be proven E2E. Not recommended as a standalone fix.
3. Relax the strict gate to pass unknown options through to `rawArgs`: changes behaviour asserted by earlier WPs' tests for every command. Not recommended.

Nothing was worked around while this was open; no file outside R2.7's lists was touched until the owner resolved it. The owner resolved it with option 1, as recorded at the top.

## R2.8 — Done-when #5 is unsatisfiable for one of the two allowlist entries

**Status: RESOLVED by the user on 2026-10-19** (instruction: "continue, finish the whole thing"). The implementer applied option 1, per the R1.6 precedent: the `rebuildFromEvents` entry was deleted (its symbol is genuinely consumed by R2.8 `--rebuild`), the `aggregateLedger` entry was re-targeted to `until: "DEFERRED"`, and both gate-forced edits outside R2.8's lists (the `docs/reference/cli.md` Deviation and the two stale integration-test assertions) were ratified as recorded Deviations. R2.8 completed and committed with these recorded in its `PROGRESS.md` Notes. Original analysis below.

### The conflict

`docs/plan/wp/R2.8.md`, Done-when requires **both**:

1. `npm run check` exits 0 once R2.8 is DONE in `docs/plan/PROGRESS.md`, **and**
2. Delete the two entries in `scripts/debt-allowlist.json` whose `until` is R2.8.

The two entries are:

- `rebuildFromEvents` (`src/ledger/usage.ts`) — **can be deleted legitimately.** R2.8 consumes it: `src/cli/commands/usage.ts` calls it for `--rebuild`. This is proven: with both entries deleted, the gate flagged only `aggregateLedger`, not `rebuildFromEvents`.
- `aggregateLedger` (`src/ledger/index.ts:79`) — **cannot be deleted, and cannot be consumed.** Once R2.8 is marked DONE, `applyAllowlist` treats an entry referencing a completed work package as a stale entry that must be removed; but removing it makes `check-wired` fail, because nothing in `src/` consumes the symbol — its only consumers are test files, which `check-dead-exports` does not count. The two exits R2.8 has from this trap are both barred by its own spec:
  - consuming `aggregateLedger` in the command contradicts R2.8's guardrails ("The command only reads the usage ledger that R1.4 writes"; "Every number must come from `groupUsage`") — `aggregateLedger` returns `CostSummary` shapes (`by_role`/`by_class`/`by_tier`), which no R2.8 output uses;
  - removing the symbol outright is barred because `src/ledger/index.ts` is in R2.8's protected-files list.

So at commit time the choice is: delete the entry → `check-wired` FAIL (dead export); keep it → `applyAllowlist` FAIL (stale entry for a DONE WP). Either way Done-when #4 cannot exit 0.

The trap comes from `scripts/check-dead-exports.mjs`'s `MAPPING_TABLE` (R0.6), which assigns `aggregateLedger` to R2.8 on the assumption that R2.8 consumes it — an assumption R2.8's own guardrails make impossible.

### Evidence (2026-10-19)

With both `until R2.8` entries deleted (as clause 5 demands):

```
$ npm run check
wired: FAIL (exit code 1)
dead-export src/ledger/index.ts:79 aggregateLedger
```

With only `rebuildFromEvents` deleted (consumed) and the `aggregateLedger` entry restored, while R2.8 is not yet DONE, the whole check passes — and it also passes with the pending docs deviation applied:

```
purity: OK
wired: OK
events: OK
settings: OK
boundaries: OK
docs: OK
```

The full suite is green: 1225 passed | 2 skipped (107 files).

### Options for the owner

1. Follow the R1.6 resolution: leave the `aggregateLedger` entry and re-target its `until` to `DEFERRED`, so the entry stays until a work package actually consumes the symbol or the protection on `src/ledger/index.ts` is lifted. R2.8 records this as a Deviation in its `PROGRESS.md` Notes. Recommended.
2. Lift the protection on `src/ledger/index.ts` for R2.8 and delete `aggregateLedger` from it. This resolves the dead export permanently but requires editing a protected file.
3. Direct R2.8 to consume `aggregateLedger` anyway (e.g., as the source of the `total` row). This contradicts R2.8's guardrails and is not recommended.

### State of the work

The full R2.8 implementation is present in the working tree, uncommitted, and ready to commit as `R2.8: substrate usage` once this entry is resolved: `src/ledger/usage.ts` (extended), `src/cli/commands/usage.ts` (created), `src/cli/commands/cost.ts` (re-export only), `src/cli/dispatcher.ts` (flags), the unit tests, fixture, and E2E test. Files touched outside R2.8's write/create lists, pending ratification as Deviations: `docs/reference/cli.md` (the `### cost` section rewritten as `### usage` with the `cost` alias note — required by the docs gate, per the R1.4 precedent), `test/integration/cli/flags.test.ts` (stale assertion: `parseCliArgs(["cost", ...])` now resolves to the primary name `usage`, per the R1.2–R1.7 stale-test precedent), and `test/integration/cli/commands.test.ts` (stale cost block updated per the same precedent). In `scripts/debt-allowlist.json`, the `rebuildFromEvents` entry was deleted (legitimately, as proven above) and the `aggregateLedger` entry was left in place, pending the decision on this entry.

## R2.9 — two Done-when clauses cannot both hold (allowlist deletion vs the dead-export gate; Interface vs the contract catalogue test)

**Status: RESOLVED on 2026-10-19 under the standing user instruction "continue, finish the whole thing", following the ratified precedents.** Conflict A was resolved by the R1.6/R2.8 precedent (option 1): the `appendRouteOutcome` entry was left in place with `until` re-targeted to `DEFERRED`, because R2.9 cannot consume the symbol. Conflict B was resolved by the R2.6 precedent (option 1): `ProfileSlot` and `Profile` were added to `EXPECTED_DECLARATIONS` in `test/unit/contracts/schemas.test.ts` with a comment citing this entry. R2.9 completed and committed with both recorded as Deviations in its `PROGRESS.md` Notes, together with the gate-forced `docs/reference/config.md` headings. Original analysis below.

### Conflict A — the `until: R2.9` entry cannot be deleted because nothing can consume it

`docs/plan/wp/R2.9.md`, Done-when requires **both**: `npm run check` exits 0 once R2.9 is DONE, **and** delete every `scripts/debt-allowlist.json` entry whose `until` is R2.9. The only such entry is `appendRouteOutcome` (`src/roles/router.ts`), and R2.9 cannot consume it: `RouteOutcomeRecord` (contracts line 22) requires `run_id: RunId`, while `routeRequest`'s `RouteRequestOptions` (router.ts lines 15–20) carries only `prompt`, `flags`, `settings` and `repoRoot` — the router has no run identifier, so consuming the ledger append inside `src/` would require inventing one. Its only consumers are test files, which `check-dead-exports` does not count. Deleting the entry therefore makes the gate fail; keeping it becomes a stale entry once R2.9 is DONE.

Evidence (2026-10-19), with the entry deleted as the delete clause demands:

```
$ npm run check
purity: OK
wired: FAIL (exit code 1)
dead-export src/roles/router.ts:275 appendRouteOutcome
FAIL: 1 violation(s)
```

With the entry re-targeted to `DEFERRED` (the R1.6 resolution), `npm run check` exits 0.

### Conflict B — the Interface-mandated contracts are outside the hard-coded catalogue list

`docs/plan/wp/R2.9.md` Interface mandates `export const ProfileSlot = z.object(...)` and `export const Profile = z.object(...)` in `src/contracts/index.ts`. `test/unit/contracts/schemas.test.ts` asserts contracts export exactly its hard-coded `EXPECTED_DECLARATIONS` list ("No added contract-type schemas beyond Appendix A"), and neither name is in Appendix A (`SUBSTRATE-PLAN.md`); the test file is in neither R2.9's write nor create lists. Same shape as the R2.6 `ModelInfo` conflict, which the owner resolved by adding the name to the list.

Evidence (2026-10-19), before the list was amended:

```
$ npm test
FAIL test/unit/contracts/schemas.test.ts > exports exactly the Appendix A declarations (no renames, no extras)
AssertionError: expected [ 'ProfileSlot', 'Profile' ] to deeply equal []
```

After the two names were added with a comment citing this entry, the test passes and the full suite is green: 1254 passed | 2 skipped (109 files).

### Gate-forced edits outside R2.9's lists

- `docs/reference/config.md` needs `### profiles` and `### defaults` headings: `scripts/docs-check.mjs` derives the Settings key list by importing `src/contracts/index.ts` at run time, so a new Settings key without a heading fails the docs gate. The file is not in R2.9's lists; the headings were added per the R1.4 precedent.
- `resolvePlannerRoute` has no `src/` consumer until R3.1 (the planner spawn, per `IMPLEMENTATION-PLAN.md` line 221 and the `MAPPING_TABLE` entry already assigning `runPlanner` in `src/roles/planner.ts` to R3.1), so a `dead` allowlist entry with `until: R3.1` was added. `TASK_CLASSES`, `slotForClass` and `escalationChain` are live: L015 uses `slotForClass`, and `resolveTaskRoute` uses `escalationChain` and `slotForClass`.

## R4.6 — `--stats` cannot reach `models` without a dispatcher edit (resolved by the R2.7 precedent)

**Status: RESOLVED by precedent on 2026-10-19; work continued under the user instruction to continue on progress.json.** `docs/plan/wp/R4.6.md` Interface requires `substrate models --stats [--since 30d] [--output-format json]` and Done-when 3 requires it to run through the built CLI. `src/cli/dispatcher.ts` rejects any option that is not in `CLI_OPTIONS` (`Error: Unknown option '--stats'`, exit 2), and that file is not in R4.6's write list. The R2.7 entry above is the same conflict, and the owner ratified option 1 there: add the flag to `CLI_OPTIONS`, `ParsedCliFlags` and the `flags` mapping, exactly as `refresh` is done. R4.6 did that for `stats` (3 lines, no other change to the file). `since` was already registered by R2.8.

Other facts for the reviewer: no entry in `scripts/debt-allowlist.json` had `until: R4.6`, so Done-when 5 deleted nothing. A first, uncommitted attempt at R4.6 left corrupted edits (a `TODO` stub and broken syntax) in `src/cli/commands/models.ts`, `src/cli/model-catalog.ts` and `src/ledger/usage.ts`; they were reverted to HEAD before the real implementation.

## R5.1 — deviations, and findings for R5.3 (nothing here blocks R5.1)

**Status: R5.1 completed.** These are recorded so the owner can ratify the deviations and R5.3 can act on the findings.

### Deviations (files outside R5.1's lists, or choices the spec left open)

- `test/e2e/helpers/run-substrate.ts` (not in R5.1's lists) was changed so `result.events` and `result.runDir` come from the run directory this invocation created. Before, the helper took the lexically last directory, but run ids are random, so any test that makes two runs in one repo read the wrong run's events about half the time. `test/e2e/archive.test.ts` (R4.4) failed in two of five full `npm test` runs because of this (`expected +0 to be 1` on the second run's `exit_code`). With the fix it passed 8 of 8 repeated runs and the full suite passed. A resume creates no new directory, so the helper falls back to all directories and picks the newest `events.jsonl`.
- `scripts/docs-check.mjs` `DOC-CMD` and the older `missing_cli_doc` rule count a command module beside the dispatcher only if `src/cli/dispatcher.ts` loads it (today: `bench`). The spec reads only `src/cli/commands/*.ts`; `bench` lives outside that directory, so a strict reading would flag a command that works. `src/cli/agents-import.ts` is not loaded by the dispatcher, so its `agents:import` / `agents-import` names register nothing. A test in `test/unit/scripts/docs-check.test.ts` covers both cases.
- `DOC-KEY` checks the dotted keys of the new `## Settings key index` table in `docs/reference/config.md`. Schema keys the engine does not read are described in prose and left out of the table, not put on the debt allowlist.
- `assets/prompts/README.md` is protected and has no row for the new `assets/prompts/caller/` directory (its Layout tree and the Variables and spawn tables). No check currently requires it. The owner may add `caller/substrate-caller.md` to the Layout tree.
- No entry in `scripts/debt-allowlist.json` had `until: R5.1`, so Done-when 5 deleted nothing.

### Findings from documenting the code (for the R5.3 wiring audit)

Reported by the documentation agents while reading the code and running the built CLI. The ones marked verified were re-checked by the lead.

- Verified: `agents:import` and `agents-import` are not reachable. The dispatcher never loads `src/cli/agents-import.ts`, so either word becomes a run prompt and starts a run. `agents import --from <claude|opencode>` (two words) works through `src/cli/commands/agents.ts`. The documentation lists only the two-word form.
- Verified: the governor is still called by `src/roles/router.ts` and `src/engine/actions/route.ts` when `roles.governor.enabled` is true. It is off by default.
- Verified: the OpenCode adapter writes `opencode.json` and an agent file into `req.cwd` (the task worktree), which R4.3 Behavior 2 forbids.
- Reported, not re-checked: `bench` does not pass `--dry-run` through, and its per-attempt costs are fixed per arm, so its printed costs and pass rates are not measurements.
- Reported: `config get <unknown key>` prints `undefined` and exits 0. `substrate --resume <id>`, `-c` and `--fork-session` with no command print help.
- Reported: `config set backends.opencode.provider.base_url <url>` without `--local` writes the key to `settings.json`, after which every command exits 2. The OpenCode error text names `backends.opencode.extra.base_url`, but the key read is `backends.opencode.provider.base_url`.
- Reported: built-in defaults (`routing.feature`, `roles.worker`, both claude) beat profile routes, so a profile does not reach the feature class or the solo worker. A profile named other than a backend pauses with `backend_unavailable`, which exits 3, the same code as `needs_input`.
- Reported: `--allowed-tools`, `--disallowed-tools` and `--timeout` write settings keys that nothing reads. A solo run on the local route verified with zero tokens.
- Reported: settings keys accepted by the schema but not read by the engine: `budgets.run.max_wall_min`, `execution.strategy`, `git.branch_prefix`, `permissions.allow|deny|ask`, `roles.reviewer.*`, `roles.worker.effort`, `sandbox.network`, `routing.*.budget.*`, `hooks.*`, `backends.*.extra` (except `customBaseUrl`).
- Reported: the installed agy is 1.4.2 and the pin is 1.4.0, so `doctor` reports a mismatch.

## R5.2 — deviations and decisions

**Status: R5.2 gate and tests changed; live smoke not run (it spends money).** These are recorded so the owner can ratify them.

- `test/live/helpers.test.ts` was created although it is not in R5.2's create list. It gives the live helpers non-spending unit coverage. Precedent: R1.6, R2.7, R2.8, R2.9.
- The gate reads "any `skipped` record for an installed harness" as "the latest record for an installed harness is `skipped`". Reason: the record file is append-only and a plain `npm test` appends skipped rows, so a literal "any skipped record ever" reading would make the gate unpassable for good. Consequence: a plain `npm test` run after a live pass makes the gate fail until `npm run test:live` is run again. The order for the owner is `npm test`, then `npm run test:live`, then `npm run gate:g5`.
- The cost cap is enforced by the engine budget, which pauses after the call that crosses the cap. One call may therefore overshoot `$0.25` before the run stops.
- The `test:live` pin check uses `backends.<x>.version_pin` when it is set. The gate uses the adapter's capability pin. The two agree in practice.
- The opencode adapter returns the raw `--version` stdout as the version on a pin mismatch, so a `failed` record may hold a non-semver string.
- The gate orders each harness's records by `ts` (equal `ts` keeps file order), not strictly by file position. The spec text says "file (append) order", but the existing test "a later record is judged by ts, not by array position" asserts `ts` order, and it was kept. The two agree for records appended by a live clock.
- Owner-approved pin bump (interactive prompt, 2026-10-19): the claude version pin moves from 2.1.301 to 2.1.304 and the agy pin from 1.4.0 to 1.4.2, the versions installed locally, so the live smoke can run for all three harnesses. The opencode pin (2.0.21) is unchanged. The edits are in `src/backends/adapters/` (`claude.ts`, `agy.ts`) and in the fake-harness fixtures (`test/fixtures/fake-harness/`), which are outside R5.2's write list. The live smoke itself is the verification that the new versions work.

- Owner-approved (interactive prompt, 2026-10-19): effort-suffixed model ids (`-low`, `-medium`, `-high`) with no price entry of their own are priced at the base id's rates when the base is priced. The edits are in `src/backends/pricing.ts`, `src/backends/normalize/agy.ts` and `src/cli/model-catalog.ts`, and in their tests and docs; these are outside R5.2's write list. The mapping applies to every backend's cost computation (claude, opencode, agy), not only agy. Historical ledger rows keep `cost_source: unknown`. The mapping is an approximation, because a higher effort tier may bill differently.

- Owner decision (2026-10-19, binding; security hardening is out of scope per DECISIONS A6): Substrate launches all three harnesses with permissions bypassed by default. The claude adapter emits `--dangerously-skip-permissions` in place of `--permission-mode dontAsk`, drops `--allowedTools` and keeps `--disallowedTools` (the Agent tool and the converted deny rules). The opencode adapter adds `--auto` to `run`. The agy adapter adds `--dangerously-skip-permissions` after `--mode accept-edits`. The engine's `permission_mode` stays an approval gate (`src/engine/actions/approve.ts`) and no adapter reads it. Files changed: `src/backends/adapters/{claude,opencode,agy}.ts`, their tests (`test/unit/backends/{claude-args,normalize-claude,agy-adapter}.test.ts`, `test/e2e/adapters.test.ts`, `test/live/claude-args.test.ts`, `test/integration/backends/opencode.test.ts`) and the docs (`docs/reference/{adapters,cli,config,caller-guide}.md`, `assets/prompts/caller/substrate-caller.md`, `research/01-harness-conventions.md`). These are outside R5.2's write list. They contradict `docs/plan/wp/R2.3.md` (~line 75, `--permission-mode dontAsk ... --allowedTools`) and `docs/plan/wp/R2.5.md` (~line 63, `--mode accept-edits` alone), which are left as historical text.
- NOT VERIFIED live: whether claude still enforces `--disallowedTools` under `--dangerously-skip-permissions`; whether opencode's deny entries hold under `--auto`; agy has no deny mechanism at all. The git-safety guard in DECISIONS A6 (workers must not git commit, push, checkout, reset, rebase or clean) therefore rests on the engine, not on the harness.
- Finding for R5.3: the opencode adapter maps the deny `git commit` to an action literally named `git commit`, which is probably a no-op. It should be a shell action with a resource pattern. Verify with a free opencode experiment.
- Finding for R5.3: the roles still pass `allow: [runDir|worktree]`, which no adapter uses now. The CLI flags `--allowed-tools` and `--disallowed-tools` still reach nothing.
- Pending owner approval, free or cheap live experiments: (1) does claude honour `--disallowedTools "Bash(git commit*)"` under `--dangerously-skip-permissions`; (2) does `--auto` clear opencode's `external_directory` ask; (3) does agy commit under bypass.
- `test/live` gained an optional per-harness model override (`SUBSTRATE_LIVE_MODEL_<HARNESS>`) because `opencode models --standalone` lists nothing on the owner's machine while their login works through their opencode service. An override must be priced or the test fails before any call.
- Finding for R5.3: the shipped price table (`src/backends/default-pricing.ts`) has no entries for OpenCode Go/Zen models. `opencode-go/deepseek-v4.1-flash` is $0.15/$0.60 off-peak and $0.30/$1.20 peak per Mtok per opencode.ai/docs/go. OpenCode Go is a flat $10/month subscription, so the token prices are nominal. The standalone model listing returning nothing is an adapter-visible gap: the adapter treats empty stdout as zero models.

- Root cause and fix (R5.2 fix, 2026-10-19): opencode 2.0.21 rejects any session id that does not start with `ses`. opencode's own log has `level=WARN message="schema rejection" ... reason="Expected a string starting with \"ses\"" at ["sessionID"]` at 23:42:10Z and 23:54:18Z. The engine generates bare UUIDs (`src/engine/actions/task.ts:76`, `solo.ts:79`, `replan.ts:600`, `src/roles/planner.ts:424`), and the opencode adapter passed them to `-s` unchanged, so opencode exited at once. Fix: `toOpenCodeSessionId` in `src/backends/adapters/opencode.ts` maps a UUID to `ses_` plus its 32 hex digits and leaves `ses...` ids unchanged; it is applied to `-s` for new, resume and fork requests, to the reported session id, and to the export lookup.
- The two earlier failed opencode attempts (the Go model and the free model) were caused by this same rejection, not by the models. Both cost $0.
- Finding for R5.3: the opencode adapter discards the harness's stderr on the spawn path. `src/backends/process.ts:354` collects `stderrTail`, but `src/backends/adapters/opencode.ts` reads it only in `validateEnvironment`. The rejection above was visible only in opencode's log file, not in Substrate's output.
- Finding for R5.3: the planner's git deny names (`git commit`, `git push`, `git checkout`, `git reset`, `src/roles/planner.ts:104-107`) reach opencode as unmapped action names. Probe: `opencode debug agents` (exists) listed `[]` for a probe agent written in the adapter's format, so the deny entries could not be confirmed from that command. Whether they hold under `--auto` is still unverified.
- Test gap, now closed: the integration tests ran against a fake opencode that did not validate session ids, so they could not catch this. The fake (`test/fixtures/fake-harness/dialects/opencode.mjs`) now exits 1 with `Expected a string starting with "ses"` on a non-`ses` `-s` id, in both its CLI entry and `runDialect`.
- Root cause and fix (R5.2 fix 2, 2026-10-20): the opencode adapter spawns `opencode run ... --agent agent_x` with the Node `cwd` option set to the run directory, but Node's `cwd` does not update the child's `PWD`. opencode 2.0.21 resolves its project directory from `PWD`, not from getcwd, so it looked for `.opencode/agents/agent_x.md` under the parent's directory and answered `Session.AgentNotFoundError`. Verified with a free experiment: the identical agent file is found when `PWD` is the run directory and not found when `PWD` is the repo root. Fix: `spawnSupervisedProcess` in `src/backends/process.ts` (`env = { ...env, PWD: path.resolve(options.cwd) }` when `options.cwd` is set, lines 236-241). Callers that pass `cwd`: `src/backends/adapters/opencode.ts` (`--version` probe with `process.cwd()`, and the run at ~line 695 with `req.cwd`), `src/backends/adapters/claude.ts:263` (`req.cwd`), `src/backends/adapters/agy.ts:208` (`process.cwd()`, `--version` probe) and `:260` (`req.cwd`), and `test/conformance/fake-adapter.ts:84` (`req.cwd`). Their `env` semantics are unchanged.
- The two opencode live failures after the session-id fix (the Go model and the free model) were this agent-lookup problem, not the models. Both cost $0.
- Test coverage added: `test/unit/backends/process.test.ts` (child `PWD` equals the resolved cwd, with and without `options.env`, a `PWD` in `options.env` is overridden, and no change without `cwd`); `test/integration/backends/opencode.test.ts` (adapter run from a nested run directory while the test process directory differs, and the fake run directly with a wrong `PWD` reporting `Agent not found` with exit 1). The fake opencode (`test/fixtures/fake-harness/dialects/opencode.mjs`, `agentLookupError`) now resolves a custom `--agent` name from `$PWD/.opencode/agents/<name>.md`, and answers the real CLI's `{"type":"error",...,"message":"Agent not found: \"<name>\""}` line with exit 1 when it is missing. Built-in agents (`build`, `plan`, `general`, `explore`) are exempt. All existing fake-harness tests kept their assertions.
- Note on `spawnSupervisedProcess` with `options.env`: the child env is `{ PATH, ...options.env }`, so every other variable, including HOME, is dropped. Claude and agy build their own env that includes HOME and the other allowed variables. Opencode passes `req.env`, and no `SpawnRequest` in `src/` sets `env`, so no current caller relies on it. Not changed in R5.2.
- Finding for R5.3: the free Zen route returns provider.auth 403 (`OpenCode's free tier can only be used from within OpenCode`) from the CLI, so a live opencode smoke needs an authenticated provider. `opencode auth list` reports no authenticated integrations on the owner's machine, so the Go login is not visible to the CLI. Alternative: the owner's local llama.cpp provider.
- Finding for R5.3 (fake harness): the fake opencode now validates agent lookup from `PWD`, so a regression of this kind fails in the integration suite and not only in the live smoke.
- Real-path check after the PWD fix (2026-10-20, one run, free: the model `opencode/no-such-model-xyz` is not reachable, so no call was billed): with the real opencode 2.0.21 on PATH, `test/live/smoke.test.ts -t "toy repo (opencode)"` failed as expected with `worker_crashed`, and the opencode log lines written by the run show `ModelUnavailableError: Model unavailable: opencode/no-such-model-xyz` under the run directory of the toy repo. The new log lines contained no `AgentNotFound` and no `Agent not found`. The line `provider.no-route` did not appear; the model error was `Model unavailable` instead. The settings file was restored from its backup and matched it byte for byte. Note: the `.substrate/settings.json` pricing edit for the experiment was reverted.

- Root cause of live attempt 2026-10-20 01:36 UTC (run `r_4XPZLEJWG3Q4`, model `llama.cpp/qwen3.8-flash-next-iq2_xs`, opencode 2.0.21, failed in 11 ms, cost $0): the local-provider early return in `spawn()` (`src/backends/adapters/opencode.ts`). The model is local (`llama` in the id) and no base URL reached the adapter, so no child process was spawned. The toy repo overlay sets only `bin` and models, and the provider is read only from `.substrate/settings.local.json`, which the toy repo did not have. The message text named `backends.opencode.extra.base_url`, which the code does not read, and the early return wrote nothing to stderr, so the evidence directory `opencode-2026-10-20T01-36-10-122Z` had no reason.
- Fix (R5.2 fix 3, 2026-10-20, owner-approved): the live helper now writes the toy repo's `.substrate/settings.local.json` with `backends.opencode.provider` (id `llama.cpp`, `@ai-sdk/openai-compatible`, the endpoint, and a `models` entry for the model key) when the opencode live model is a local route. The endpoint comes from the new env var `SUBSTRATE_LIVE_OPENCODE_BASE_URL`, and the live test fails before any run, with a failed record and no spend, when it is missing. `backends.opencode.extra.customBaseUrl` was not used: it generates provider `local` with no `models` table, so `-m llama.cpp/<model>` would not resolve.
- Deviation: `test/live/helpers.ts`, `test/live/smoke.test.ts`, `test/live/helpers.test.ts` and the adapter's message and warn line in `src/backends/adapters/opencode.ts` are outside R5.2's write list. The owner approved the change in the session. The adapter message now names `backends.opencode.provider.base_url` in `.substrate/settings.local.json` and `backends.opencode.extra.customBaseUrl`, and the same reason is written once to stderr as a `[substrate] warn:` line. The unit test that pinned the old text was updated. The docs (`docs/reference/local-model.md`, `docs/reference/adapters.md`) document the new variable and the new text. The example host in the docs is a placeholder, not the owner's LAN address.
- Finding for R5.3: the engine drops the planner failure message (`src/engine/actions/plan.ts`, about L379), so the true reason, here the adapter's `error` event, never reaches `task.failed`. Live evidence showed only the generic failure.

## R5.2 — live smoke attempt 1 (2026-10-19), not passed

**Status: R5.2 stays TODO.** The owner-approved live smoke (`npm run test:live`) ran once. G5 is not met. Every further live run needs a fresh owner go-ahead.

### Results

- claude (pin 2.1.304): failed with `spec_invalid` (planner format retries exhausted). Cost recorded: $0.0271.
- opencode: failed with "lists no model; no run was made". Nothing was spent. A later read-only probe, `opencode models --standalone`, printed no output and exited 0.
- agy (pin 1.4.2): failed with `worker_crashed`. The model `claude-opus-4-6-thinking` was picked as "cheapest" because none of agy's six listed ids has a price, so the pick fell back to alphabetical order. Tokens were used, but the cost is unknown because the model is unpriced.

### Verified and unknown

- Verified: each harness's installed version matched its pin, because claude and agy reached a model call and opencode reached its listing. The claude cost ($0.0271) is recorded in the record file.
- Verified: agy's cost is unknown because its model is unpriced.
- Unknown: why claude returned `spec_invalid`, and why agy crashed in its worker. The toy repo and its `.substrate/runs/<id>/` were deleted by the test cleanup, and the CLI output carried no failure detail, so there is no evidence to diagnose from.
- Changed for the next attempt: `test/live/helpers.ts` now copies failure evidence (run directory, usage ledger, CLI stdout and stderr) to `live-smoke-evidence/` next to the record file before cleanup, and puts the first failure event in the assertion message.

### Owner actions needed

(a) Configure an opencode provider (for example log in with opencode) so that `opencode models --standalone` lists models.

(b) Give a rate for an agy model under `pricing.models` in `.substrate/settings.json`. agy lists only effort variants (`gemini-3.8-flash-high/-medium/-low`) and claude and gpt-oss ids, while the price table has the base `gemini-3.8-flash` only. Alternatively, decide that price lookup should map effort-suffixed variants to the base id. That is a src change for R5.3 or an owner decision.

(c) The cause of the claude `spec_invalid` is unknown. `src/engine/actions/plan.ts:378` maps every non-session PlannerFailure to `spec_invalid` and drops `PlannerFailure.diagnostics`. Finding for R5.3: record the diagnostics in the `task.failed` event.

(d) Reported by the owner, not reproduced: seven fake-harness e2e `substrate run` processes (cwd `/tmp/substrate-e2e-*`, last event `task.failed` with `verify_failed`) never exited and kept polling `git diff --stat`, burning CPU for hours. So the engine does not exit after `task.failed` in that scenario, and the test teardown does not reap them. No such process was running when checked on 2026-10-19. Finding for R5.3.

(e) `src/backends/adapters/agy.ts:82` still prints "agy 1.4.0" in the effort warning after the pin moved to 1.4.2. The text is pinned by a test, so it changes with that test.

## R5.2 — resolved

`npm run gate:g5` exited 0 on 2026-10-20. Each installed harness has a passed latest record at its installed version (the pin):

- agy 1.4.2, gemini-3.8-flash-low, run r_WWBRM5FYV4OO, $0.1191
- claude 2.1.304, claude-haiku-5-5, run r_N7J7HVPQVZ6O, $0.0581
- opencode 2.0.21, llama.cpp/qwen3.8-flash-next-iq2_xs, run r_5NRXQ2HSJMUR, $0.0000 (the owner's local llama.cpp server)

The three live opencode failures before the pass, in order:

1. Bare-UUID session id: opencode 2.0.21 rejects session ids that do not start with `ses`. The adapter now maps them (`toOpenCodeSessionId`).
2. Stale child PWD: the child kept the parent's PWD, so the per-run agent was not found. `spawnSupervisedProcess` now sets PWD to the run directory.
3. Local-route base URL: the live helper did not supply the local provider base URL, so the adapter returned before spawning a child. The helper now writes it from `SUBSTRATE_LIVE_OPENCODE_BASE_URL`.

The free hosted route `opencode/deepseek-v4.1-flash-free` returns 403 from the CLI (the free tier can only be used from within OpenCode), so it cannot be used for the live test.

R5.3 inherits the open findings already recorded in this file: the items marked "Finding for R5.3" in `## R5.1 — deviations, and findings for R5.3` and `## R5.2 — deviations and decisions`, the three pending owner-approval experiments in the deviations section, and owner actions (c), (d) and (e) in `## R5.2 — live smoke attempt 1 (2026-10-19), not passed`.
