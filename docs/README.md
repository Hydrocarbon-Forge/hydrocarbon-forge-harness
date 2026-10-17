# docs/ map

| Path | What | Lifetime |
|---|---|---|
| `plan/DECISIONS.md` | Binding product and architecture decisions | **Durable** (updated only by the owner) |
| `reference/` | User-facing reference for config, CLI, adapters (inaccurate in places until work package R5.1) | Durable |
| `spikes/` | Measured facts about the three harnesses (S1 claude, S2 opencode, S3 agy, S4 prices, S5 UX) | Durable evidence |
| `plan/IMPLEMENTATION-PLAN.md`, `plan/PROGRESS.md`, `plan/wp/` | The R-series work orders and their progress | **Disposable**: archived by R5.3 once the work is done |
| `plan/reference/` | Audit notes explaining why the work orders exist | Disposable |
| `archive/` | Superseded material: the v1 plan, the retired bootstrap kit, the old security review | Frozen history; never implement from it |

The same split applies to a project that uses Substrate: its durable "main idea" is `.substrate/charter.md`, and implementation details of finished runs are compacted into `.substrate/archive/` (see `plan/DECISIONS.md`, A8). A new major version keeps the charter and leaves old implementation details behind.
