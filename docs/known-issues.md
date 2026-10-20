# Known issues

## How to use this file

This file lists the findings that are still open after the R5.3 cleanup. It replaces the open items of `docs/plan/BLOCKED.md`, which is archived with the R-series plan. Items are ordered by importance. Each item gives what is wrong, where it is, its impact, a suggested direction, and who must decide when an owner decision is needed. Items marked "reported" were seen in a run or in the code but not reproduced again during R5.3.

## 1. Planner failure diagnostics never reach task.failed

- What: when the planner fails after its format retries, the engine emits `task.failed` with only `failure_class` (`spec_invalid`). The reason, for example a manifest parse error, goes to the planner's retry prompt only.
- Where: `src/engine/actions/plan.ts`, where every non-session planner failure is mapped to `spec_invalid` and its diagnostics are dropped.
- Impact: a wrong manifest can be diagnosed only by capturing the retry command. Live evidence from the R5.2 smoke showed only the generic failure.
- Direction: put the planner diagnostics on the `task.failed` event (a schema field, so the event catalog changes). Scenario 13 of the matrix currently asserts only the event class, so it needs an update with the change.
- Decision: engineering. The event schema change needs owner sign-off because it changes the event catalog.

## 2. Harness stderr is discarded by the opencode adapter

- What: the opencode adapter reads the harness stderr only in its environment check. On the spawn path, the stderr tail collected by the process layer is not used, so a harness error appears only in the harness's own log file.
- Where: `src/backends/adapters/opencode.ts` (spawn path); the collected tail is in `src/backends/process.ts`.
- Impact: the opencode session-id rejection of R5.2 was visible only in opencode's log. The local-route reason now reaches stderr only through the warning line added in R5.2.
- Direction: pass the stderr tail into the `error` event of the adapter, the same way the claude and agy adapters report errors.

## 3. Permissions are bypassed; the allow and deny lists are advisory

- What: by owner decision (2026-10-19) all three harnesses run with permissions bypassed. Adapters do not enforce the role `allow` lists, which the roles still pass (`runDir` or `worktree`). The planner's git-deny names (`git commit`, `git push`, `git checkout`, `git reset`) reach the opencode adapter as action names that do not map to shell actions, so they are probably no-ops.
- Where: role definitions in `src/roles/planner.ts` and `src/roles/worker.ts`; the adapters in `src/backends/adapters/`.
- Impact: the git-safety guard in DECISIONS A6 (workers must not commit, push, checkout, reset, rebase or clean) rests on the engine, not on the harness. agy has no deny mechanism at all.
- Direction: either remove the unused allow lists from roles and the CLI, or map deny entries to real harness rules. Verify the mapping with a free experiment first.
- Decision: owner. Security hardening is out of scope (DECISIONS A6), so the owner must confirm the bypass stance and whether git safety stays engine-only.

## 4. Pending live experiments (owner go-ahead needed)

Each experiment spends money or runs a real harness and needs a fresh owner go-ahead:

- Claude: whether the disallowed-tools list with a git commit rule still blocks commits under the bypass setting.
- OpenCode: whether auto mode clears the external-directory permission ask.
- agy: whether a commit succeeds under bypass (expected yes, since agy has no deny mechanism).

## 5. agy adapter passes only an allowlisted environment

- What: the agy adapter builds the child environment from an allowlist (`ALLOWED_ENV_VARS`) plus the request env. The fake agy never sees the scenario path variable, so agy tests and matrix rows use a wrapper script that exports it.
- Where: `src/backends/adapters/agy.ts` (allowlist and spawn).
- Impact: environment scrubbing is a small form of hardening that DECISIONS A6 puts out of scope. The fake harness has no parent-environment fallback for agy, unlike claude.
- Direction: owner decision. Either keep the allowlist and add the parent-environment fallback to the agy fake, or remove the allowlist.

## 6. The process environment option drops inherited variables

- What: when a caller sets `options.env`, the child environment becomes the PATH variable plus the given keys. HOME and the XDG variables are dropped.
- Where: `src/backends/process.ts` (the environment construction in the spawn helper).
- Impact: no current caller sets `options.env` for a spawn request, so there is no live effect today. A future caller would silently lose HOME.
- Direction: merge the given keys over the inherited environment, or document the replacement semantics and keep it that way.

## 7. The opencode adapter writes config files into the task worktree

- What: the opencode adapter writes `opencode.json` and an agent file into the request directory, which is the task worktree. R4.3 behaviour 2 forbids writes into the worktree.
- Where: `src/backends/adapters/opencode.ts` (the config path is set near the provider configuration code).
- Impact: the files can end up in a task's diff, which the scope check then sees.
- Direction: write the files into the run directory and point the harness at them, after checking how opencode finds its project directory (the PWD fix of R5.2 relies on the run directory).

## 8. Cost rates for effort-suffixed model ids are an approximation

- What: a model id with an effort suffix (`-low`, `-medium`, `-high`) with no price entry is priced at the base id's rate. This applies to every backend. A higher effort tier may bill differently.
- Where: `ratesFor` in `src/backends/pricing.ts`.
- Impact: printed costs for those models are estimates. Historical ledger rows keep the unknown cost source.
- Direction: add explicit price entries when the owner has the rates.
- Decision: the owner ratified the mapping on 2026-10-19. The gap is the missing OpenCode price table: `src/backends/default-pricing.ts` has no OpenCode Go or Zen entries. OpenCode Go is a flat subscription, so token prices are nominal. Owner to decide what to ship.

