# Progress

Update this file at the end of every work package: set the Status to DONE, write one line in Notes (what you ran to prove it), and commit it with the code. Statuses: TODO, DOING, DONE, BLOCKED. `scripts/check-*.mjs` read the Status column, so keep the table format exactly (five `|`-separated columns before Notes; do not put `|` inside a cell).

Current WP: **R0.1** (first). Take the first TODO row whose dependencies are all DONE.

| ID | Title | Size | Deps | Status | Notes |
|---|---|---|---|---|---|
| R0.1 | Tripwire scripts and npm run check | S | - | TODO | |
| R0.7 | Remove the inert TUI scaffold | S | R0.1 | TODO | |
| R0.2 | Fake harness that edits files | M | R0.1 | TODO | |
| R0.3 | E2E driver and smoke test | M | R0.2 | TODO | |
| R0.4 | Split effects.ts | M | R0.1 | TODO | |
| R0.5 | Remove fabrications and test hacks | M | R0.2 R0.4 | TODO | |
| R0.6 | Dead-export analysis | M | R0.1 R0.7 | TODO | |
| R1.1 | Entry point, build and signals | M | R0.3 | TODO | |
| R1.2 | Event catalog and typed emit | M | R0.4 R0.5 R0.6 | TODO | |
| R1.3 | Status, tasks, report, summary and clean output | M | R1.2 | TODO | |
| R1.4 | Usage ledger and budget totals | M | R1.2 | TODO | |
| R1.5 | Settings schema and CLI overrides | M | R1.1 | TODO | |
| R1.6 | Env layer, config command, dispatch rules | M | R1.5 | TODO | |
| R1.7 | Prompt loader and renderer | M | R0.1 | TODO | |
| R1.8 | Run-control flags and unregistered commands | M | R1.6 | TODO | |
| R2.1 | Price table and unknown-cost policy | M | R1.4 | TODO | |
| R2.2 | Adapter registry; FakeAdapter leaves src | M | R0.3 R1.5 | TODO | |
| R2.3 | Claude adapter correctness | M | R2.2 R1.7 | TODO | |
| R2.4 | OpenCode adapter correctness | M | R2.2 R1.7 | TODO | |
| R2.5 | agy adapter correctness | M | R2.2 R2.1 R1.7 | TODO | |
| R2.6 | listModels for each adapter | M | R2.3 R2.4 R2.5 | TODO | |
| R2.7 | substrate models | M | R2.6 R2.1 | TODO | |
| R2.8 | substrate usage | M | R1.4 R2.1 | TODO | |
| R2.9 | Profiles and routing defaults | M | R2.7 R1.6 | TODO | |
| R2.10 | init and doctor | M | R2.9 | TODO | |
| R3.1 | Planner action | L | R2.2 R1.7 R2.9 | TODO | |
| R3.2 | Scheduler, dependencies, terminal states, resume | L | R3.1 | TODO | |
| R3.3 | Worker core | L | R3.2 R2.3 | TODO | |
| R3.4 | Heal, budgets, timeouts, rate limits | M | R3.3 | TODO | |
| R3.5 | Escalation L1 L2 L3 and failure packets | L | R3.4 | TODO | |
| R3.6 | Integration worktree, merge, bisect, checkpoints | L | R3.3 | TODO | |
| R3.7 | merge, undo, discard commands | M | R3.6 | TODO | |
| R3.8 | Solo mode | M | R3.3 | TODO | |
| R4.1 | Run request schema and validation | M | R2.9 R1.8 | TODO | |
| R4.2 | Question and resume protocol | M | R3.1 R4.1 | TODO | |
| R4.3 | Local-model worker route | M | R2.4 R2.9 | TODO | |
| R4.4 | Archive writer, history, gc | M | R3.2 | TODO | |
| R4.5 | Charter and planner context | M | R4.4 R3.1 | TODO | |
| R4.6 | models --stats insights | M | R2.7 R2.8 R3.4 | TODO | |
| R5.1 | Docs reconciliation, caller guide and stronger docs-check | M | R1.8 R2.8 R2.10 R3.7 R3.8 R4.2 R4.6 | TODO | |
| R5.2 | Live smoke and gate G5 | M | R5.1 | TODO | |
| R5.3 | Final wiring audit, E2E matrix and archive | M | R5.2 | TODO | |
| R5.4 | OPTIONAL: retire the governor | S | R5.3 | TODO | Only if the owner asks. |
