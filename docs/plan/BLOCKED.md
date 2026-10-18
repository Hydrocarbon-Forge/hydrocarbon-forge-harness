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
