# START HERE

If you are an AI coding agent working in this repository, read this page, then the binding decisions in `docs/plan/DECISIONS.md`. Other documents are reference material; open them when you need a fact.

## 1. What this repository is
**Substrate** is a command-line tool (TypeScript, Node 22+). Other agents (mainly Hermes) and people call it with a coding request. It asks a planner model for a plan, then runs worker models on the plan's tasks: one headless process of an existing harness per task (Claude Code `claude`, OpenCode `opencode`, or Antigravity `agy`), each in its own git worktree. The engine is ordinary code, not an AI. It checks every task with real commands and merges only what passes. It also reports the models, the tokens (input and output) and the cost per model.

## 2. Current state
The R-series work packages are complete. Their specs, the progress checklist, the implementation plan and the findings log are archived at `docs/archive/2026-10-20-r-series/` (`wp/`, `IMPLEMENTATION-PLAN.md`, `PROGRESS.md`, `BLOCKED.md`). That archive is history only. Do not implement from it. The findings that are still open are in `docs/known-issues.md`.

## 3. Binding decisions
`docs/plan/DECISIONS.md` is binding. If another document disagrees with it, DECISIONS wins. `docs/plan/reference/` holds audit notes that explain past decisions; it is optional reading. If you find a conflict that DECISIONS does not settle, stop and ask the owner. Do not choose silently.

## 4. Where things are
```
START-HERE.md                        this page
docs/plan/DECISIONS.md               binding decisions
docs/plan/reference/                 audit notes (optional)
docs/design/web-ui.md                browser UI design study and HTTP API contract (R14)
docs/reference/                      user-facing reference: cli, config, adapters, caller-guide, local-model
docs/known-issues.md                 open findings, with the owner decisions they need
docs/spikes/                         measured facts about the three harnesses
docs/archive/2026-10-20-r-series/    archived R-series plan (history only)
src/                                 engine, CLI, backends, roles, git, verify, contracts, store
assets/agents, assets/prompts        the prompt library
test/                                unit, integration, conformance, e2e, fixtures
scripts/                             build and check scripts
SUBSTRATE-PLAN.md                    original design; DECISIONS.md overrides it where they differ
build/, docs/archive/                legacy material; ignore
```

## 5. The CLI and how to check it
The built CLI is `dist/substrate.mjs`. Its commands are `run`, `plan`, `resume`, `status`, `watch`, `runs`, `tasks`, `usage`, `report`, `verify`, `merge`, `undo`, `discard`, `models`, `agents`, `backends`, `sessions`, `config`, `doctor`, `init`, `history`, `archive`, `charter`, `gc` and `bench`. `docs/reference/cli.md` documents each one.

```
npm run typecheck         TypeScript check
npm test                  all tests (vitest), about four minutes
npm run check             static checks: purity, wired, events, settings, boundaries, docs
npm run docs:check        documentation links and required files
npm run bundle            build dist/substrate.mjs
npm run gate:g5           reads the recorded live-smoke result; reads records only
node dist/substrate.mjs <command>     run the built CLI
npx vitest run <path>    run one test file or folder
```

For non-live work, put the fake harnesses first on `PATH` so that no real model is called:
`export PATH="$PWD/test/fixtures/fake-harness/bin:$PATH"`.

## 6. Rules that still apply
1. Do not scaffold. No placeholder bodies, markers such as TODO or FIXME, hard-coded return values or placeholder data in `src/`. A function that nothing calls is unfinished.
2. Every new function is called from code that runs when the CLI runs.
3. `src/` never imports from `test/`, never checks whether it runs under a test, and never holds test-only branches or fake data.
4. Prompt text lives in `assets/`, never in TypeScript.
5. Never run a live harness (`claude`, `opencode`, `agy`) or `npm run test:live` without the owner's explicit go-ahead. Live runs cost money.
6. Do not weaken, skip or delete a test to make a change pass. A failing test is a finding to report.
7. Security hardening (sandboxes, secret handling, environment scrubbing) is out of scope, per DECISIONS A6.
8. Never write a LAN address, an IP address or a port into a committed file, a spec or a prompt.
9. Do not edit `build/` or `docs/archive/`.