## 9. The json output is one pretty-printed document

- What: the json output format (the output-format option set to json) prints one indented object for the whole run. The work-package wording says each output line parses on its own. Only `stream-json` is line by line.
- Where: `src/cli/output.ts`.
- Impact: a consumer must read the whole stdout as one document.
- Direction: owner decision. Either read the wording as stream-json only, or change the json format to a single line.

## 10. Settings keys that are accepted, ignored, or rejected

- The `hooks` settings key is accepted by the schema and ignored, since the hook code was deleted in R5.3. Where: `src/contracts/index.ts`.
- The `permissions.ask` key was removed from the schema. A settings file that still contains it now fails validation, with an unrecognized-key error. Users must delete the key. Recorded in `docs/reference/config.md`.
- Keys accepted by the schema but not read by the engine: `budgets.run.max_wall_min`, `execution.strategy`, `git.branch_prefix`, `sandbox.network`, `routing.*.budget.*`, `backends.*.extra` (except the custom base URL), and the `roles.reviewer.*` and `roles.governor.*` keys, which are deferred (see item 13).
- The command-line options for allowed tools, disallowed tools and timeout write settings keys that nothing reads. A solo run on the local route was verified with zero tokens.
- Direction: remove the keys from the schema or wire them. Removing the `hooks` key would need a rule for old files.
- Decision: owner, together with item 3.

## 11. Configuration command behaviour

- `config get` of an unknown key prints `undefined` and exits 0. Reported.
- `config set` of the opencode provider base URL without the local flag writes the key to the shared settings file, after which every command exits 2. The error text names a key the code does not read (`backends.opencode.extra.base_url`). Reported.
- Built-in routing defaults (`routing.feature`, and `roles.worker`, both claude) override profile routes, so a profile does not reach the feature class or the solo worker. A profile named other than a backend pauses with `backend_unavailable`, which exits 3, the same code as `needs_input`. Reported.
- Direction: fix the key text, make unknown keys exit non-zero, and let profiles beat the built-in defaults.

## 12. Minor adapter and asset issues

- `src/backends/adapters/agy.ts` still says "agy 1.4.0" in the effort warning, while the pin is 1.4.2. A test pins the text, so both change together.
- `assets/agents/worker.md` has a `disallowedTools` frontmatter key that no code reads.
- The opencode adapter returns the raw version output as the version on a pin mismatch, so a failed record can hold a non-semver string.
- The bench command does not pass the dry-run option through, and its per-attempt costs are fixed per arm, so its printed costs and pass rates are not measurements. Reported.

## 13. Deferred items (governor and reviewer)

These allowlist entries stay on purpose, with `until: "DEFERRED"` (owner approved on 2026-10-20, optional R5.4). They are the only entries in `scripts/debt-allowlist.json`:

- purity: `src/roles/governor.ts` (rule P6).
- wired: `src/roles/prompts/reviewer.ts`.
- dead: `aggregateLedger` in `src/ledger/index.ts`, `validateGovernorTool` in `src/roles/governor-tools.ts`, `runGovernorSemanticLint` in `src/roles/governor.ts`, `buildReviewerPrompt` in `src/roles/prompts/reviewer.ts`, `appendRouteOutcome` in `src/roles/router.ts`.
- settings: `roles.governor.*`, `roles.reviewer.enabled`, `roles.reviewer.backend`, `roles.reviewer.model`, `roles.reviewer.effort`, `execution.strategy`, `git.branch_prefix`, `sandbox.network`.

The reviewer role needs a new engine phase (DECISIONS A2). Scenario 15 differs between the R-series spec (a request run with no governor setting exits 0) and SUBSTRATE-PLAN section 14 (a governor fallback). The matrix follows the R-series spec. Owner to confirm.

## 14. Test gaps and test-helper masking

- The test helper `recoverInFlightRun` in `test/integration/chaos/helpers.ts` appends `batch.started` and `task.ready` before it resumes. That hid the S11 resume bug from the in-process chaos scenario. The matrix row, which runs the real CLI, found it and the fix is in place. The helper should stop writing those events.
- The removed `loadPlan` tests covered its file-read error paths. Those paths have no live test now.
- Worktree tests print `fatal: update_ref failed` and `Needed a single revision` lines while passing. Not investigated.
- The bisect path calls the merge without a preflight. A conflict during a live bisect would throw instead of emitting an event. Read from the code, not run, and no test covers it.
- Seven fake-harness end-to-end runs were once seen to keep running after `task.failed` with `verify_failed`. Reported by the owner, not reproduced. The engine's exit after a failed task should be checked again.

## 15. Live smoke requirements

- The live opencode smoke needs the local-route base URL, which the live helper reads from the environment variable `SUBSTRATE_LIVE_OPENCODE_BASE_URL`. Set it to the local server address in your own environment. Do not commit the address.
- The R5.2 smoke passed on 2026-10-20 for all three harnesses, using the owner's local model for opencode. The gate command is the source of truth; run it to see the current state.
