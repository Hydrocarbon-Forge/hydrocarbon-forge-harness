# Known issues

## How to use this file

This file lists the findings that are still open after the R5.3 cleanup. It replaces the open items of `docs/plan/BLOCKED.md`, which is archived with the R-series plan. Items 1 to 15 are ordered by importance; items 16 and 17 were added after the R5.4 scoping and come last. Items 1, 2, 9 and 16 are fixed and kept as short notes until the next cleanup. Each open item gives what is wrong, where it is, its impact, a suggested direction, and who must decide when an owner decision is needed. Items marked "reported" were seen in a run or in the code but not reproduced again during R5.3.

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

## 7. The opencode adapter writes config files into the task worktree (OPEN, diff stays clean)

- Verified in R6.2: `generateOpenCodeRunConfigSync` in `src/backends/adapters/opencode.ts` (`configDir = req.cwd`, L264-341) writes the agent file to `<cwd>/.opencode/agents/<name>.md` and `opencode.json` to `<cwd>`. For a worker `<cwd>` is the task worktree `.substrate/worktrees/<run>/<task>/`; the planner passes `cwd: opts.runDir` (`src/roles/planner.ts` L428, L617), so planner files land in the run directory. The files exist in the worktree while opencode runs, and cleanup removes them when the session ends, which leaves an empty `.opencode/agents/` directory.
- Why the diff stays clean: `src/git/workspace.ts` adds `.opencode/` to the worktree's `info/exclude`, and `src/git/scope.ts` skips `.opencode/`. `test/e2e/opencode-worktree.test.ts` checks `git status --porcelain`, the merged tree and the diff from the root commit after a worker run.
- What is still wrong: R4.3 behaviour 2 says the config is never written into the worktree, and that is still not true. Moving it needs a documented way to point opencode at a config directory. `docs/spikes/S2-opencode.md` and `research/01-harness-conventions.md` record none, so the code is unchanged.
- Direction: find that documented mechanism (or confirm one in opencode's docs with a live check, which needs owner approval), then write the files outside the worktree and update the fake dialect in lockstep.

## 8. Cost rates for effort-suffixed model ids are an approximation

- What: a model id with an effort suffix (`-low`, `-medium`, `-high`) with no price entry is priced at the base id's rate. This applies to every backend. A higher effort tier may bill differently.
- Where: `ratesFor` in `src/backends/pricing.ts`.
- Impact: printed costs for those models are estimates. Historical ledger rows keep the unknown cost source.
- Direction: add explicit price entries when the owner has the rates.
- Decision: the owner ratified the mapping on 2026-10-19. The gap is the missing OpenCode price table: `src/backends/default-pricing.ts` has no OpenCode Go or Zen entries. OpenCode Go is a flat subscription, so token prices are nominal. Owner to decide what to ship.

## 9. The json output is one pretty-printed document (FIXED)

- Fixed: the json output format now prints the same object as one compact line (`src/cli/output.ts`, `config list` and `config get`, and `status`). `stream-json` is unchanged.

## 10. Settings keys that are accepted, ignored, or rejected

- The `hooks` settings key is accepted by the schema and ignored, since the hook code was deleted in R5.3. Where: `src/contracts/index.ts`.
- The `permissions.ask` key was removed from the schema. A settings file that still contains it now fails validation, with an unrecognized-key error. Users must delete the key. Recorded in `docs/reference/config.md`.
- Keys accepted by the schema but not read by the engine: `budgets.run.max_wall_min`, `execution.strategy`, `git.branch_prefix`, `sandbox.network`, `routing.*.budget.*`, `backends.*.extra` (except the custom base URL), and the `roles.reviewer.*` keys, which are deferred (see item 13).
- The command-line options for allowed tools, disallowed tools and timeout write settings keys that nothing reads. A solo run on the local route was verified with zero tokens.
- Direction: remove the keys from the schema or wire them. Removing the `hooks` key would need a rule for old files.
- Decision: owner, together with item 3.

## 11. Configuration command behaviour

- FIXED: `config get` of an unknown key exits 2 with `unknown settings key: <key>` (stderr in text mode, a one-line error object in json mode). A known key that is unset still prints `undefined` and exits 0.
- `config set` of the opencode provider base URL without the local flag writes the key to the shared settings file, after which every command exits 2. The error text names a key the code does not read (`backends.opencode.extra.base_url`). Reported.
- OPEN (R6.5, analysis only, no code change): built-in routing defaults (`routing.feature`, and `roles.worker`, both claude) override profile routes, so a profile does not reach the feature class or the solo worker. A profile named other than a backend pauses with `backend_unavailable`, which exits 3, the same code as `needs_input`. Reported.
  - How a profile is selected: there is no `profile` key. A profile applies when `defaults.planner_provider` or `defaults.worker_provider` names it (`src/config/index.ts:314-331`, `validateProfiles`), or when a request sets `planner` or `worker` (`src/cli/request.ts:403` builds `overrides.roles.worker`; `--plan` and `--work` take the same path).
  - (1) Profile-only result, probed with `defaults.planner_provider` and `defaults.worker_provider` set to `opencode`, with `plan` `plan-m`, `work` `work-m`, `fast` `fast-m` and no other settings: the planner gets `opencode` / `plan-m` (`src/roles/router.ts:153-154`, read by `src/engine/actions/plan.ts:70`); the `refactor` class gets `opencode` / `work-m` (`src/roles/router.ts:189-199`); the `feature` class gets `claude` / `claude-sonnet-5-5` / `medium`; the solo worker gets `claude` / `claude-sonnet-5-5`.
  - (2) Why the built-in entries win: `DEFAULT_SETTINGS` holds `roles.worker` (`src/config/index.ts:94`) and `routing.feature` (`src/config/index.ts:97`). `foldLayers` starts from it (`src/config/index.ts:260`), and the engine merges it again on every run (`src/engine/engine.ts:153` and `:247`). Once merged, a built-in value cannot be told from a user value. `baseRouteForClass` reads `routing[class]` before any profile slot (`src/roles/router.ts:184-185`), so `feature` never reaches the profile branch (`:189`). Solo reads `roles.worker` unconditionally (`src/engine/actions/solo.ts:91-99`).
  - (3) Proposed design, not implemented: remove `roles.worker` and `routing.feature` from `DEFAULT_SETTINGS`, and keep the claude fallback as the last step of the resolver, after the profile branch (`src/roles/router.ts:202-204`), with the same effort (`medium`) for the solo worker. Then a user value, from any layer or request flag, is present in the merged settings and wins, and a profile wins over the fallback. This is not a small change. It alters the settings contract (`DEFAULT_SETTINGS`, `src/config/index.ts:92-99`, and the engine re-merge at `src/engine/engine.ts:153` and `:247`). It also changes readers of `routing` that assume the feature entry exists: the lint rule L015 (`src/spec/rules.ts:703`) and the model catalog (`src/cli/model-catalog.ts:86`). It needs the docs in `docs/reference/config.md:153` and `:164` changed. It is therefore left open for the owner to decide.
- Direction: fix the key text, make unknown keys exit non-zero (done), and let profiles beat the built-in defaults (open, design above).

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

- FIXED (R6.3): `recoverInFlightRun` in `test/integration/chaos/helpers.ts` no longer appends `batch.started` or `task.ready` before it resumes. Those events hid the S11 resume bug from the in-process chaos scenario, and the engine's resume now releases PENDING roots and re-queues in-flight tasks itself. The helper keeps only the recorded verify pass (`task.passed` after `task.verify.finished`), which the engine does not write on resume; `npx vitest run test/integration/chaos` passes 10 of 10 without the removed writes.
- The removed `loadPlan` tests covered its file-read error paths. Those paths have no live test now.
- Worktree tests print `fatal: update_ref failed` and `Needed a single revision` lines while passing. Not investigated.
- The bisect path calls the merge without a preflight. A conflict during a live bisect would throw instead of emitting an event. Read from the code, not run, and no test covers it.
- Seven fake-harness end-to-end runs were once seen to keep running after `task.failed` with `verify_failed`. Reported by the owner, not reproduced. The engine's exit after a failed task should be checked again.

## 15. Live smoke requirements

- The live opencode smoke needs the local-route base URL, which the live helper reads from the environment variable `SUBSTRATE_LIVE_OPENCODE_BASE_URL`. Set it to the local server address in your own environment. Do not commit the address.
- The R5.2 smoke passed on 2026-10-20 for all three harnesses, using the owner's local model for opencode. The gate command is the source of truth; run it to see the current state.

## 16. Auto mode skips the deterministic router on the default path (FIXED)

- Fixed: auto mode now runs `routeRequest` (`src/roles/router.ts`) on every run, from the route action in `src/engine/actions/route.ts`. Explicit flags come first, then the mechanical-file rule: a request that names one existing file with a mechanical verb routes to `solo`, and every other request routes to `plan`. An explicit `--mode solo` or `--mode plan` bypasses the router as before. The default-path change is documented in `docs/reference/cli.md` and `docs/reference/caller-guide.md`, and `test/integration/scenarios/scenario-17-auto-router.test.ts` covers the three routes.
- Fixed (R6.4): a request that also sets a planner (`--plan`, or a `planner` object) now routes to `plan` in auto mode, even when it names a mechanical file. The router takes this as `flags.planner` (`src/cli/request.ts` records `plannerExplicit` before the flag overrides; `src/cli/commands/run.ts` passes `planner_explicit` to the engine). The "no verify commands" warning now also prints when auto mode routes a run to `solo` (`src/cli/commands/run.ts`, on the `run.routed` event). Tests: `test/unit/roles/router.test.ts`, `test/integration/scenarios/scenario-17-auto-router.test.ts`, `test/e2e/solo.test.ts` (c).

## 17. Check scripts still default to the archived progress file (FIXED)

- Fixed (R6.7): the check scripts no longer read a progress file. The DONE rule and the `until` work-package tags are gone. `scripts/lib/allowlist.mjs` accepts only `until: "DEFERRED"`, and any other value is an error (`Invalid 'until' in allowlist entry`). `--progress` and the default `docs/plan/PROGRESS.md` are removed from `check-all`, `check-dead-exports`, `check-events`, `check-purity`, `check-settings` and `check-wired`. The `--init-allowlist` mode writes `DEFERRED`.
- `scripts/check-plan.mjs` and its `check:plan` npm script are deleted. Its only input was the archived PROGRESS.md, so with the plan archived it checked nothing. It was not part of `npm run check`.
- Tests: `test/unit/scripts/allowlist.test.ts`, and the `done-wp` case in `check-{purity,events,settings,wired}.test.ts`, now pin the rejection of a work-package tag. The archived PROGRESS fixtures are deleted.
