# Instructions for AI coding agents

Read `START-HERE.md` in full before doing anything, and follow it exactly. In short:

- Work on one work package at a time, taken from `docs/plan/PROGRESS.md` in order. The first one is R0.1.
- Your instructions for each work package are in `docs/plan/wp/<ID>.md`. Binding decisions are in `docs/plan/DECISIONS.md`.
- Do not scaffold. Implement the behaviour, wire it so the CLI runs it, and prove it by running the built CLI.
- Never import from `test/` in `src/`, never add test-only branches or fake data to `src/`, never put prompt text in TypeScript.
- Stay inside the files the work package lists. If blocked, write `docs/plan/BLOCKED.md` and stop.
- Ignore `build/`, `docs/archive/`, and anything marked SUPERSEDED.
