# Known issues

## How to use this file

This file lists the findings that are still open after the R5.3 cleanup. It replaces the open items of `docs/plan/BLOCKED.md`, which is archived with the R-series plan. Items 1 to 15 are ordered by importance; items 16 and 17 were added after the R5.4 scoping and come last. Items 1, 2 and 16 are fixed and kept as short notes until the next cleanup. Each open item gives what is wrong, where it is, its impact, a suggested direction, and who must decide when an owner decision is needed. Items marked "reported" were seen in a run or in the code but not reproduced again during R5.3.

## 1. Planner failure diagnostics reach task.failed (FIXED)

- Fixed: `task.failed` carries an optional `message`, one line of at most 2000 characters, next to `failure_class`, which is unchanged. A session failure names the planner's exit code, its final text and the adapter's last error event; a format failure names the attempts and joins the diagnostics with `; `. Text mode prints the message on the `[task ] failed:` line, and json output carries it on the event in `events`. The planner's error events are read in both planner loops (the first planning turn and the answers resume). Documented in `docs/reference/cli.md` and `docs/reference/caller-guide.md`.

## 2. Harness stderr reaches the error event (FIXED)

- Fixed: when the opencode process exits non-zero without being killed, the adapter emits a `crash` error with the last 2 KB of its stderr, masked for `sk-` keys, bearer tokens and `api_key` values (`harnessStderrDetail` in `src/backends/process.ts`). The planner message then carries that text. The claude adapter appends the same masked tail to its existing `crash` error. The agy adapter is unchanged: its stderr is read as a stream, and it still emits no stderr text in errors. The `[substrate] warn:` lines are unchanged.

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
- Keys accepted by the schema but not read by the engine: `budgets.run.max_wall_min`, `execution.strategy`, `git.branch_prefix`, `sandbox.network`, `routing.*.budget.*`, `backends.*.extra` (except the custom base URL), and the `roles.reviewer.*` keys, which are deferred (see item 13).
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

## 13. Deferred items (reviewer)

The governor was deleted on 2026-10-20 on the owner's decision: the governor and the local-model front-door idea were dropped, and the deterministic router (`routeRequest` in `src/roles/router.ts`) replaces them. Removed: `src/roles/governor.ts`, `src/roles/governor-tools.ts`, `assets/agents/governor.md`, their unit tests, the `governor.fallback` event, the `roles.governor` setting and the `GovernorTool` schema.

- The `--no-governor` option is still accepted and ignored, so existing callers do not break. `docs/reference/cli.md` documents it as a no-op.
- A settings file that contains `roles.governor` is rejected by the strict settings schema, like any other unknown key.
- Scenario 15 is now `test/integration/scenarios/scenario-15-auto-no-governor.test.ts`: auto mode with no governor takes the plan route and finishes. Matrix row S15 in `test/e2e/matrix.test.ts` covers a request run with no governor setting.

These allowlist entries stay on purpose, with `until: "DEFERRED"` (owner approved on 2026-10-20). They are the only entries left in `scripts/debt-allowlist.json`:

- wired: `src/roles/prompts/reviewer.ts`.
- dead: `aggregateLedger` in `src/ledger/index.ts`, `buildReviewerPrompt` in `src/roles/prompts/reviewer.ts`.
- settings: `roles.reviewer.enabled`, `roles.reviewer.backend`, `roles.reviewer.model`, `roles.reviewer.effort`, `execution.strategy`, `git.branch_prefix`, `sandbox.network`.

The reviewer role needs a new engine phase (DECISIONS A2). Item 16 (the mechanical-file rule on the auto path) is fixed.

## 14. Test gaps and test-helper masking

- The test helper `recoverInFlightRun` in `test/integration/chaos/helpers.ts` appends `batch.started` and `task.ready` before it resumes. That hid the S11 resume bug from the in-process chaos scenario. The matrix row, which runs the real CLI, found it and the fix is in place. The helper should stop writing those events.
- The removed `loadPlan` tests covered its file-read error paths. Those paths have no live test now.
- Worktree tests print `fatal: update_ref failed` and `Needed a single revision` lines while passing. Not investigated.
- The bisect path calls the merge without a preflight. A conflict during a live bisect would throw instead of emitting an event. Read from the code, not run, and no test covers it.
- Seven fake-harness end-to-end runs were once seen to keep running after `task.failed` with `verify_failed`. Reported by the owner, not reproduced. The engine's exit after a failed task should be checked again.

## 15. Live smoke requirements

- The live opencode smoke needs the local-route base URL, which the live helper reads from the environment variable `SUBSTRATE_LIVE_OPENCODE_BASE_URL`. Set it to the local server address in your own environment. Do not commit the address.
- The R5.2 smoke passed on 2026-10-20 for all three harnesses, using the owner's local model for opencode. The gate command is the source of truth; run it to see the current state.

## 16. Auto mode skips the deterministic router on the default path (FIXED)

- Fixed: auto mode now runs `routeRequest` (`src/roles/router.ts`) on every run, from the route action in `src/engine/actions/route.ts`. Explicit flags come first, then the mechanical-file rule: a request that names one existing file with a mechanical verb routes to `solo`, and every other request routes to `plan`. An explicit `--mode solo` or `--mode plan` bypasses the router as before. The default-path change is documented in `docs/reference/cli.md` and `docs/reference/caller-guide.md`, and `test/integration/scenarios/scenario-17-auto-router.test.ts` covers the three routes.
- Still open: a request that also sets a planner (`--plan`, or a `planner` object) can be routed to `solo`, where the planner setting is ignored. The "no verify commands" warning in `src/cli/commands/run.ts` only prints for an explicit `solo` run, not for a run that auto mode routes to `solo`.

## 17. Check scripts still default to the archived progress file

- What: eight scripts read `docs/plan/PROGRESS.md` by default. That file was archived to `docs/archive/2026-10-20-r-series/PROGRESS.md`. When it is missing, `workPackageStatus` warns and treats every work package as TODO, so the allowlist rule that fails an entry whose work package is DONE is silently off. `scripts/check-plan.mjs` finds no rows and prints that there is nothing to check.
- Where: `scripts/lib/allowlist.mjs` (the file check at lines 47-56; rule 3 at line 111). The default `progressFile` is set in `scripts/check-all.mjs`, `scripts/check-dead-exports.mjs`, `scripts/check-events.mjs`, `scripts/check-purity.mjs`, `scripts/check-settings.mjs` and `scripts/check-wired.mjs`. `scripts/check-plan.mjs` joins `docs/plan` at line 12 and reads the file at line 25.
- Impact: harmless today, because only DEFERRED entries remain. It would hide a DONE-debt failure if a non-DEFERRED entry were added.
- Direction: either point the default at a small status file that the R-series archive does not move, or drop rule 3 together with the `until` work-package values so that only DEFERRED remains.
