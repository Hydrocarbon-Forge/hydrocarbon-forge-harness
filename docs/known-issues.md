# Known issues

## How to use this file

This file lists the findings that are still open after the R6 series (R6.9 is the last cleanup package). It replaces the open items of `docs/plan/BLOCKED.md`, which is archived with the R-series plan. Items 1 to 15 are ordered by importance; items 16 and 17 were added after the R5.4 scoping and come last. Items 1, 2, 9, 16 and 17 are fixed and kept as short notes until the next cleanup. Each open item gives what is wrong, where it is, its impact, a suggested direction, and who must decide when an owner decision is needed. Items marked "reported" were seen in a run or in the code but not reproduced again during R5.3.

## Remaining open after R6

These items are still open. Each one has its detail in the numbered section below. Items 4 and 5 need an owner go-ahead or a decision.

- Item 3: permissions are bypassed and the allow and deny lists are advisory (owner decision).
- Item 4: pending live experiments (claude disallowed tools, opencode external-directory permission, agy commit under bypass). Each needs the owner go-ahead.
- Item 5: the agy environment allowlist (owner decision).
- Item 6: the process environment option drops inherited variables (no live caller).
- Item 7: the opencode adapter writes config files into the task worktree (relocation needs a documented mechanism).
- Item 8: cost rates for effort-suffixed model ids are an approximation (owner decision on price entries).
- Item 10: `execution.strategy`, `budgets.run.max_wall_min` and the reviewer settings (owner decisions).
- Item 12: minor adapter and asset issues.
- Item 13: the reviewer role (deferred, DECISIONS A2).
- Item 14: test gaps and test-helper masking (the open parts).
- Item 15: the live opencode smoke needs the local base URL in the environment.
- Item 24a: L003 scans every `.md` under `tasks/` recursively (plan-lint audit).
- Item 24c: L013 can trip on `...` in ordinary prose.
- Item 24d: L017 can trip when a glob in `read` matches more than 50 files.
- Item 24e: the L018 example in `assets/prompts/planner/format.md` needs TypeScript, which a fresh repository may not have at plan time.
- Item 24f: L023 (red-check, when enabled) runs verify commands in the repository root during lint.
- Item 24g: the planner runs the contract typecheck up to three or four times per plan (cost and time).
- Item 24h: the `safeLoadPlan` placeholders in the repository root can be seen by a lint that runs there.
- Item 24i: `resume` does not keep the models a run started with (item 18).

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

## 10. Settings keys that are accepted, ignored, or rejected (partly FIXED)

- Fixed (R6.7): three keys that nothing read were removed from the strict schema, with their defaults and their allowlist entries: `hooks` (out of scope in DECISIONS), `git.branch_prefix` (DECISIONS: branch names are fixed in code) and `sandbox.network` (DECISIONS A6). A settings file that still holds one now fails to load with exit 2 and names the key. `docs/reference/config.md` has a "Removed keys" section. Tests: `test/unit/config/loader.test.ts`, `test/unit/config/config-command.test.ts`, `test/e2e/removed-settings-keys.test.ts`. `execution.strategy` and its `ExecutionStrategy` contract stay (see below).
- The `permissions.ask` key was removed from the schema earlier. A settings file that still contains it fails validation, with an unrecognized-key error. Users must delete the key. Recorded in `docs/reference/config.md`.
- Kept on purpose in R6.7, because they are not dead by the rule used (no reader in `src/`, not documented as working):
  - `execution.strategy`: the `ExecutionStrategy` seam (`direct` or `dispatcher`) is reserved in the original design (`SUBSTRATE-PLAN.md` OD1 and the Appendix A contract list). The contract tests in `test/unit/contracts/schemas.test.ts` and `test/unit/contracts/export-schemas.test.ts` pin it. Removing it is a design decision for the owner.
  - `roles.reviewer.enabled`, `.backend`, `.model`, `.effort`: DECISIONS A2 keeps the reviewer as an optional role, and item 13 covers it.
  - `budgets.run.max_wall_min`: nothing reads the settings key in the engine, but the `--timeout` flag (`src/cli/commands/run.ts:135-136`) and the request `budget.max_wall_min` (`src/cli/request.ts:208`, `:418-419`) write it. Removing it would make `--timeout` fail validation, so it is a CLI decision.
  - `routing.*.budget.*` and `backends.*.extra` (except the custom base URL): not on the allowlist, so `check-settings` counts them as read. Not re-checked in R6.7.
- The command-line options for allowed tools, disallowed tools and timeout write settings keys that nothing reads. A solo run on the local route was verified with zero tokens. The timeout option is the `budgets.run.max_wall_min` case above.
- Direction: owner decision on `execution.strategy` (keep the seam or remove it with its Appendix A entry) and on `budgets.run.max_wall_min` with the `--timeout` flag.

## 11. Configuration command behaviour

- FIXED: `config get` of an unknown key exits 2 with `unknown settings key: <key>` (stderr in text mode, a one-line error object in json mode). A known key that is unset still prints `undefined` and exits 0 in text mode.
- FIXED (R6.9): with `--output-format json`, `config list` and `config get` print a settings-load failure as one `{"error":...}` object on stdout and exit 2, the same convention as `run` and `status`. Text mode still prints `Error:` on stderr. `config get` prints a string as a valid JSON value (`"claude"`), and an unset key prints `null`. Tests: `test/unit/config/config-command.test.ts`; `docs/reference/cli.md` and `config.md` updated.
- FIXED (R5.2, verified in R6.9): the base-URL error names `backends.opencode.provider.base_url`, the key the code reads (`src/backends/adapters/opencode.ts:612`); the earlier text named a key nothing read.
- FIXED (R6.10): `config set` of the opencode provider base URL without `--local` exits 2 and writes nothing. Before it writes, `config set` now runs the loader's provider rule (`assertNoProviderOutsideLocal`) and profile check (`validateProfiles`) on the merged result, which it did not do before (it ran only the schema parse). The message names the key and hints at `--local`. Tests: `test/unit/config/config-command.test.ts` and `test/e2e/config-set-validation.test.ts`; `docs/reference/cli.md` and `config.md` updated.
- FIXED (R6.5): profiles beat the built-in routing defaults. The built-in claude route is no longer a settings default. It is the last step of route resolution, after an explicit `routing.<class>` and the selected profile slot (`BUILTIN_FALLBACK_ROUTE` in `src/roles/router.ts`). `roles.worker` is a partial route, so a request or environment variable can set only the model. Precedence is in `docs/reference/config.md` (Route precedence). Tests: `test/unit/roles/router-profiles.test.ts` and `test/integration/scenarios/scenario-profile-precedence.test.ts`. The R6.5 analysis (the probe results and the old cause) is in commit 7b3591c.
- Current state: the key text, the unknown-key exit, profile precedence and the `config set` provider key are fixed. Nothing is open in item 11.

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
- dead: `aggregateLedger` in `src/ledger/index.ts` (imported by `test/unit/ledger/ledger.test.ts`), `buildReviewerPrompt` in `src/roles/prompts/reviewer.ts` (imported by `test/unit/roles/prompts.test.ts`). Both stay until their tests move with the reviewer phase.
- settings: `roles.reviewer.enabled`, `roles.reviewer.backend`, `roles.reviewer.model`, `roles.reviewer.effort`, and `execution.strategy` (R6.7 removed `git.branch_prefix` and `sandbox.network`; see item 10).

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
- Fixed (R6.4), superseded by R7.2: a request that also sets a planner (`--plan`, or a `planner` object) routed to `plan` in auto mode, even when it named a mechanical file. R7.2 removed that rule: `run` now requires both models on the command line, so a named planner carries no signal for the route. Auto mode routes by the deterministic router alone (mechanical named file → `solo`, otherwise `plan`); `--mode plan` forces planning. The `planner_explicit` plumbing (`src/roles/router.ts`, `src/engine/actions/route.ts`, `src/engine/effects.ts`, `src/contracts/index.ts`) is gone. Original R6.4 note: the router took this as `flags.planner`. The router takes this as `flags.planner` (`src/cli/request.ts` records `plannerExplicit` before the flag overrides; `src/cli/commands/run.ts` passes `planner_explicit` to the engine). The "no verify commands" warning now also prints when auto mode routes a run to `solo` (`src/cli/commands/run.ts`, on the `run.routed` event). Tests: `test/unit/roles/router.test.ts`, `test/integration/scenarios/scenario-17-auto-router.test.ts`, `test/e2e/solo.test.ts` (c).

## 17. Check scripts still default to the archived progress file (FIXED)

