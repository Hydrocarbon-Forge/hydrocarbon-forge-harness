# START HERE

If you are an AI coding agent working in this repository, this page is your complete briefing. Read all of it, then do what it says. Do not read other documents until you need them.

## 1. What this repository is
**Substrate** is a command-line tool (TypeScript, Node 22+). Other AI agents (mainly one called Hermes) and people call it with a coding request. It asks one strong "planner" model to write a plan, then runs cheaper "worker" models on the plan's tasks, one headless process of an existing tool (Claude Code `claude`, OpenCode `opencode`, or Antigravity `agy`) per task, each in its own git worktree. The engine (ordinary code, not an AI) checks every task with real commands and merges only what passes. It also reports which models exist and how many tokens (input, output) and how much money each model used.

## 2. Your job, and what it is not
A first version of this code was written by a model that **scaffolded**: it wrote types, interfaces, parsers and tests, but left the real behaviour unimplemented, unwired, or faked. The result: the tests are green but the tool does not work. **Your job is the opposite of scaffolding.** Every work package (WP) is finished only when the behaviour works end to end through the command line and the commands in the spec's `Done when` section pass. A function that is written but never called is a failure. A test that only checks a fake is a failure.

## 3. Your first action
1. Open `docs/plan/PROGRESS.md`.
2. Take the first row with Status `TODO` whose dependencies are all `DONE`. Today that is **R0.1**.
3. Open `docs/plan/wp/<ID>.md` (for R0.1: `docs/plan/wp/R0.1.md`) and do exactly what it says.

Do not start any other WP first. Do not reorder.

## 4. The work loop (repeat for each WP)
1. Read the whole spec. Read the files in its `read` list. Read other files only when you need a fact.
2. If the spec lists tests, write them first, run them, and confirm they fail for the right reason.
3. Implement. Change only files in the spec's `write` and `create` lists. Do not touch `protected` files. After each file you finish, run the narrowest test for it; do not write ten files and test at the end.
4. Run every command in the spec's `verify` list and every command under `Done when`. All must pass. Also run `npm run typecheck`, `npm test`, and (once it exists) `npm run check`.
5. Do the proof the spec asks for (usually a command that runs the built CLI) and look at the real output. If it does not show the behaviour, you are not done.
6. If the spec says to remove entries from `scripts/debt-allowlist.json`, do it, and make sure `npm run check` still passes.
7. In `docs/plan/PROGRESS.md` set the WP to `DONE` and write one line in Notes saying what you ran to prove it.
8. Commit: `git add <the specific files you changed>` (never `git add -A`) and `git commit -m "<ID>: <title>"`. Never push, never rewrite history.
9. Go to the next WP. Stop only for a reason in section 8.

## 5. Hard rules (each one exists because the first version broke it)
1. **No scaffolding.** No stubs, `TODO`, `FIXME`, "not implemented", empty bodies, hard-coded return values, or placeholder data in `src/`. If you cannot finish something, stop and follow section 8.
2. **Wire it.** Every new function must be called from code that runs when the CLI runs. After writing it, find its caller. If there is none, you are not done.
3. **No test code in `src/`.** `src/` must never import from `test/`, never check whether it is running under a test, never contain special strings that only a test uses, and never fabricate data to make a test pass.
4. **Real behaviour, real proof.** Prove features by running the built CLI (`npm run bundle`, then `node dist/substrate.mjs ...`) or the E2E driver (`test/e2e/helpers/run-substrate.ts`, once it exists), not by calling internal functions from a unit test.
5. **Prompts live in `assets/`.** Never write prompt text in TypeScript. The prompts are already written in `assets/agents/*.md` and `assets/prompts/**`; read `assets/prompts/README.md` for how they are used.
6. **Stay in scope.** Edit only the files the spec lists. If a task needs another file, write it in `docs/plan/BLOCKED.md` and stop.
7. **Decisions are final.** `docs/plan/DECISIONS.md` is binding. If any other document disagrees with it, DECISIONS wins. Do not re-decide anything it settles.
8. **Not building:** an orchestrator AI, native subagents, the governor/local triage model, the TUI, an MCP server, security hardening (sandboxes, secrets handling). If a spec seems to need one, stop.
9. **Never write a LAN address, IP or port into a committed file or a prompt.**
10. Do not weaken, skip, or delete an existing test to make something pass. If a test is wrong, say why in `docs/plan/BLOCKED.md`.

## 6. Commands
```
npm run typecheck          TypeScript check
npm test                   all tests (vitest)
npm run check              static tripwires (exists after R0.1): purity, wired, events, settings, boundaries, docs
npm run check:plan         validates docs/plan specs
npm run bundle             build dist/substrate.mjs
node dist/substrate.mjs <command>     run the built CLI
npx vitest run <path>      run one test file or folder
```
If a command prints a lot, redirect it (`> /tmp/out.txt 2>&1`) and read the last 60 lines.

## 7. Where things are
```
START-HERE.md              this page
docs/plan/DECISIONS.md     binding decisions (read once, early)
docs/plan/PROGRESS.md      the checklist you update
docs/plan/IMPLEMENTATION-PLAN.md   all WPs in order, short descriptions
docs/plan/wp/<ID>.md       the spec for each WP  (your instructions)
docs/plan/reference/       audit notes (optional reading)
assets/agents, assets/prompts      the prompt library (already written)
src/                       engine, CLI, adapters, roles, git, verify, spec, store
test/                      unit, integration, conformance, e2e (new), fixtures
scripts/                   build and check scripts
SUBSTRATE-PLAN.md          original design; still authoritative except where DECISIONS.md overrides (see banner at top)
docs/reference/            user-facing reference docs (partly inaccurate until R5.2)
docs/archive/              old material; do not implement from it
build/                     legacy bootstrap kit; ignore it (see build/README.md)
```

## 8. When to stop and ask
Create or append to `docs/plan/BLOCKED.md` (WP id, what you tried, the exact error or conflict) and stop working if:
- a spec contradicts DECISIONS.md, the code, or itself;
- a required command still fails after three honest attempts to fix the cause;
- you would have to edit a file outside the WP's lists, or a `protected` file;
- the spec says `VERIFY FIRST` and the check you ran contradicts it;
- an external tool (`claude`, `opencode`, `agy`) behaves differently from what the spec says.
Do not guess, do not work around, do not mark the WP DONE.

## 9. After the last WP
R5.5 archives the plan and updates this page. Until then, keep this page unchanged.
