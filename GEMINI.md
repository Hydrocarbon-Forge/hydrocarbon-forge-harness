# Instructions for Gemini

Read `START-HERE.md` in full before doing anything, and follow it exactly. In short:

- The R-series work packages are complete and archived at `docs/archive/2026-10-20-r-series/`. That archive is history only, not instructions. Take work from the owner's instructions; start at `START-HERE.md`.
- Binding decisions are in `docs/plan/DECISIONS.md`. Open findings are in `docs/known-issues.md`.
- Do not scaffold. Implement the behaviour, wire it so the CLI runs it, and prove it by running the built CLI.
- Never import from `test/` in `src/`, never add test-only branches or fake data to `src/`, never put prompt text in TypeScript.
- Stay inside the files the owner's task names. If blocked, stop and report to the owner; do not choose silently.
- Ignore `build/`, `docs/archive/`, and anything marked SUPERSEDED.