- Fixed (R6.7): the check scripts no longer read a progress file. The DONE rule and the `until` work-package tags are gone. `scripts/lib/allowlist.mjs` accepts only `until: "DEFERRED"`, and any other value is an error (`Invalid 'until' in allowlist entry`). `--progress` and the default `docs/plan/PROGRESS.md` are removed from `check-all`, `check-dead-exports`, `check-events`, `check-purity`, `check-settings` and `check-wired`. The `--init-allowlist` mode writes `DEFERRED`.
- `scripts/check-plan.mjs` and its `check:plan` npm script are deleted. Its only input was the archived PROGRESS.md, so with the plan archived it checked nothing. It was not part of `npm run check`.
- Tests: `test/unit/scripts/allowlist.test.ts`, and the `done-wp` case in `check-{purity,events,settings,wired}.test.ts`, now pin the rejection of a work-package tag. The archived PROGRESS fixtures are deleted.

## 18. Requested models were ignored by plan-mode tasks and by a planner profile (FIXED, R7.4; resume FIXED, R8.2)

- FIXED (R7.4): `--work` (and `--worker-model`, `--model` in solo) reached only the solo worker. Plan-mode tasks resolved their route from `routing.<class>`, the worker profile and the built-in route, so a plan run used the profile's model whatever `--work` named. A planner with `defaults.planner_provider` set used the profile's `plan` slot, so `--plan` was ignored. The request now sits above every other route source. It is recorded as `roles.requested` (set only by run and plan from the request payload and the flags; a settings file that sets it is refused with exit 2), and `resolveTaskRoute` and `resolvePlannerRoute` in `src/roles/router.ts` apply it; solo mode uses the same function. A named worker model is not escalated on later generations.
- Tests: `test/e2e/requested-models.test.ts` (plan mode: planner spawn and every task spawn read their `--model` from the fake harness argv log; solo: `--work` beats `routing.feature` and `roles.worker`) and `test/unit/roles/requested-route.test.ts`.
- FIXED (R8.2): `resume` used only its own flags, so a resumed run took its models from settings. The run now records `requested_roles` on `run.created`, and resume uses them unless `--plan`, `--work`, `--model` or `--worker-model` names a role again. Tests: `test/e2e/graceful-interrupt.test.ts` ("resume keeps the models", "a resume that names --work again").

## 19. A planner base_ref that does not resolve failed the run (FIXED, R7.5)

- FIXED (R7.5): the planner may write a manifest `base_ref` such as `main` in a repository whose branch is `master`. The run then failed at the integration base check (`git worktree add ... main`), after the planner was paid. The run's base (HEAD when the run starts) is now authoritative, and `resolveBaseRef` in `src/git/base-ref.ts` decides every use of the manifest value (contract stub commit, integration base check, merge base check). An absent, `(none)`, same-named or unresolvable value, or one that names the run base's commit under another name, uses the run base and prints `note: planner base_ref 'main' ignored; using run base <short sha>` (`contracts.committed` carries `note`). A different commit that resolves is still used as before. The planner format asks for the request's `base_ref` copied exactly. Tests: `test/unit/git/base-ref.test.ts`, `test/e2e/base-ref.test.ts` (no `init.defaultBranch` pin).

## 20. Claude 5 haiku and opus ids were refused, and a refused request left a repository behind (FIXED, R7.6)

- FIXED (R7.6): the claude harness listed only the aliases and the ids in settings roles, routing and the settings price table, so `claude-haiku-5-5` and `claude-opus-5-5` were unknown with the defaults. `src/backends/adapters/claude.ts` (`CLAUDE_FAMILY_IDS`) and `src/backends/registry.ts` now list the Claude 5 family; `claude-fable-5-1` has no price entry and reports unknown cost. Request validation ran after `git init` and wrote `.substrate/state/models.json`; now `run` and `plan` validate the request first (`src/cli/preflight.ts`, `src/cli/commands/run.ts`, `src/cli/commands/plan.ts`), and the catalog validation writes no cache (`src/cli/request.ts`). Tests: `test/unit/cli/claude-model-ids.test.ts`, `test/e2e/model-validation.test.ts`, `test/e2e/requested-models.test.ts` (Claude 5 plan run).

## 21. Valid plans were rejected by lint rules that do not fit the planner (FIXED, R7.7)

- FIXED (R7.7): two real runs died on format lint for reasons that are not plan faults. L012 read `test/*.test.js;` as a literal path, so a shell glob and the `;` glued to it failed a plan whose verify command was correct. `cleanShellWord` in `src/spec/rules.ts` strips the punctuation around a word, and a glob is not reported as a missing literal path. L015 (a class must be in `settings.routing`) is retired: every class resolves through the routing table, the worker profile slot, the request's named worker or the built-in route (`resolveTaskRoute` never throws), so no class can be unrouted. L016 treats a missing task budget as a warning (`warn`), not an error; the task runs with the per-task cap, and `safeLoadPlan` (`src/engine/actions/shared.ts`) gives the approval lint that cap instead of a hard-coded 0.5. A budget above the cap is still an error. Tests: `test/unit/spec/rules.test.ts` (the L015 test now pins the retirement, the L016 test pins the warning, and the L012 tests use the verify strings of run r_XDZHITGE25FD), `test/unit/spec/snake-plan-2.test.ts` (the attempt-2 drafts lint without errors), `test/e2e/no-budget-plan.test.ts` (a plan with no budgets runs its workers with `--max-budget-usd` at the cap).

## 22. The contract typecheck failed at LINTING on a valid plan (FIXED, R7.7)

- FIXED (R7.7): run r_XDZHITGE25FD refused the second planner attempt at the approval lint with `[L018] ... node ... ERR_INVALID_PACKAGE_CONFIG`, after the planner's own typecheck had passed. Cause: `safeLoadPlan` (`src/engine/actions/shared.ts`) writes `export {};` into the repository root for each contract file that is missing there, `package.json` included, and the L018 rule then ran its typecheck with the repository root as the working directory. Node read the placeholder `package.json` as package config, which is not valid JSON. The planner checks its stubs in the run directory, where the drafts are valid, so the two checks disagreed. L018 now runs in the run directory that holds the manifest (`ruleL018` in `src/spec/rules.ts`). Reproduced offline with the fake planner and the real attempt-2 drafts (`test/fixtures/spec/snake-plan-2`). Tests: `test/e2e/snake-plan-replay.test.ts` (fails before the fix, passes after), `test/unit/spec/rules.test.ts` (L018 run-directory test).

## 23. A plan refused after the contract stage ended the run (FIXED, R7.7)

- FIXED (R7.7): the approval lint (`LINTING`, `src/engine/actions/approve.ts`) ran after the planner had committed the contract stubs, and a refusal there was `plan.rejected`, which cancels the run, while a refusal by the format lint got up to three attempts. The planner now runs the approval lint (`approvalLintDiagnostics` in `src/roles/planner.ts`, which uses `safeLoadPlan` from `src/spec/stub-plan.ts`) after its own checks and before `commitContractStubs`. A refusal is a `plan.format_rejected` and a retry, within `planner_format_retries` and the run budget (`runBudgetExceeded`, from `plan.ts`), and the diagnostics carry no absolute paths (`withoutRootPaths`). Nothing is committed for a refused attempt, so a stub from it never reaches the run branch; the commit is built from the base commit each time. The post-commit `LINTING` lint is kept as a guard; a refusal there is still terminal. Limits: after the L018 fix no real plan is refused by the approval lint alone, so the retry from that check is covered by the code path, not by a reproduction; the contract-typecheck retry is covered by `test/e2e/planner-retry-post-contract.test.ts`. A run whose attempts are all refused ends `failed` (`task.failed`, `spec_invalid`), not `cancelled`. Tests: `test/e2e/planner-retry-post-contract.test.ts` (recovery on attempt 2; three refusals; no stub committed from a refused attempt).

## 24. Plan-lint audit after R7.7 (OPEN)

The R7.7 audit of the plan lint and the planner found the open items below. Each one is OPEN and has no fix in R7.8. Items a to h are facts from the audit; item i repeats item 18.

