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


## R5.3 — E2E matrix findings

Scope note: `docs/plan/BLOCKED.md` is outside the R5.3 write list (`test/e2e/matrix.test.ts`, `scripts/debt-allowlist.json`, `docs/plan/PROGRESS.md`, `START-HERE.md`). Appending this section is a deviation, recorded here as the work package allows. No test helper or fixture file was created or changed.

Matrix: `test/e2e/matrix.test.ts`, run on the fake PATH with `dist/substrate.mjs` bundled. It has 24 rows and 59 row-by-dialect cases, plus one table test. Result: 57 passed, 3 failed (`Tests 3 failed | 57 passed (60)`). The printed line is `E2E matrix: 24 rows, 59 row x dialect cases`. The three failures are the S11 boundary row on each dialect. They stay red on purpose. No row is skipped.

### F1. S11 resume stalls at six event boundaries (product defect, all three dialects)

- Failing rows: `S11 [claude]`, `S11 [opencode]`, `S11 [agy]`.
- Setup: a three-task chain A, B, C. A fresh identical run is cut to its first i events and then resumed, for every i of the reference log. The assertion is exit 0 and the merged set equal to A, B, C.
- Failing cuts (same on every dialect): 9 (last kept event `setup.done`), 10 (`batch.started`), 21 (`task.merged` of A), 22 (`batch.merged`), 33 (`task.merged` of B), 34 (`batch.merged`). Every other cut resumes to exit 0 with A, B, C merged.
- Actual at each failing cut: exit 1, `run.finished` with `reason: "stalled"`, and the merged set is empty (cuts 9, 10) or A (21, 22) or A, B (33, 34).
- Cause, cuts 9 and 10: the first batch's `task.ready` events are emitted by `src/engine/actions/setup.ts:76`, after `setup.done`. `promoteReadyTasks` skips tasks with no dependencies (`src/engine/scheduler.ts:60`, `if (deps.length === 0) continue;`). The resume path re-queues only tasks in RUNNING, SCOPE_CHECK or VERIFYING (`src/engine/effects.ts`, around lines 395 to 404). So root tasks left PENDING are never released, and the loop emits the stalled finish at `src/engine/effects.ts:418`.
- Cause, cuts 21, 22, 33, 34: the stall check (`src/engine/effects.ts:412` to 418) runs before `settleDependents()`. That call sits at `src/engine/effects.ts:448`, after an action batch. So on resume, dependents of an already merged task are not promoted, and the run stalls.
- Fixture check: the fake is not the cause. Worker calls are identical, the planner count is reset to match the truncated log, and the run stalls with no action pending. Cuts that land inside an in-flight task resume correctly, so only these promotion steps are missing on resume.
- Judgment: product. Owner decision needed: the R3.2 crash-resume contract (rule 8 in the work package sense) and this row disagree. `src` is out of scope for R5.3, so nothing was changed.

### F2. The agy adapter does not pass the fake scenario path to its child (product or A6 conflict, plus a fixture gap)

- Setup: any agy row that passes the scenario through the environment option of `runSubstrate`.
- Symptom before the workaround: the planner call failed with `worker_crashed` after zero tokens, and the fake agy printed `FAKE_SCENARIO_FILE not set`.
- Cause, product: `src/backends/adapters/agy.ts:42` (`ALLOWED_ENV_VARS`) and the spawn at `agy.ts:249` build the child environment only from that allowlist plus the request env. The scenario variable from the CLI environment is dropped. DECISIONS A6 says environment scrubbing is dropped from scope, so this allowlist sits in tension with A6.
- Cause, fixture: the fake claude finds the scenario by reading the parent's environment (`test/fixtures/fake-harness/dialects/claude.mjs`, the `/proc` walk). The fake agy has no such fallback.
- Matrix workaround: agy rows point `backends.agy.bin` at a shell wrapper that exports the scenario path and runs the fake agy. This is the pattern `test/e2e/local-model.test.ts` already uses for opencode. The fake is still the only executable reached.
- Judgment: both. The owner should decide whether the allowlist stays (then the fake needs the parent-environment fallback, which is a fixture change) or goes (A6).

### F3. Planner format failures lose their diagnostics (existing item R5.2 (c), confirmed)

