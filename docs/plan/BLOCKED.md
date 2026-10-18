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