- FIXED as a warning (24a, R12.3): an orphan `.md` under `tasks/` is now the L003 warning, so a repository that keeps its own docs there no longer rejects plans. A spec the manifest names and that is missing still blocks, because the task cannot be read. Tests: `test/unit/spec/lint-severity.test.ts`. The scan itself still covers `tasks/`; it only warns.
- FIXED (24b, R11.1): L011 took the first whitespace token of the verify line, so `d=$(mktemp -d) && ...` was rejected as binary `d=$(mktemp` ($0.0882 wasted; `substrate-hello-4` plan attempt 1). It now takes the first command word after leading `NAME=value` assignments (`src/spec/verify-command.ts` `verifyBinaryOf`); wrappers (`sh -c`, `bash -c`, `env`, `timeout`) are checked as themselves and their script is never parsed; a line with no plain command word first (subshell, substitution, quoted word, chain after an assignment) is not checked; a binary the plan's setup or created paths name is not reported. Tests: `test/unit/spec/verify-command.test.ts` (the evidence table in `test/fixtures/verify-commands/evidence.tsv`, the synthetic cases, the genuine missing binary).
- NOT BLOCKING (24c, R12.3): L013 is a warning, so a `...` in prose no longer refuses a plan. The token list is unchanged and still broad; a false positive now reaches the reviewer as a warning only.
- NOT BLOCKING (24d, R12.3): L017 is a warning, so a glob that matches more than 50 files no longer refuses a plan. The count is unchanged.
- OPEN (24e, part fixed by R12.3): a failing contract typecheck, including one that cannot run because TypeScript is missing, is now the L018 warning and costs no retry. The example in `assets/prompts/planner/format.md` still runs the TypeScript compiler at plan time. Direction: use a command the repository's own ecosystem provides, or state in the format that the example needs a prior install.
- OPEN (24f, R12.3 note): L023 is always a warning now (the red-check error mode is gone), but lint still runs verify commands in the repository root. Direction: run red-check in a disposable checkout of the base ref.
- OPEN (24g, partly reduced by R12.3): the planner's own explicit typecheck is removed (lint runs the check once), so an attempt runs it twice (the lint and the approval lint) instead of three times. The LINTING guard and the approval lint still repeat it. This is a cost and time concern. Direction: keep one typecheck per attempt and reuse its result for the later checks.
- OPEN (24h): the `safeLoadPlan` placeholder writes (`src/spec/stub-plan.ts`) go into the repository root. They are cleaned up afterwards, but any lint that runs in the repository root can still see placeholders. Direction: run the placeholder lint in a temporary copy of the tree.
- OPEN (24i): `resume` does not keep the models a run started with. This is item 18 and is cross-referenced here, not a new finding.


## 25. The planner was capped at the per-task budget, and planning failures hid their cause (FIXED, R7.9)

- FIXED (R7.9): a real run (`r_PNTDUUAHRTW5`, planner `claude-sonnet-5-5` at effort xhigh, request "make a snake game" in an empty repository) recorded one planner usage row of $0.5059 and then failed `worker_crashed: Planner session failed with exit code 1`, with no stderr. The planner was spawned with `budgets.task.max_usd` (default $0.50), and the claude adapter passes it as `--max-budget-usd`. claude stops a session at that cap with the result subtype `error_max_budget_usd`, `terminal_reason` `budget_exhausted` (the shape of `test/fixtures/backends/claude/budget-exceeded.ndjson`), and the planner's first attempt of a greenfield plan costs about $0.5 to $0.65. The planner is now capped at the run budget not yet spent (`plannerSpawnBudgetUsd` in `src/roles/planner.ts`: at least $0.50, never above `budgets.run.max_usd`), on both the plan and the answers-resume spawns in `src/engine/actions/plan.ts`. Tasks keep the per-task cap.
- FIXED (R7.9): a planner stopped at its cap fails `budget_exceeded` with `planner stopped at its budget cap of $X (spent $Y); the run budget is $Z`. Other session failures name the claude result's subtype and error lines (the claude normaliser reports them as an error event), and say `no error output from <harness>` when nothing was reported.
- FIXED (R7.9): the text progress line of a failure with no task id reads `[plan] failed: ...` (`[run]` outside planning), never `[task ]`. A failed planning run has no branch, so the summary prints `Branch:     (none, planning failed)` and the json result omits `branch` (`runBranchExists` in `src/git/workspace.ts`; `RunSummary.branch` is optional). Its `Next:` hint reads `substrate resume <id>  (re-runs planning; costs again)`.
- Tests: `test/unit/roles/planner-budget.test.ts`, `test/e2e/planner-budget.test.ts` (the planner spawn gets the run budget, the retry gets the remaining budget, tasks get the task cap), `test/e2e/planner-failure-cause.test.ts` (budget stop, error result, `[plan]` label, no branch, resume hint, json branch). The fake claude dialect gained the `budget` and `error_result` failure modes. `test/integration/roles/planner.test.ts` pinned the old per-task cap on the first spawn and now pins the run budget.

## 26. Progress showed $0.0000 while planning, and routing reasons read as jargon (FIXED, R7.10)

- FIXED (R7.10): the planning heartbeat printed `still working: planning (443s, $0.0000)` for minutes, because claude reports a session's cost only when the session ends. A heartbeat now says `cost is reported when planning ends` (or `when this step ends` in other phases) until the first usage record, then prints the running total. The stream-json heartbeat carries `cost_usd: null` until then. The routing rationales now say why in plain words (`explicit mode flag`, `mechanical edit of a named file`, `request is not a mechanical edit of a named file`), replacing `Default plan fallback` and `Deterministic match: ...`. Tests: `test/unit/cli/progress.test.ts` (heartbeat cost before and after a usage record; stream-json null), `test/unit/roles/router.test.ts`.

## 27. An integration verify that fails at the base commit failed the run after the workers were paid (FIXED, R7.11)

- FIXED (R7.11): a real run (`r_R4DHU6I6DB37`, `make a hello world in java`, planner `claude:sonnet:medium`, worker `claude:haiku:low`) passed its one task, then failed with `integration.failed {base: true}` and exit 1, and nothing was merged. The base check (R3.6 behaviour 8) ran `integration_verify` on the base commit before the first merge and failed the whole run when it did not pass there. A greenfield plan's integration verify checks the code the run creates, so it cannot pass at base, and the planner guidance never said so. The base check is now advisory: a failure is recorded as `integration.started {base_verify_passed: false}`, shown as one `note:` line in text progress, and the run goes on. The verify on the merged result decides the run as before. The base check and the final integration verify share one helper (`checkBaseVerify` in `src/engine/actions/shared.ts`). The planner format and planner agent now say that `integration_verify` runs on the merged result and is expected to fail on the base commit. No decision in `docs/plan/DECISIONS.md` pinned the fail-on-red-base behaviour; it came from the archived R3.6 spec. Integration failures now name the command, exit code and output. (Superseded by item 70, R12.2: the base check is removed.) `verifyIn` (`src/git/merger.ts`) returns the first command that did not pass with its exit code and output; `integrationFailureDetail` (`src/engine/actions/shared.ts`) redacts it and builds the message the summary `Reason:` and the task event carry; the text progress line reads `integration verify failed: <command> (exit <n>)`. A failure found by the bisect is carried by the culprit task's `task.failed` message. Tests: `test/unit/engine/integration-failure.test.ts`, `test/integration/merge/merger.test.ts`, `test/e2e/integration-base.test.ts` (the failing case stops at exit 3 through the bisect path, not exit 1; the final `integration.failed` path runs the same commands on the same tree as the batch verify, so no e2e reaches it).
Tests: `test/e2e/integration-base.test.ts`, `test/unit/spec/hello-java-plan.test.ts` (the plan fixture `test/fixtures/spec/hello-java-plan`), `test/integration/scenarios/scenario-10-integration-bisect.test.ts` (the base-failure case now asserts the run is not stopped), `test/unit/cli/progress.test.ts`.

## 28. R7.12 test guidance (VERIFIED by a real run)

- VERIFIED (R7.12): the planner, test-writer and worker prompts now decide when tests are written and how many, instead of asking for a test per behaviour. Changed: `assets/agents/planner.md` (step 6, "When tests earn their place", Verification), `assets/agents/test-writer.md` (rule 2), `assets/prompts/planner/format.md` (Behavior, Edge cases and Out of scope for tests tasks, worked example), and `assets/prompts/worker/class/*.md`. Lint L028 (`ruleL028` in `src/spec/rules.ts`) warns when a tests task lists more than 10 test targets; it never blocks a plan.
- The baseline is the earlier real snake run: 45 tests, about 726 lines of test code for about 490 lines of game code.
- Evidence: live run `r_FI22FE7MVNJW` (2026-10-21, planner claude-sonnet-5-5 xhigh, worker claude-haiku-5-5 medium, merge flag, empty directory). It planned 3 tasks (tests, rules module, browser UI) and wrote 6 files, including ONE test file with 16 tests and 260 lines, against 444 lines of JavaScript. The tests target the pure rules module (collisions, food placement, input queue, speed curve). None cover the browser UI in `main.js` (canvas drawing, keyboard events, gameplay), which was not tested in a browser. Some `placeFood` cases overlap.
- Cost $0.5886 (planner $0.5558, workers $0.0328), 5 min 10 s. Tasks T1 and T3 ran at the same time for about 36 s. One integration verify ran after the last merge and passed 3/3. The run merged, and no branches or worktrees were left behind.