- Row S13 exhausted case: exit 1, `task.failed` with `failure_class: spec_invalid`, and three planner usage records. The row asserts exactly those, as the work package requires.
- The reason (for example `Failed to parse manifest.yaml`) reaches the planner's retry prompt only. It is not in any event or in stdout or stderr.
- Cause: `src/engine/actions/plan.ts:378` maps every non-session `PlannerFailure` to `spec_invalid` and drops its diagnostics. While this matrix was being built, the cause of a wrong manifest could only be found by capturing the retry argv through a wrapper.
- Not a failing row. The item stays open for R5.3, as already recorded.

### F4. The json output is one pretty-printed document (spec wording, owner decision)

- The work package says the json and stream-json outputs "parse with JSON.parse line by line". The json format writes one pretty-printed object (`src/cli/output.ts`, `JSON.stringify(payload, null, 2)`), so only the whole stdout parses, not each line.
- Row X06 asserts that the whole stdout parses as one object. Row X07 asserts that every stream-json line parses. Both pass.
- Decision for owner: read the wording as stream-json only (the matrix's reading), or change the json format to one line.

### F5. Scenario 15 differs between the two documents

- `docs/plan/wp/R5.3.md` Behavior 1, row 15: request run with no governor setting, exit 0 (row S15 follows this).
- `SUBSTRATE-PLAN.md` section 14, item 15: governor down, deterministic fallback. This is the governor path, which DECISIONS A2 retires.
- The matrix follows R5.3. Owner to confirm.

### Fixture and test notes (no product change)

- The claude fake reports version 2.1.304, which matches `CLAUDE_VERSION_PIN` in `src/backends/adapters/claude.ts:26`. The R0.2 text says 2.1.301. The fake was left as it is.
- S06 runs in bypassPermissions. Default mode pauses for approval before any worker runs (`src/engine/actions/approve.ts:66` to 77), which is not a denial. The denial pause fires in every permission mode (`src/engine/actions/task.ts:200` to 205).
- S06 leaves out opencode, because its fake emits no tool event for a denial (R0.2 behaviour 4). S07 is claude-only, because only the claude fake reports `cost_usd`.
- The S11 row resets the fake counter before each resume, and its failing cuts are reported together, not at the first failure.
- A manifest `run_id` must match the RunId alphabet `A-Z2-7` with 12 characters (`src/contracts/index.ts:4`). The first matrix draft used digits and every planner call failed for that reason. This is a fixture error, now fixed.

### Still open for R5.3 (not touched by this pass)

- `scripts/debt-allowlist.json` still holds entries with `until: "R5.3"` (for example `src/cli/index.ts`, `src/backends/adapters/opencode.ts`). Done when item 3 needs them gone, so R5.3 is not complete.
- The archive step (Behavior 4) has not been started, because the matrix does not pass and the allowlist is not clean.

## R5.3 — cleanup deviations (owner-approved 2026-10-20)

- Owner decision, 2026-10-20: R5.3 may make a scoped `src/` cleanup. It may delete dead code and unreachable files, and wire or delete the flagged settings and events. The spec freezes `src/` for this package. This decision overrides that freeze for the cleanup only.
- Plan: five waves, W0 to W4. W0 fixes the checkers and clears the false positives (this bullet list). W1 to W4 are reserved for later waves, which will append their own bullets under this heading.
- Outside R5.3's write list: the checker scripts `scripts/check-dead-exports.mjs`, `scripts/check-events.mjs` and `scripts/check-settings.mjs`, plus the test helpers and tests that cover them (`test/unit/scripts/`, `test/fixtures/check/`). W0 edits these under this heading.
- W0, checker fixes (owner-approved):
  - (a) `check-dead-exports.mjs`: the default entries now include `src/cli/main.ts`, the real CLI entry, which loads `src/cli/signals.ts` by dynamic import. This removes the false positives `exitCodeForSignal` and `installSignalHandlers`. No allowlist entries existed for them.
  - (b) `check-dead-exports.mjs`: the operand of a `typeof X` type query now counts as a use of the value X. `scripts/export-schemas.mjs` is a new consumer root: its value references keep src exports alive, and it is not scanned for dead code. Plain type-only references still do not count. This removes 12 false positives: `EVENT_TYPES` and 11 contract consts in `src/contracts/index.ts`.
  - (c) `check-events.mjs`: emitters are also scanned in `src/roles/**`, including the `onEvent?.("…")` call shape. This removes 6 consumed-not-emitted false positives (task.session.started, task.scope.checked, task.verify.started, task.verify.finished, task.healing, task.passed). It adds no new violations.
  - (d) `check-settings.mjs`: a `.leaf` property access counts as a read of a wildcard leaf (`pricing.models.*.leaf` or `routing.*.leaf`) when the same file also touches the record container (`.models` or `.routing`). This is file-scoped, not data-flow. It removes 7 false positives (4 pricing, 3 routing).
  - Allowlist: 25 entries with `until: "R5.3"` were removed from `scripts/debt-allowlist.json` (dead 12, events 6, settings 7). No other entries changed.
  - True positives are still caught. Each checker has a fixture under `test/fixtures/check/` with a seeded violation, and unit tests assert it is reported: an unused export (`dead-exports/dynamic-entry`, `typeof-query`, `consumer-root`), a consumed event with no emitter (`events-roles`), and an unread wildcard setting leaf (`settings-wildcard`). A plain type-only reference does not keep a class alive (`typeof-query`).
- **S11 resume fix (owner-approved 2026-10-20).** Files changed: `src/engine/effects.ts:16-21` (import of `unreleasedRootTasks`) and `src/engine/effects.ts:413-424` (before the loop, when the replayed state is EXECUTING, emit `task.ready` for each unreleased root and run `settleDependents()`); `src/engine/scheduler.ts:69-79` (new pure `unreleasedRootTasks`). Root cause: the resume entry replays the log but nothing re-derives the `task.ready` promotions that setup and `settleDependents()` would have emitted, so a cut after `setup.done` leaves the first batch PENDING and a cut after `task.merged` or `batch.merged` leaves its dependents PENDING, and both reach the stall check (`src/engine/effects.ts`, `reason: "stalled"`) unpromoted. Verified: before the fix `npx vitest run test/e2e/matrix.test.ts -t S11` failed at cuts 9, 10, 21, 22, 33 and 34 on all three dialects; after the fix S11 passes on all three. The new tests in `test/integration/engine/resume-promotion.test.ts` fail when the entry block is removed and pass with it. No event type or schema changed, and nothing is promoted outside a resumed EXECUTING state. Finding, not changed: `test/integration/chaos/helpers.ts` `recoverInFlightRun` appends `batch.started` and `task.ready` for PENDING tasks before resuming, which hides this bug from the in-process chaos scenario 11; the matrix row runs the real CLI and does not use it.
- **Matrix vitest worker timeout (2026-10-20).** The matrix file and the full suite passed all cases but reported `Errors 1 error`, `[vitest-worker]: Timeout calling "onTaskUpdate"`, and exited 1. Cause: the S11 row never yields, so its synchronous spawns (one reference run and about 36 cut resumes per dialect, roughly 36 s per dialect) held the vitest worker's event loop. Vitest's RPC calls time out after 60 s, and two consecutive S11 blocks with an RPC pending across them exceeded that. S11 alone for one dialect and the non-S11 rows alone did not show the error. Change: `test/e2e/matrix.test.ts` (the S11 loop, and the new `yieldToEventLoop` helper just above `chainSpec`) awaits a `setImmediate` promise before each cut, so vitest regains control about every second. No cut, assertion, row or case count changed (24 rows, 60 row x dialect cases).
- W1, scoped `src/` deletion (owner-approved 2026-10-20). Deadness was checked with `git grep` over `src/`, `test/`, `scripts/`, `bin/`, `docs/reference`, `assets/` and `package.json`. Each target had no live importer outside the files being deleted. The only exceptions were fixed as noted below.
  - Deleted files (13): `src/cli/index.ts`, `src/cli/flags.ts`, `src/store/index.ts` (barrel), `src/hooks/gate.ts`, `src/hooks/index.ts`, `src/hooks/runner.ts`, `src/hooks/types.ts`, `src/config/commands.ts`, `src/config/skills.ts`, `src/roles/prompts/worker.ts`, `src/roles/prompts/test-writer.ts`, `test/integration/hooks/gate.test.ts` (7 tests), `test/integration/hooks/runner.test.ts` (21 tests).
  - Deleted functions (3 edits): `dispatchCommand` in `src/cli/registry.ts`; `discoverCommands`, `discoverSkills`, `CommandSummary` and `SkillSummary` in `src/config/index.ts`. The rest of `registry.ts` and `config/index.ts` is unchanged.
  - Tests edited, not deleted. `test/unit/config/commands.test.ts` also covers the live agents-import path (`src/cli/agents-import.ts`), so only the commands and skills blocks were removed (16 tests). Its 7 agents-import tests remain. `test/unit/config/definitions.test.ts` loses the discovery block (3 tests) and keeps its 5 agent-loader tests. `test/unit/roles/prompts.test.ts` loses the worker and test-writer blocks (7 tests); the planner, reviewer and replan cases remain. `test/unit/store/event-store.test.ts` and `test/unit/store/run-lock.test.ts` now import `EventStoreImpl` and `RunLockImpl` from their own modules, since the barrel is gone.
  - Allowlist: 41 `dead` entries and 11 `wired` entries with `until: "R5.3"` were removed from `scripts/debt-allowlist.json`. Each was reported STALE by `check:dead` or `check:wired`. The wired entries were `src/cli/flags.ts`, `src/cli/index.ts`, `src/config/commands.ts`, `src/config/skills.ts`, `src/hooks/gate.ts`, `src/hooks/index.ts`, `src/hooks/runner.ts`, `src/hooks/types.ts`, `src/roles/prompts/test-writer.ts`, `src/roles/prompts/worker.ts` and `src/store/index.ts`. No new violation appeared. The `reviewer.ts` wired entry and all other entries are untouched.
  - Kept: the `hooks` settings key in the schema (`src/contracts/index.ts`, accepted and ignored). `docs/reference/config.md` now says "accepted by the schema and ignored" and no longer refers to `src/hooks/`. No commands or skills settings keys existed in the schema. `src/roles/prompts/reviewer.ts` and its allowlist entry are untouched, as are themes T6 to T17.

- W2a (T9, T11 and the T12 part). Deleted dead exports: `src/backends/ndjson.ts` `serializeNdjson`; `src/backends/pricing.ts` `computeUsageRecord`; `src/backends/process.ts` `terminateProcessGroup` and its private helper `isProcessGroupAlive` (the live kill path is `killProcessGroup`); `src/backends/normalize/claude.ts` `normalizeClaudeStream` (no caller in `src/`; the live claude adapter calls `normalizeClaudeEvent` per line); `src/backends/normalize/agy.ts` `normalizeAgyStream` (no caller in `src/`; the live agy adapter drives `AgyNormalizer` directly); `src/backends/adapters/opencode.ts` `generateOpenCodeRunConfig` (a thin async wrapper of the live `generateOpenCodeRunConfigSync`, which is kept); `src/util/index.ts` `isRunId`, `isTaskId`, `assertTaskId`, `assertSafePath` (`isSafePath` kept); `src/spec/parser.ts` `loadPlan`; `src/store/sessions.ts` `resolveResumeTarget` (the live resume command in `src/cli/commands/resume.ts` has its own resolution); `src/verify/runner.ts` `verifyRunner` and `src/verify/sandbox.ts` `bwrapSandbox` singletons (the classes are kept); `src/engine/engine.ts` `engine` singleton (`createEngine` kept); `src/engine/replan.ts` `resolveEscalationRoute` and its now-unused `resolveTaskRoute` import. Retargeted, not deleted: `test/unit/backends/normalize-claude.test.ts` (5 fixture tests) and `test/conformance/dialects.test.ts` (claude case) now drive `normalizeClaudeEvent` per line; `test/unit/backends/normalize-agy.test.ts` "normalizeAgyStream consumes async streams..." is now "AgyNormalizer consumes an async event sequence..." and `test/conformance/dialects.test.ts` (agy case) drive `AgyNormalizer`; `test/unit/backends/pricing.test.ts` (2) and `test/unit/ledger/pricing.test.ts` (1) use `calculateCostUsd`; `test/unit/backends/process.test.ts` "terminateProcessGroup terminates a process group standalone" is now "killProcessGroup sends SIGTERM to a process group standalone"; `test/integration/backends/opencode.test.ts` (2) call `generateOpenCodeRunConfigSync`; `test/unit/util/ids.test.ts` checks the `RunId` and `TaskId` contract schemas; `test/unit/util/paths-glob.test.ts` assertions use `isSafePath`; `test/integration/engine/replan.test.ts` escalation block (2 tests) now calls `resolveTaskRoute` in `src/roles/router.ts`, which is the live caller of `escalationChain` (`escalationChain` returns profile names, not a Route, so it is not an equivalent target); `test/integration/verify/runner.test.ts` and `test/integration/verify/sandbox.test.ts` lose their fallback lines that read the deleted singletons. Deleted tests: "serializeNdjson appends newline and serializes object" (`test/unit/backends/process.test.ts`); the 7 `resolveResumeTarget()` tests in `test/unit/store/sessions.test.ts` (live resume coverage is in `test/integration/cli/run-control.test.ts`, which asserts the same "no run or session matches" and "has no runs to resume" messages); "throws when manifest file does not exist" and "throws or reports error when referenced task spec file is missing" in `test/unit/spec/parser.test.ts` (fs errors of the dead `loadPlan`; the three `loadPlan` tests are replaced by one that uses `parseManifest` and `parseTaskSpec`). Allowlist: 16 `dead` entries with `until: "R5.3"` removed (6 for T9; `generateOpenCodeRunConfig`, `serializeNdjson`, `normalizeAgyStream`, `normalizeClaudeStream`, `computeUsageRecord`, `terminateProcessGroup`, `assertSafePath`, `assertTaskId`, `isRunId`, `isTaskId`, `loadPlan`, `resolveResumeTarget`, `verifyRunner`, `bwrapSandbox`, `engine`, `resolveEscalationRoute`); 0 `wired`, 0 `settings`, 0 `events` entries removed. Remaining `until: "R5.3"` entries: 29 (22 `dead`, 1 `wired` for `src/roles/prompts/reviewer.ts`, 6 `settings`). Left, not touched: the git module (W2b), config and permissions (W3), reviewer, `bindAbort`, `createEngine`, `roles.worker.effort`. Verification: `npm run typecheck`, `npm run check`, `npm run check:dead`, `npm run check:wired`, `npm run check:events`, `npm run check:settings`, `npm run docs:check`, `npm run bundle` and `npm test` all exit 0. The full suite reports 1518 passed and 4 skipped in 141 files; the baseline from the brief is 1528 passed and 4 skipped, so the delta of 10 is the removed tests listed above (1 + 7 + 2). The baseline was not re-run before the edits.

- W2b (T10, git dead code). Deadness was checked with `git grep -w` over `src/`, `test/`, `scripts/`, `docs/`, `assets/`, `bin/` and `package.json`. No live importer in `src/` existed for any target except the live symbols noted below. Symbols deleted (12 allowlist keys): in `src/git/merger.ts` the batch API `bisectBatch`, `runBatchMerge`, the private helper `bisectBatchInternal`, class `BatchIntegrationMergerImpl`, consts `BatchIntegrationMerger` and `batchIntegrationMerger`, the const `taskMerger`, and the types `BatchIntegrationMerger`, `BatchMergeResult` and `TaskEntry`, which typed only the deleted API. Alias consts deleted (their instances and classes are kept): `GitCommitter` in `src/git/commit.ts`; `ScopeEnforcer` and `GitScopeEnforcer` in `src/git/scope.ts`; `WorkspaceManager`, `GitWorkspaceManager`, `WorkspaceLifecycle` and `GitWorkspaceLifecycle` in `src/git/workspace.ts`. Kept: `TaskMerger` class and const (live caller `src/cli/commands/merge.ts`), the `TaskMerger` and `PreflightResult` types, `createIntegrationWorktree`, `mergeInto`, `advanceRunRef`, `verifyIn` and `preflight` (live callers `src/engine/actions/merge.ts`, `src/engine/actions/integrate.ts` and `src/cli/commands/undo.ts`), and all other `src/git` instances and interfaces. Tests deleted (5, all in `test/integration/merge/merger.test.ts`, each exclusively covering the deleted batch API): "runBatchMerge merges in order, verifies once, advances the run ref and records the pre-batch sha"; "runBatchMerge halts at a conflicting task with merge_conflict and does not advance the run ref"; "bisectBatch names the culprit in batch order and runBatchMerge stays within 1 + N verify runs"; "a single-task batch that fails verify names that task as culprit and leaves nothing merged"; "the user's checkout keeps an untracked file byte-identical across batch merge, conflict and bisect". Live coverage of the same behaviour: the live bisect in `src/engine/actions/merge.ts` is asserted by `test/integration/scenarios/scenario-10-integration-bisect.test.ts` (culprit T2 named, sibling T1 kept merged) and `test/e2e/merge-integration.test.ts` (b); the live conflict path by `scenario-09-merge-conflict-replan.test.ts` and e2e (a); the untracked-file and HEAD invariant on a passing run by e2e (c). Retargeted (not deleted), to the live instances `gitCommitter`, `scopeEnforcer`, `workspaceManager` and `workspaceLifecycle`: `test/integration/git/commit.test.ts` (4 tests), `test/integration/git/scope.test.ts` (10 tests), `test/integration/git/workspace.test.ts` (16 tests); and `test/integration/merge/preflight.test.ts` (2 tests) now constructs the live `TaskMerger` instead of the removed `taskMerger` const. Kept test: "TaskMerger keeps preflight only" in `merger.test.ts`, plus the 6 primitive tests there and the 2 preflight tests. Not ported: no small additive live test was written. Properties no longer asserted by any test: (1) the bisect scan stops at the first failing task and later tasks of the batch are never merged (live `scenario-10` asserts only the culprit identity and that the sibling stays merged); (2) the verify-run bound of 1 + N, since no live event carries a verify count; (3) the run ref is unchanged after a conflict halt or a failing batch on the live path (the live code advances the ref only after verify passes, but no live test checks the ref); (4) the untracked file and HEAD are preserved across a conflict or a bisect (live e2e (c) covers a passing run only); (5) the merge-commit parent chain in batch order. Allowlist: 12 `dead` entries with `until: "R5.3"` removed from `scripts/debt-allowlist.json`; `check:dead` and `check:wired` report no stale or new violation. Remaining `until: "R5.3"` entries after W2b: 17 (dead 10, wired 1 for `src/roles/prompts/reviewer.ts`, settings 6). Dead entries left for other themes: `applyOverlay`, `evaluatePermission`, `evaluateWorkerPermission`, `loadAgentDefinitions`, `matchPermissionRule`, `mergeSettings`, `parsePermissionRule` (config, W3), `createEngine` (kept, not touched), `buildReviewerPrompt` in `src/roles/prompts/reviewer.ts` (reviewer) and `bindAbort` in `src/engine/actions/shared.ts` (not touched).

- **W2c (test-only restoration of the live batch merge properties).** Added `test/integration/scenarios/scenario-10-batch-merge-properties.test.ts` (4 tests, live engine path through `src/engine/actions/merge.ts` over `src/git/merger.ts`, fake harness only). Each integration verify run is recorded by a command outside the user's checkout that logs the run ref sha and the integration worktree listing. Restored: (1) "a passing batch records the pre-batch sha, advances the run ref in batch order and keeps the user's checkout" (checkpoint equals the contract commit the run branch starts from, run ref advanced with one merge per task); (e) same test (first-parent chain, second parent equals each task tip, merge subjects in batch order); (d) same test for a passing batch and "a failing batch bisects in batch order, stops at the culprit, merges nothing and leaves the run ref and the user's checkout alone" for a failing batch; (a) and (b) in the failing-batch test (the bisect sequence is exactly base, batch, bisect T1, bisect T2, so T3 is never merged; three integration runs within 1 + N); (c) in the failing-batch test (every verify saw the checkpoint as run ref) and in "a merge conflict in a batch halts it without verifying or advancing the run ref, and the user's checkout is untouched" (run ref equals the checkpoint at the end, no batch or task merged, only the base check verified, HEAD and an untracked file preserved); (4) "a single-task batch that fails verify names that task as culprit and leaves nothing merged". Already covered before this wave: (1) only as a truthy run ref in `test/integration/scenarios/scenario-01-all-pass.test.ts:163-164`; the bisect culprit identity in `scenario-10-integration-bisect.test.ts:129` and matrix row S10 (`test/e2e/matrix.test.ts:592`); conflict identity in `scenario-09-merge-conflict-replan.test.ts:127` and matrix row S09 (`matrix.test.ts:563`); untracked file and HEAD in `test/e2e/merge-integration.test.ts:288-340`, passing run only; primitives in `test/integration/merge/merger.test.ts:147` and `:171`. Finding: none. Every property tested against the live path held as the deleted tests described, so no assertion was weakened or left out. Observed and not asserted: a conflicted batch pauses the run (`run.paused`, `needs_human`) and its merged sibling is not recorded as a merge. Read from the code, not run: the live bisect in `src/engine/actions/merge.ts` calls `mergeInto` without a preflight, so a conflict during bisect would throw instead of emitting an event; no test covers that path.
- W3 (T7, T8, T17 and the DEFER theme). Deadness was checked with `git grep -w` over `src/`, `test/`, `scripts/`, `docs/`, `assets/` and `bin/`. The only live reads of the deleted names were `test/live/helpers.ts` and the unit tests named below.
  - T7, permissions evaluators. Deleted from `src/config/index.ts`: `parsePermissionRule`, `matchPermissionRule`, `DANGEROUS_PATTERNS`, `evaluatePermission` and `evaluateWorkerPermission`. Deleted test file `test/unit/config/permissions.test.ts` (7 tests, all covering only these): "parses the plan §4.4 forms", "matches tool calls against rules", "deny beats ask beats allow", "allow-only match allows; ask-only match asks", "default-denies worker-dangerous tools with no matching rule", "workers treat ask as deny downstream", "rejects malformed rules instead of silently allowing". The `matchGlob` tests in `test/unit/util/paths-glob.test.ts` cover the live glob helper and are kept. `permissions.allow` and `permissions.deny` are kept.
  - T7, setting `permissions.ask`. Removed from the Settings schema (the `permissions` object in `src/contracts/index.ts`). No default, init output, asset or test sets it. Strictness finding: the `permissions` object and the top-level Settings object are both `.strict()`, and the repo has no precedent for tolerating a removed key (the `hooks` key stays in the schema). So a settings file that still has `permissions.ask` now fails validation. Observed with the built CLI in a scratch repo: `config get permissions.allow` exits 2 with an unrecognized_keys error naming `ask`. This breaks any existing user settings file that has an ask list, which must drop the key. Recorded in `docs/reference/config.md` (permissions section). The owner decision of 2026-10-19 (harnesses run with permissions bypassed) is why the key is not kept.
  - T8, config loader helpers. Deleted `mergeSettings`, `applyOverlay` and `loadAgentDefinitions` from `src/config/index.ts`, with their private helpers `parseFrontmatter` and `findAgentDir`, the exported types `AgentDefinition` and `LoadAgentDefinitionsOptions`, and the now-unused imports of `yaml` and `matchGlob`. The live layering is `foldLayers` (through `mergeOverlay` and `deepMerge` in `src/util/merge.ts`), and the live loader is `loadSettings`. `loadAgentDefinitions` was not a documented feature: `docs/reference/cli.md` describes `agents` as listing prompt sources through `listAgents` in `src/prompts/index.ts`, and no reference doc describes agent frontmatter fields such as backend, model or disallowedTools. The `agents import` path (`src/cli/agents-import.ts`) has its own parser and does not use the deleted loader. Deleted test file `test/unit/config/definitions.test.ts` (5 tests, all covering only the deleted loader): "loads frontmatter with name/description/role plus optionals", "rejects the file when name/description/role are missing, others still load", "precedence is project over user over builtin; higher wins", "duplicate names within one layer error", "never reads foreign .claude/ or .opencode/ dirs implicitly". Deleted test in `test/unit/roles/assets.test.ts`: "throws clear error when loading from a non-existent assets directory" (its only subject was the deleted loader).
  - Retargeted tests: in `test/unit/roles/assets.test.ts`, "loads all 5 built-in agent definitions via loadAgentDefinitions" is now "lists all 5 built-in agent roles from assets/agents via listAgents", which asserts the same five roles through `listAgents`. In `test/unit/config/loader.test.ts`, "higher layer wins; objects merge key-wise", "scalars and arrays replace instead of concatenating" and "skips undefined layers" now call `deepMerge`; "invalid overlay is rejected, file value is left otherwise" and the pricing case in "empty pricing.models is valid; asOf/sources/models stay required" now call `loadSettings` with a flags layer. In `test/live/helpers.test.ts`, "liveSettings" now calls `deepMerge`. `test/live/helpers.ts` (`probeSettings`) now calls `deepMerge` in place of `mergeSettings`; it was not run, since it is a live helper. Observed: the prompt loader reads only the body of `assets/agents/worker.md`, so its `disallowedTools` frontmatter key is read by no live code path; agents import reads only its own source directories.
  - T17, `roles.worker.effort`. Wired in `src/engine/actions/solo.ts`: the solo route takes `roles.worker.effort` when it is set, as it takes backend and model, and otherwise keeps the feature route's effort. The default `roles.worker.effort` ("medium") was removed from `DEFAULT_SETTINGS` in `src/config/index.ts`. Reason: the default was always present, so it would have overridden a user's `routing.feature.effort` in solo mode, a silent behaviour change. The feature route default is still medium, so solo effort with no setting is unchanged. The normal task path was not changed: `src/roles/worker.ts` and `src/engine/actions/task.ts` call `resolveTaskRoute` and do not read `roles.worker` at all (backend and model included), so the task route comes from routing and profiles, as DECISIONS A6 states. Test added: "roles.worker.effort reaches the solo worker spawn request" in `test/integration/scenarios/scenario-16-solo-mode.test.ts` (a solo run against the fake claude adapter records a worker SpawnRequest with effort high). Docs: `docs/reference/config.md` has a new `roles.worker.effort` row, and the solo worker paragraph no longer says the effort is not read. Observed with the built CLI: `config get roles.worker.effort` prints high for a scratch settings file that sets it.
  - DEFER, reviewer role (owner-approved; DECISIONS A2 keeps it as an optional role, and wiring it needs a new engine phase). `until` changed from R5.3 to DEFERRED for: dead `buildReviewerPrompt` in `src/roles/prompts/reviewer.ts`; wired `src/roles/prompts/reviewer.ts`; settings `roles.reviewer.enabled`, `roles.reviewer.backend`, `roles.reviewer.model` and `roles.reviewer.effort`. No reviewer code was deleted.
  - Allowlist, W3: 8 entries removed (dead 7 for T7 and T8: `applyOverlay`, `evaluatePermission`, `evaluateWorkerPermission`, `loadAgentDefinitions`, `matchPermissionRule`, `mergeSettings`, `parsePermissionRule`; settings 1 for T7: `permissions.ask`). 1 settings entry removed for T17 (`roles.worker.effort`). 6 entries retargeted to DEFERRED (wired 1, dead 1, settings 4). Remaining `until: R5.3` after W3: 2, both dead (`createEngine` in `src/engine/engine.ts` and `bindAbort` in `src/engine/actions/shared.ts`, for W4). By check: dead 2, wired 0, settings 0, events 0.
  - Tests: removed 13 (permissions 7, definitions 5, assets 1), added 1 (the scenario-16 effort test), retargeted 7 (loader 5, assets 1, live helpers test 1). Full suite after W3: 1505 passed, 4 skipped (1509), against the baseline of 1517 passed, 4 skipped (1521). The delta is minus 12: minus 7 (permissions), minus 5 (definitions), minus 1 (assets edge case), plus 1 (scenario-16).
  - W4 (last cleanup wave). Abort wiring (Part A): `bindAbort` moved from `src/engine/actions/shared.ts` to `src/backends/process.ts` and now takes `(signal, handle)`, because roles cannot import the engine action layer. Bound at every session spawn site, each unbound in a finally once the session ends: `src/roles/planner.ts` (runPlanner, the first planning session; the gap the new test proves; `PlannerRunOptions.signal` is passed by `src/engine/actions/plan.ts`), `src/engine/actions/plan.ts` (planner session on answers resume), `src/engine/replan.ts` (replaces its duplicate bindSignal), `src/roles/worker.ts` (replaces its inline listener; task and solo already passed the signal). `src/engine/actions/plan.ts` returns without task.failed or run.finished when the signal is aborted, so the engine loop records run.paused with reason user_cancel. Observed: SIGINT gives exit code 130, the hung planner child is gone, events end at run.paused user_cancel with no run.finished, and the run lock is released. Test: `test/e2e/interrupt.test.ts`, "planner session hung: SIGINT kills the child, exits 130 and leaves a resumable run" (passes, test body about 126 ms). With the planner bind commented out (temporary, restored and confirmed by cmp): the test fails, substrate did not exit within 10 s. The resume sub-assertion was skipped (planner resume after a cancel needs a full plan scenario; not done in W4).
  - createEngine (Part B): option (a). `src/cli/commands/run.ts`, `plan.ts`, `resume.ts` and two sites in `src/cli/dispatcher.ts` now construct the engine with `createEngine` instead of `new EngineImpl`, which is behaviour-identical, so tests and the CLI share one construction path. `createEngine` and `bindAbort` were removed from `scripts/debt-allowlist.json` (dead, R5.3). No entry with until R5.3 remains.
  - Allowlist after W4: no until R5.3 entries left (DEFERRED 15 entries; string entries of events_observe_only are unaffected).
  - Tests: added 1 (interrupt e2e). Removed 0, retargeted 0. Full suite after W4: 1506 passed, 4 skipped (1510), against 1505 passed, 4 skipped (1509); the delta is plus 1, the new interrupt test.
