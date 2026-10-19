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