## 29. Finished runs left worktrees and task branches behind (FIXED, R8.1)

- Seen: after a successful 3-task run the `substrate/tasks/<run>/<task>-g1` branches and `.substrate/worktrees/<run>/` remained. Nothing called the removal functions.
- Fixed: `sweepRunWorkspaces` in `src/git/cleanup.ts` runs when a run reaches FINISHED or FAILED (`src/engine/effects.ts`). It removes every worktree and task branch of the run and the integration worktree. The run branch is kept. Work of tasks that did not merge is saved first as `packets/<task>-g<n>.patch`, with the attempt reports beside it. A paused run keeps its workspaces, because resume needs them.
- Test: `test/e2e/graceful-cleanup.test.ts`, `test/e2e/graceful-failure.test.ts`.

## 30. `.substrate/` showed as untracked in the user's checkout (FIXED, R8.1)

- Seen: `git status` showed `?? .substrate/` after a run. `ensureGitExclude` covered only `.substrate/worktrees/`.
- Fixed: `.substrate/` is in `.git/info/exclude`, written at run and resume start (`src/git/workspace.ts`, `src/engine/engine.ts`). The DECISIONS row that said otherwise is amended by a dated note.

## 31. A failed final integration verify paused the run with exit 3 and no questions (FIXED, R8.1)

- Seen: a single-task run whose integration verify failed ended `paused` with `needs_human`, exit 3, and no questions.
- Cause: the replan ladder's L3 and the L2 dead ends called `pause(needs_human)` with no QUESTIONS.md.
- Fixed: `giveUp` in `src/engine/replan.ts` fails the task (`can_replan: false`) and the run ends failed, exit 1, with the task's own failure message as `Reason` (for example `integration_failed: sh -c 'test -f src/never.txt' exited 1`). A `needs_human` pause remains only with a QUESTIONS.md file.

## 32. A worker crash was treated as a verify failure (FIXED, R8.1)

- Seen: a harness that exited without a result was run through verify, healed and then replanned, and the run paused.
- Fixed: a typed `error` event of kind `crash` makes the attempt `worker_crashed` (`src/roles/worker.ts`).

## 33. A failed task stopped the whole run, and its dependents were marked blocked silently (FIXED, R8.1)

- Seen: once a task was BLOCKED the run paused, so independent siblings never ran. Dependents got a `task.blocked` with no reason.
- Fixed: independent tasks keep running. Dependents get `task.skipped` (`reason: dependency_failed`, `failed`, `skipped`), progress reads `[task T3] skipped (depends on T2, which failed)`, and the summary counts passed, failed and skipped tasks. The run ends failed with `run.finished` `reason: tasks_failed` and `failed_tasks`.

## 34. A merge conflict replanned the task instead of dropping it (FIXED, R8.1)

- Seen: the second task of a batch that conflicted went to the replan ladder.
- Fixed: `src/engine/actions/merge.ts` fails it with `merge_conflict` and `can_replan: false`, and names the colliding tasks (matched by their write and create patterns, else the earlier tasks of the batch). The first task's merge stays.

## 35. A dirty user checkout failed a successful run that `substrate merge` would not land (FIXED, R8.2)

- Evidence: with `--merge` and a modified tracked file in the user's checkout, the merge is refused. The summary says `Tasks: 0 passed ... 1 total` although the task passed, `Reason: failed`, and nothing tells the caller to commit or stash. The run is `failed`, and `substrate merge` refuses a run that did not finish with exit 0, so no next command lands the work.
- Fixed: a batch no longer checks the checkout (`src/engine/actions/merge.ts`; the run finishes with its tasks merged into the run branch). The landing checks it (`landRun` in `src/cli/commands/run.ts`): with `--merge` and uncommitted tracked changes the run stays `Status: finished` with `Merged: no`, `Exit Code: 1` (the merge command's documented refusal code) and `not_merged_reason` (`not merged: your working tree has uncommitted changes; commit or stash them, then run: substrate merge <run>`). `substrate merge <run>` lands it once the tree is clean. The message does not list the files; the owner's wording was kept.
- Tests: `test/e2e/graceful-merge.test.ts` (refused landing, then the merge succeeds), `test/e2e/merge-integration.test.ts` (d) (changed: the run no longer stops with dirty_checkout).

## 36. No command landed the passed part of a partial run (FIXED, R8.2)

- Evidence: a run with one failed task ends `failed`, and the summary says `NOT merged: N of M tasks failed or were skipped; the passed tasks stay on branch ...`. `substrate merge` refuses failed runs, so the passed work can only be reached by hand.
- Fixed: `substrate merge <run> --partial` (`src/cli/commands/merge.ts`, `verifyRunBranch`). It needs a failed run with a merged task, runs the plan's `integration_verify` on the run branch in a throwaway worktree, and merges only when that passes; otherwise it exits 1 with `not merged: integration verify failed on the run branch: <command> ...`. The failed run's summary names it in `next` and as an `or` line. Resume re-running only the failed tasks is not done (see known issue 41).
- Tests: `test/e2e/graceful-merge.test.ts` (names `--partial` next, refused on a failing verify, lands on a passing verify).

## 37. OPEN: failed tasks still go through the replan ladder before they fail

- Each failed task spends planner sessions (L1, then L2) before it is failed for good. A crash is not healed first. This is the existing R3.5 policy, kept as is. Cost and retry shape are an owner decision.

## 38. Duplicate progress line for a failed task (FIXED, R8.2)

- A task that fails its last attempt printed `failed: <class>` twice: once for the attempt and once when the ladder gave up. Fixed: `src/cli/progress.ts` prints an attempt's own failure not at all (the ladder prints its lines), and does not repeat a `failed` line for a task and class it already reported (the merge culprit path). The give-up line now carries its reason too.
- Test: `test/e2e/graceful-merge.test.ts` ("a task that fails for good is reported with one `failed` line"); `test/unit/cli/progress.test.ts` unchanged and passing.

## 39. A task could not see its siblings' edits or the user's changes (FIXED, R8.3)

- R8.2 tested the isolation that a sibling can observe: `test/e2e/graceful-concurrency.test.ts` runs two independent tasks through the built CLI with a fake worker that records its own view (probe/ listing, top-level listing, `git status --short`, README.md). Each worker sees only its own file, not the user's uncommitted tracked change or untracked file, and the run lands both on the run branch.
- R8.2 could not show the "at the same time" part, because the workers ran one after the other (known issue 40). R8.3 runs them side by side, and the same test now also asserts the overlap: each worker's trace barrier waits for the other's session and must be met.
- Tests: `test/e2e/graceful-concurrency.test.ts` (scenario 9, with the overlap assertion).

## 40. The engine ran one worker at a time, whatever `concurrency.workers` said (FIXED, R8.3)

- Was: `runEffectsLoop` ran the actions of a scheduling step one after another, so independent tasks never overlapped, and `concurrency.workers` and `backends.<b>.max_concurrency` did nothing.
- Fixed (R8.3): the loop keeps up to `concurrency.workers` worker actions in flight (`src/engine/effects.ts`, `runEffectsLoop`). When one finishes its dependents are settled and the scheduler is asked again at once, so a freed slot starts the next ready task. Every event is numbered, appended and reduced in one synchronous step against the run journal (`src/engine/journal.ts`, `commitEvent` in `src/engine/effects.ts`), so the log stays a replayable sequence with unique numbers. Git steps that change shared repository metadata (worktree and branch creation, the commit, merges into the run branch, the integration worktree, the cleanup sweep) take one lock per repository (`src/git/repo-lock.ts`); the worker processes and the verify commands do not. A merge runs one at a time and may overlap the workers. A run budget stop, a run pause (a rate limit at the floor, a permission denial, a backend that is unavailable) or an interrupt stops every in-flight worker through `ctx.runStop` and the signal, and the run settles once they have ended. A task that fails does not stop its running siblings.
- Behaviour that changed with it: a merge is made of the tasks that have passed when it starts, so the batches of a run depend on when each task finished, not on a barrier after the scheduled set. `budgets.run.max_tokens` counts the whole run (as `config.md` says); it was counted per action before.
- Tests: `test/e2e/concurrency.test.ts` (three tasks side by side with barriers met, `concurrency.workers: 1` does not overlap, never more than the limit alive, a failing task does not stop its sibling, a dependency chain beside an independent task, the journal's sequence and replay, SIGINT stopping both workers with a resume, a run budget stopping every in-flight worker, two merges at the same moment), `test/unit/git/repo-lock.test.ts`, `test/unit/cli/progress.test.ts` (the heartbeat names several running workers), and `test/e2e/graceful-concurrency.test.ts`.

## 41. `resume` of a failed run said "already finished" while the summary's `Next:` named resume (REVERSED 2026-10-21, R10.4)

- Evidence (R8.2): a run that ends `failed` (exit 1) prints `Next: substrate resume <id>` in its summary and in `next`. `substrate resume <id>` then prints `Run <id> is already finished. Nothing to resume.` and exits 0, because `isRunAlreadyFinished` in `src/cli/commands/resume.ts` treats any `run.finished` as finished. A planning failure's `Next:` (`re-runs planning; costs again`) has the same problem.
- R8.3 fix (now reversed): a failed run was refused with exit 1 and `failure_class: not_resumable`. Reason given then: the engine drops failed tasks by design.
- REVERSED 2026-10-21 (R10.4). The owner asked that any stopped run can be continued ("make it be able to be resumed if stopped for whatever reason ... write completed jobs somewhere"). Now `substrate resume` reopens a failed run (`run.reopened` event, `src/engine/reducer.ts`, `src/engine/engine.ts` `endedFailed` and `reopenData`): the failed tasks retry as a new generation with a fresh replan ladder (`ladder_base`), passed tasks stay, skipped dependents return to the queue, and the run spend still counts against the budget. A planning failure plans again; a failed final verify with every task merged re-runs only the verify. The user-visible guarantee is unchanged: failed work never lands in the user's branch; a run lands only when it finishes. The `not_resumable` path is removed. The `Next:` lines lead with `substrate resume <id>` (see `src/engine/failed-run.ts`), then `substrate merge <id> --partial` when a task passed and the plan has integration verify, then `Start a new run with a narrower request`.
- Also fixed in R10.4 while the verify-only resume was tested: a final verify that fails again after a resume tried to bisect, merged task branches the first run had swept, and became an internal error. The bisect now names no culprit when a task branch is gone (`src/engine/actions/integrate.ts`, `taskBranchExists`).
- Tests: `test/e2e/resume-any.test.ts` (partial failure retried, final verify re-run only, planning failure replanned, finished unmerged hint, session id), `test/e2e/graceful-resume.test.ts` (rewritten from the not_resumable assertions), `test/unit/engine/reopen.test.ts` (replay determinism and fresh ladder), and the pinned texts updated in `test/e2e/graceful-merge.test.ts`, `test/e2e/planner-failure-cause.test.ts` and `test/unit/cli/landing.test.ts`.
- FIXED (R10.5): a resume after a stop during planning reuses a complete, valid plan draft (`ingestPlanDraft`, `src/roles/planner.ts`; `src/engine/engine.ts` resume) and calls the planner only when there is none; an abandoned draft is kept in `drafts-<n>/`. The planner's pid is recorded under `workers/` and ended on resume.
- FIXED (R10.5): `substrate plan` ends `planned` (exit 0, `Status: planned`, the task list, `Merged: no`), not `finished` with `0/1 passed`. A reviewed plan is resumed with `substrate resume <id>` (with `--work` when the run did not record one; `run --review` records it). The edit is re-checked on resume and refused with exit 2 and the diagnostics when it fails.
- FOUND and FIXED (R10.5): the event store did not drop a torn last line, so a resume that appended after a SIGKILL during planning hit a corruption error; the resume now drops it first (`EventStoreImpl.repairTornTail`).
- OPEN (R10.5): the plan is checked twice on a resume of a planned run (by the CLI, for the diagnostics, and by the engine, when it commits). An edit made in between is caught by the engine and fails the run as an internal error instead of exiting 2.

## 42. An interrupted run did not say how to resume, and a killed CLI left a worker (FIXED, R8.2)

- Seen: SIGINT on a run with a hung worker exited 130 and printed `Status: paused`, `Reason: user_cancel`, and a `NOT merged: 0 of 2 tasks failed` line that was wrong for a paused run. A SIGKILL of the CLI left the hung worker running, with no record that would let a later resume find it.
- Fixed: the text summary ends an interrupted run with `Interrupted. Resume with: substrate resume <run-id>`, and the `NOT merged:` line is only for a failed run (`src/cli/output.ts`). Each worker session is recorded in `<run>/workers/` while it runs (`src/backends/worker-pids.ts`, `src/roles/worker.ts`); `endStaleWorkers` ends a recorded process still alive whose command line names its harness, under the run lock, at the start of a resume (`src/engine/engine.ts`).
- Tests: `test/e2e/graceful-interrupt.test.ts` (SIGINT exit 130 and SIGTERM exit 143, each within 5 s, worker gone, resume finishes without rerunning T1; SIGKILL then resume ends the worker).

## 43. OPEN: the run budget kills the worker in flight and discards its work

- Evidence (R8.2): with `--max-budget-usd 0.02` a worker that spends $0.05 is killed mid-session when the run's total passes the cap (`checkRunBudget` in `src/engine/effects.ts`, called from the task action's run policy, `kill: "budget"`). Its edits are never verified, so that task does not pass; the work is not on the run branch. The code comment on `checkRunBudget` says "at 100 percent the run pauses and the session is killed by the caller" (R1.4), so the kill is the documented behaviour and is kept.
- Direction: owner decision. Either keep the kill (the cap is hard), or let the in-flight task finish and stop before the next one (the cap is soft by one task). The per-task cap is unaffected.
- Note: the stop's `failure_class` is `budget_exhausted` (the pause reason and exit 4), not `budget_exceeded` (the class of a task that hits its own cap).


## 44. integration_verify ran after every batch, so a test-first plan failed mid-run and blamed an innocent task (FIXED, R9.1)

- Seen: live run r_4JRK6NGFMVQD (concurrency 3; T1 writes tests that stay red until T2 is merged; `integration_verify: node --test test/game.test.js`). T1 merged alone, the verify ran in the merge action (`src/engine/actions/merge.ts`) against the contract stub, bisect blamed T1 (`integration_failed`), and the run tried to replan T1 (then died: entry 45). The earlier run r_JKJKOMEEIH5C had the same T1/T2/T3 shape and passed, for two reasons in its events: its plan's verify was `sh -c 'if grep -q CONTRACT_STUB src/game.js; then echo contract-stubs-still-present-skipping-tests; else node --test ...; fi'`, which skips the tests while the stub is there; and its batches were one task at a time (T1 alone, then T2 and T3), because workers ran one at a time before R8.3. Only the first was a property of the plan; the second changed when batches formed, and the mid-run verify then ran on a state the plan never reaches at a gate.
- Fixed (R9.1): the merge action only merges (preflight and the merge into the run branch), and no verify runs between merges. `integration_verify` runs once, in the final gate (`runIntegrateAction`, `src/engine/actions/integrate.ts`), after every task is MERGED. When it fails, bisect tests the merge-order prefixes that no task outside them depends on, and names a culprit only when the last such prefix that passes is the one just before the first that fails (the base counts as passing only when the base check passed; a single-task run is blamed, since its one task is the whole change). Otherwise the run fails with `integration_failed: <cmd> exited <n>` and the output tail, and names no task. A culprit's failure puts the run back in EXECUTING (`src/engine/reducer.ts`, `task.failed`), so its replan runs; its merged work stays on the run branch.
- Tests: `test/e2e/integration-timing.test.ts` (T1 the live plan 3/3 with one verify after the last merge; T2 a broken implementation fails gracefully with no culprit; T3 a verify failing on every state names no culprit; T4 a culprit found at the final gate is replanned and the run finishes). Pinned text updated: `test/e2e/integration-base.test.ts` (comment only; its assertions hold under the final gate).

## 45. An unexpected engine error left the run without a summary (FIXED, R9.1)

- Seen: live run r_4JRK6NGFMVQD: after `replanning T1` the CLI printed `Error: unrendered placeholder in template` on stderr and exited 1, with no summary, no `run.finished`, and task worktrees and branches left behind (the run's stderr). Cause: `render()` in `src/prompts/render.ts` checked the substituted output for `{{`. The L2 replan template (`assets/prompts/planner/replan-l2.md`, `{{contracts}}`) carried the contract stub's JSDoc type `{{ x: number, y: number }}` (`src/game.js:19` in that run), so the check threw.
- Fixed (R9.1): `render()` checks only the template text for a stray `{{`; a value is inserted as data. The engine (`src/engine/engine.ts`, the run and the resume paths) catches an unexpected exception through `failRunOnInternalError` (`src/engine/internal-error.ts`): the stack goes to `error.txt` in the run directory, a `run.finished` with `failure_class: internal_error` and the message is appended, the workspaces are swept (the work of unmerged tasks stays under `packets/`), and the normal failed summary prints with `Reason: internal error: <message>` and the bug `Next:` line. The loop (`runEffectsLoop`, `src/engine/effects.ts`) stops and settles its workers before an error leaves it. An interruption keeps its own exit codes (130, 143).
- Tests: `test/e2e/graceful-internal-error.test.ts` (the injected exception is a broken project prompt override, `.substrate/prompts/worker/task.md`: no stack on stdout or stderr, the summary, exit 1, `error.txt`, the terminal event, no worktree or task branch left; and the json object); `test/unit/prompts/replan-render.test.ts` (every replan, planner, correction, reviewer, worker and heal template rendered for every failure class, with values that hold `{{`). Pinned assertion updated: `test/unit/prompts/render.test.ts` ("throws when a substituted value leaves {{ behind" is now "inserts a value that contains {{ unchanged").

## 46. OPEN: bisect trusts a whole-project verify on a prefix of the plan

- Evidence (R9.1): a culprit is named from the verify's result on a prefix of the merged tasks, and the verify is whole-project. Only a dependency absence is excluded (a prefix is not tested while an outside task depends on it). A verify that fails because an independent task that is not in the prefix is missing is not excluded. The rule limits the risk (a culprit needs the adjacent prefix to pass) but does not remove it; this was not reproduced.
- Direction: owner decision. Either keep this (a culprit is named only when the adjacent prefixes split cleanly) or run the final verify per task in its own worktree.

## 47. OPEN: a culprit found at the final gate is replanned on top of its merged work

- Evidence (R9.1): the culprit's code is already on the run branch when the final gate fails, so its replan works from the run branch and edits that code in place (generation 2). The planner's replan prompt says merged work is fixed. Covered by `test/e2e/integration-timing.test.ts` (T4) only.
- Direction: owner decision if un-merging a culprit is wanted instead.

## 48. OPEN: summary and transcript details for a headless caller

- Cosmetic and unprioritised. Observations from the live runs:
- (a) `still working: planning` repeats every 15 s for several minutes, with no detail on what the planner is doing.
- (b) FIXED (R12.3): plan lint warnings are printed. The accepted plan's warnings go to `plan-warnings.txt` in the run directory, on the `plan.produced` event (`warnings`, `warning_count`), into one note line after `plan ready` (text progress and `substrate plan`), and into the json result as `plan_warnings`. Code and tests: `src/roles/planner.ts` (`planWarningsOf`, `writePlanWarnings`), `src/cli/progress.ts`, `test/e2e/lint-soft.test.ts`.
- (c) `Session ID` and `Run ID` both appear in the summary and are easy to confuse.
- (d) FIXED (R11.3): the base-check note appeared on every run that adds code. It now prints only after a final verify that fails, and says the check was failing before the run (`src/cli/progress.ts`, `withBaseNote`).
- (e) The worktree preparation lines go to stderr, not stdout.

## 49. `status` read a finished or failed run as `EXECUTING` (FIXED, R10.2)

- The status reader used the plain reducer, which ignores `run.finished`, so a run that had ended printed `State: EXECUTING`. It now uses the journal's reduction (`src/engine/journal.ts`), which sets the state the exit code names.

## 50. OPEN: a run that ends before a summary writes no summary.txt or result.json

- R10.2 writes the outcome files from the summary the formatter renders. The run command's own error returns (a run lock refused, an exception outside the engine) end before any summary, so no outcome files are written for them. Engine-level failures (internal errors, interrupts, budget stops) do write them.
- Direction: a small follow-up if a caller needs a file for every exit.

## 51. OPEN (owner decision): the json `tasks` field stays an object, so the task rows are `task_list`

- R10.2 asked for a `tasks` array in `status --output-format json`. `status` already had a `tasks` object keyed by task id, and the rule is that existing json fields are kept. The rows are in `task_list` instead.
- Direction: the owner says whether `task_list` is the name to keep, or whether a breaking change to `tasks` is wanted.

## 52. OPEN: `watch` replays from the journal, so a replay has no heartbeats and no landing line

- A live run prints heartbeat lines and the `merged into <branch>` line; both are not journal events, so `watch` shows them only in the summary. `watch --no-follow` on a finished run therefore shows the history without the landing line and without the summary block; a followed or completed watch prints the summary from `summary.txt`.
- The start line's models are recovered from the roles the run.created event recorded and the settings now on disk, so they can differ from the live line if the settings changed since the run started.

## 53. FIXED (R10.3): a resumed `--no-merge` run landed, because resume took the setting

- Seen (R10.1 caveat): `--no-merge` kept one run on its branch, but a resume without flags read the setting and merged the run.
- Fixed: `run.created` records the effective `merge` and `concurrency` (`src/engine/engine.ts`, `src/contracts/events.ts`). A resume uses them unless `--merge`/`--no-merge` or `--concurrency` is given again (`src/cli/commands/resume.ts`). A log without the fields uses the setting.
- Tests: `test/e2e/control.test.ts` ("a --no-merge run stopped and resumed without flags does not land", "the same run resumed with --merge lands", "a resume without flags keeps the recorded worker count", "a run whose run.created has no merge or concurrency field resumes with the setting, and lands").

## 54. OPEN: `stop --force` is tested only with an injected process control

- The CLI handles SIGTERM with a graceful stop that ends in well under 15 s, so no fake-harness run ignores it deterministically. The force path (SIGKILL after the wait, the pid checked again before the kill) is covered by `test/unit/cli/stop.test.ts` with an injected control, not by a run that refuses to stop.
- Not a defect; a test gap.

## 55. OPEN: `stop` leaves a run whose lock is stale but whose process is alive

- `stop` acts only on a lock whose heartbeat is fresh (`runProcessOf`). A run whose process is alive but whose heartbeat is older than 30 s is reported as `not running (stopped)` and its process is not signalled. A hung CLI of that kind needs `kill` by hand, or `stop` after the process exits.
- Owner decision needed: signal a live Substrate process whose heartbeat is stale, or keep the refusal.

## 56. OPEN (owner decision): `run --detach` checks the request in the started process

- The brief asked for the preflight to run in the parent before it starts the child. It runs in the child instead, so the errors come back through the child's log tail with exit `2`, a fraction of a second later (248 ms in the test), and no run is created. The messages are the same as a foreground run's (`run --detach` tests in `test/e2e/control.test.ts`).
- Owner decision: keep this, or move the preflight into the parent.

## 57. OPEN (owner decision): the request has no `concurrency` field

- The request payload has `budget` for money and time limits; a worker count has no natural place in it. `--concurrency` is the only way to set it (run, resume, plan). A caller using only `--request` cannot set a worker count per run.
- Owner decision: add a request field, or keep the flag only.

## 58. OPEN: `plan --concurrency` is accepted and does nothing

- A plan starts no workers. The flag is validated (1 to 16) and accepted so that one command line works for `run` and `plan`. Nothing records or uses the value.


## 59. FIXED (R11.1): a resume rebuilt the request, the budget and the run lists from its options

- Seen (live runs, 2026-10-21): `substrate stop` during planning, then `substrate resume`, planned again with `## Request` followed by `(none)`, asked three questions and paused (`substrate-hello-5`). The resume read `options.prompt`, which is absent on a resume (`src/engine/engine.ts` `resume`; `src/engine/actions/plan.ts`, `route.ts` and `solo.ts` read `ctx.prompt`). A resumed run also lost `--max-budget-usd` (`status` showed `budget $5.00` for a 0.40 run), and its verify, context, permission, sandbox and history flags.
- Fixed: `run.created` records `max_budget_usd`, `verify`, `context`, `permissions`, `sandbox` and `history_all` (`src/engine/recorded-run.ts` `runInputsRecord`, `src/contracts/events.ts`). One helper, `recordedRunOptions`, reads them back, and the latest `run.resumed` or `run.reopened` that replaced the budget wins. `engine.resume` and `src/cli/commands/resume.ts` use it for the prompt, mode, permission mode, settings overrides, landing and worker count. `src/cli/commands/status.ts` shows the recorded budget. `run.budget.exceeded` from a finish or a solo stop carries its spend and cap, and the landing's budget stop reads the recorded cap before the flag.
- Tests: `test/e2e/resume-planning.test.ts` (A strengthened, D: a real `substrate stop` during planning), `test/e2e/resume-any.test.ts` (planning failure strengthened, (e) repeated planning failure, the resumed replan), `test/e2e/graceful-budget.test.ts` (the R11.1 budget cases).

## 60. FIXED (R11.2): `--timeout` has no effect on a run

- Found (R11.1): `--timeout <seconds>` set `budgets.run.max_wall_min`, and no code read that setting. The flag was neither enforced nor recorded, so a resume had nothing to keep.
- Fixed: the run process's clock (`src/engine/time-limit.ts`, started in `engine.run` and `engine.resume`) aborts `EffectContext.timeout`. The effects loop (`src/engine/effects.ts` `runEffectsLoop`, `onTimeLimit`) pauses the run with reason `timeout` and stops the workers through `runStop`; the planner, the solo worker and the replan ladder stop on `interruptOf(ctx)`. The stop is a budget stop: exit `4`, `Reason: timeout: the run reached its <n>s time limit; ...`, `Next: substrate resume <id> --timeout <2n>`. `run.created`, `run.resumed` and `run.reopened` record `time_limit_s`; a resume reuses it and `--timeout` replaces it. `--timeout` takes whole seconds, 1 or more (exit `2` otherwise). The request's `budget.max_wall_min` (minutes) is the same limit and is enforced too; no new request field was added.
- Tests: `test/e2e/graceful-timeout.test.ts` (held worker, resume reuses and replaces the limit, planning-phase timeout, a limit that is not reached, invalid values).

## 61. OPEN: a resumed planning round after an answer relies on the planner session

- Found (R11.1, not reproduced): the answers path (`src/engine/actions/plan.ts`, `hasAnswers`) sends only `planner/answers.md` to the planner, on the session the pause recorded (`session_id`). The request text is in that session, not re-sent. A pause that recorded no session id would plan without the request. Direction: include the recorded request in the answers prompt when the session cannot be resumed.

## 62. FIXED (R11.2): a worker-killed budget stop records the cap but not the spend

- Found (R11.1): the budget kill of a worker in flight (`src/engine/actions/task.ts`, the harness-reported budget kill) emitted `run.budget.exceeded` with the cap only, so the progress line read `spent $0.0000` for that event.
- Fixed: the event carries `cost_usd: runSpend()`, the run's recorded spend at the kill (the same figure the other budget stops use). The progress line (`src/cli/progress.ts`) already printed `cost_usd`, so its text is unchanged and now shows the spend.
- Tests: `test/e2e/graceful-budget.test.ts` ("a budget kill by the harness records the spend"). A worker call with `failure: "budget"` stands in for the harness's own budget stop.

## 63. FIXED (R11.2): `plan_review` was emitted as a `run.reopened` reason the catalog did not list

- Found (R11.1): `src/engine/engine.ts` (`resume`) emits `run.reopened` with `reason: "plan_review"` when the reviewed plan is accepted (R10.5), and `RunReopenedEvent` in `src/contracts/events.ts` listed only `planning`, `setup` and `tasks`. `readCatalogEvents` (`src/cli/commands/status.ts`) drops any line the catalog refuses, so the reopen was missing from `status` and `watch`.
- Fixed: the catalog lists `plan_review` (`src/contracts/events.ts`). The engine emits through its own append, which does not check the catalog, so the reason is now checked by the catalog the reader uses.
- Tests: `test/unit/cli/reopen-reason.test.ts` (the catalog accepts a plan_review reopen and refuses an unknown reason; `readCatalogEvents` keeps the reopen).
- DECISIONS.md (`docs/plan/DECISIONS.md` line 93) still names only `planning`, `setup` and `tasks`; it is append-only and no decision changed, so it was not edited. The owner may want a dated note.

## 64. FIXED (R11.1): `status` said one run state three ways, and a paused run read as ended

- Seen (live runs, 2026-10-21): after `substrate stop` the header said `interrupted`, the legacy block said `State: PAUSED` and `Pause Reason: user_cancel`, and `Phase:` and `Process:` said `ended` and `none (the run has ended)`. A paused run is not over. The cost showed as `$0.2075` in one block and `$0.21` in the other.
- Fixed in the text form (`src/cli/commands/status.ts`): the header word carries the reason (`headerWordOf`), `Phase:` reads `paused` or `planned`, `Process:` names the resume, and the legacy `=== Run Status ===` block keeps only the pending questions and the task table. Costs have four decimals. The JSON fields keep their values.
- Tests: `test/e2e/graceful-budget.test.ts` ("status says each fact once"), `test/unit/cli/status-words.test.ts`. No pinned text needed changing; the existing status tests pass unchanged.

## 65. FIXED (R11.2): two output and undo tests failed under load

- `test/integration/cli/commands.test.ts` "reverts the run branch to the last batch checkpoint ref" (1 in 3 runs with 8 in parallel). Cause: the two worker calls of the scenario were untagged, so each concurrent worker took whichever edit was next. A worker's edits outside its write scope are dropped at the merge, so both batches merged nothing: the batch checkpoints all equal the run tip, and `undo` (`src/cli/commands/undo.ts`) has no earlier checkpoint to revert to (exit 1). Fix: the calls carry `task: "T1"` and `task: "T2"`, so each worker takes its own edits. The test also gets a 60 s limit: its fixture is a real two-task run, and the default 5 s limit failed under load.
- `test/integration/cli/output.test.ts` "text progress prints the tracked event lines": the failing assertion compared two offsets in stdout (`[task T1] started` before `[task T2] started`, `459 to be less than 386`). Two tasks run at once (the default is three workers), so which one starts first is not fixed. Fix: the calls are tagged by task, and the assertion now checks that the started lines follow the journal's `task.session.started` order, and that each task's started line precedes its merged line. There is no wall-clock threshold in this test.

## 66. OPEN (cosmetic): the planner's cost shows as $0.0000 until its session ends

- Seen (live run `r_JEKHABPOAS5N`, 2026-10-21): during the planning phase the progress line and `status` show `Cost $0.0000` (or pending) for the whole planner session. claude reports the session's cost only when the session ends, so the engine has no figure earlier. The true cost appears in the planner's usage row once the session finishes (`usage.recorded`, role `planner`).
- Direction: none planned. A live estimate would need a cost source other than claude's end-of-session report.

## 67. MOOT (R12.1, 2026-10-21): two budget numbers for one run

- Moot: the planner's `budget` figures are now advisory estimates (R12.1) and never a cap, so the manifest figure no longer competes with the run cap. The run cap is the one the caller sets (`--max-budget-usd`, the request's `budget`, or `budgets.run.max_usd`). The L025 warning still names the two when the caller set a run cap.
- The text below is the state before R12.1.


- Found (R11.3, from `src/`): the engine enforces `settings.budgets.run.max_usd`. The CLI flag `--max-budget-usd` writes that setting (`src/cli/request.ts` sets `budget.max_usd`, and `src/cli/request.ts` maps it to `overrides.budgets.run.max_usd`). The manifest's own `budget.max_usd` is not a run cap: the engine does not stop a run at it, and the only reader is lint rule L025 (`src/spec/rules.ts`), which warns when the manifest figure is above the run cap. A run can therefore show a manifest budget (for example $1.50) and a run budget (for example $3.00) that differ, and the run budget is the one that stops it.
- Direction: none planned. The text output shows the run budget only.

## 68. OPEN (cosmetic): `summary.txt` repeats the progress lines it follows

- Found (R11.3): `summary.txt` starts with the last progress lines of the run (in run `r_JEKHABPOAS5N`: `merged into master` and `run ... finished: 3/3 passed`), the same lines `progress.log` ends with, then the `--- Run Summary ---` block. Both are written by the run; the text is correct, but a reader sees the lines twice when reading the two files one after the other.
- Direction: none planned; drop the repeated lines from `summary.txt` if the owner wants it shorter.

## 69. FIXED (R12.1): flat default caps ended hard tasks, and planner estimates were enforced

- Found (owner, 2026-10-21): the defaults capped every run and task whatever its difficulty. `budgets.run.max_usd` 5, `budgets.task.max_usd` 0.5 and `budgets.task.timeout_min` 30 (fallback) applied to every run. The planner's per-task `budget` in each spec (and the manifest's) was enforced as a hard kill (`src/engine/actions/task.ts`, `src/roles/worker.ts`), and lint L016 made a planner ask for more than $0.50 an error, so a hard task could never get more than $0.50. `budgets.approval_threshold_usd` 2 paused a run `needs_approval` on the plan's estimate under the default mode.
- Fixed: every limit is off unless the caller sets it. The planner's per-task and manifest budgets are estimates: they feed the approval estimate and the lint, and nothing ends a task or a planner session. Settings caps (`budgets.task.max_usd`, `budgets.task.timeout_min`), `--max-budget-usd`, `--timeout`, `SUBSTRATE_MAX_BUDGET_USD` and the request's `budget` still enforce as before when set. `status` prints `budget: none` and `budget_usd: null`; `run.created` records `max_budget_usd: null`.
- Consequence: a worker that produces no output and never ends runs until `--timeout` (when set) or `substrate stop <id>`. Nothing else ends it.
- Tests: `test/e2e/limits-optin.test.ts` (no-limit run past the old $0.50 cap, estimate above $2 without a pause, advisory spec budget versus the enforced settings cap, `--max-budget-usd` still stops, argv carries `--max-budget-usd` only when set, status, resume, lint, planner request), `test/unit/spec/rules.test.ts` (L016), `test/unit/contracts/schemas.test.ts` (SpawnRequest budget).

## 70. FIXED (R12.2): the plan's setup never ran where the final check runs, so a correct plan failed its own check

- Found (owner run `r_ZEEOKTFXRD33`, "port this project to typescript", 2 tasks): the final `integration_verify` (`npx tsc -p tsconfig.json && ...`) failed with `This is not the tsc command you are looking for ... Use yarn to avoid accidentally running code from un-installed packages`. The plan's `setup` (`npm install --no-save typescript@5 @types/node@20`) had run only in each task worktree; `node_modules` is gitignored, so the integration worktree had no TypeScript and `npx` fetched a stub package. The run's two tasks had passed and stayed on `substrate/runs/r_ZEEOKTFXRD33`.
- Fixed: the plan's setup runs once in the integration worktree before the final verify, and in the `merge --partial` verify worktree (`src/git/setup.ts`, `setUpWorktree`; `src/engine/actions/integrate.ts`; `src/cli/commands/merge.ts`). A marker in the worktree's git directory keeps repair attempts and re-verifies from reinstalling; a worktree created again after a resume runs the setup again. Progress: `setting up the integration check (<n> setup commands)`, `setup done` or `setup failed: <command> (exit <n>)`. Events: `integration.setup.started` and `integration.setup.finished` (new).
- Fixed in the same change: the base check (R7.11) is removed. It ran `integration_verify` on the base commit before the final verify and printed a note that misled the owner ("the check was failing before this run started"). `integration.started` no longer carries `base_verify_passed`; the schema keeps the field optional for older logs. The bisect keeps its base anchor: the base is verified only after the final verify has failed, inside the bisect (known issue 46).
- Tests: `test/e2e/integration-setup.test.ts` (the reproduction: a two-task plan whose check needs the setup's file; setup once in the integration worktree; base check gone; `merge --partial` runs the setup), `test/e2e/integration-base.test.ts`, `test/e2e/integration-timing.test.ts`, `test/unit/cli/progress.test.ts`, `test/integration/git/workspace.test.ts`.

## 71. FIXED (R12.2): a check that could not run failed the run, and a one-task plan verified its one task twice

- Found (owner, 2026-10-21): "Substrate's own checks keep stopping normal work". The final `integration_verify` of a plan whose tool was missing (`npx tsc` with no typescript, a command not found, a setup that failed) failed the whole run, although nothing had been checked. A one-task plan also ran its final verify on the same change its own verify had already checked in its worktree.
- Fixed: the final check is classified (`src/engine/verify-outcome.ts`). `failed` is a verdict and still fails the run (exit 1). `could_not_run` (the setup failed; exit 127 or 126; a command could not start; a tool-missing marker in `src/engine/verify-markers.ts`; a timeout) finishes the run with exit 0 and lands the work with a warning: `warning: integration verify could not run (<command>: <reason>); the work is merged but was not verified as a whole`, `Verification: not run (<reason>)` in the summary, and `verification: "not_run"` and `verification_note` in the json and `result.json`. A one-task plan with `integration_verify` records `integration.skipped` (`reason: single_task`) and runs no final verify; `verification` is `skipped`. `merge --partial` treats a check that could not run as a warning too.
- Not in the marker list, on purpose (a false negative is a failed run, a false positive hides a real failure): `Cannot find module` (it matches a missing project module as well as a missing tool). Add a marker only with an example of its output.
- Tests: `test/unit/engine/verify-outcome.test.ts` (the classifier table, the stub message from the evidence, the marker list verbatim), `test/e2e/integration-setup.test.ts` (setup failure, exit 127, the tsc stub, timeout, a real failure, the single-task skip), `test/e2e/integration-base.test.ts` (its tests moved to two tasks, since a single task is not verified), `test/integration/scenarios/scenario-10-batch-merge-properties.test.ts` (the single-task case: no verify, no bisect).

## 72. FIXED (R12.2): a failed final check said "0 of 2 tasks failed" and hid its output

- Found (owner, 2026-10-21): the summary of a run whose final integration check failed read `NOT merged: 0 of 2 tasks failed or were skipped; the 2 passed tasks stay on branch ...`, which says nothing failed, and `Reason:` gave the command with the last output line on the same line, so the cause was not visible.
- Fixed: an integration failure reads `NOT merged: the integration check failed (see Reason); the <n> tasks passed their own checks and stay on branch <branch>`. `Reason:` is the command and its exit code (`<command> exited <n>`, or `timed out`). The text summary prints the last ten non-empty lines of the failing command's output under `Output:`, from `integration.failed.output_tail` (already redacted and path-stripped), and the json and `result.json` carry the same tail as `output_tail` (a new summary field). Planning and task failures keep their lines.
- Tests: `test/e2e/integration-setup.test.ts` (the summary wording, one Reason line, the ten-line tail, `output_tail` in result.json), `test/unit/engine/integration-failure.test.ts` (the message is the command and exit code only).

## 73. OPEN (R12.4): a WRONG final check is not handed back to the planner

- Found (owner, 2026-10-21): a failed final check has three possible owners. An environment mismatch is Substrate's (R12.2: a could-not-run check is a warning). A CODE failure belongs to a worker (R12.4: up to `integration.repair_attempts` automatic repairs, see cli.md). A WRONG or uncheckable check (a command that tests the wrong thing, or one that cannot be satisfied by any code change) belongs to the planner.
- Not done in R12.4, on purpose: the planner amendment. Nothing re-plans the check itself. A check that is wrong runs its repairs, which cannot make it pass, and the run fails with the repair outcomes listed. The `CHECK-UNFIXABLE` line is the worker's way to say the check cannot be fixed by code; the owner's decision on the planner amendment phase is still needed before it is built.

## 74. OPEN (R12.4 known limit): a repair can edit a script the check invokes

- The repair guard (`src/engine/repair-guard.ts`) reads the commit: it rejects an empty change, a deleted or renamed-away test file, an added skip marker, and a change under `.substrate/`. It does not know what a check runs. A worker that edits a script the check calls (for example a verify script that the check's command runs) can make the check pass without changing a test. The limit is documented in cli.md. Not solved; the merged change needs review.

## 75. OPEN (R12.2 restated, still true in R12.4): a task's own verify that cannot run is still a failed task

- The final check's could-not-run rule (R12.2) does not reach a task's own verify. A task whose verify command is not installed (exit 127, a tool-missing marker) still fails `verify_failed`, heals, and replans, as before R12.2. A repair does not change this. Left as it was; the owner's rule ("a check that cannot run is a warning") would apply here too, and needs a decision on the verify path.

## 76. OPEN (R12.4): the culprit search ignores repair commits

- The bisect (R9.1) tests the merged task branches in merge order, on the base. A repair commit that the run branch holds (a merged repair that the re-run rejected, or the commits of an earlier round) is not in those prefixes. A culprit named after exhausted repairs may therefore be a task whose prefix only fails because the repair is missing. The bisect runs only when the repairs are exhausted, so this is at the end of a failed run; the failed run's output still shows the last check's output.

## Open items after R13/R14 (2026-10-22)

- 77. OPEN: the claude adapter now sends prompts on stdin (R13.1). It is confirmed only against the fake harness; it needs one live smoke run before it is trusted.
- 78. OPEN: the opencode and agy adapters still pass the prompt as an argument, so a very long prompt can hit E2BIG. Their CLIs are not yet checked for stdin support.
- 79. OPEN: `scripts/check-boundaries.mjs` does not check template-literal imports outside the strict areas. This hides `src/engine/actions/plan.ts` importing `cli/questions.js` and `src/index.ts` importing the dispatcher.
- 80. OPEN: an amendment the engine applies can leave the manifest and the event state inconsistent if the process crashes between the manifest write and `run.amended`.
- 81. OPEN: the web UI holds two SSE connections per page, so more than about three open tabs can stall under HTTP/1.1.
- 82. OPEN: the service stream recomputes every run once a second, so its cost grows with many large runs.
- 83. OPEN: integration verify output is not read by the API.
- 84. OPEN: a live task that failed counts as kept for amendments.
- 85. OPEN: service install is not supported on Windows or macOS.
- 86. OPEN: starting a job from the browser is not built (design doc phase 2).
- 87. OPEN: the Ctrl+K palette and the Ctrl+O toggle are not built.
