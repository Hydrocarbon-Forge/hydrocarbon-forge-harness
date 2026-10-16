---
id: B2-ledger
title: Bootstrap tool ledger.mjs
class: bootstrap
depends_on: []
read: [ORCHESTRATOR-PROMPT.md]
write: []
create: [build/tools/ledger.mjs, build/tools/ledger.selftest.mjs]
protected: [build/tools/guard.mjs, build/tools/wt.mjs, build/orchestrator/**, .claude/**]
verify:
  - { run: "node build/tools/ledger.selftest.mjs", timeout_s: 60 }
---
## Objective
Append cost/effort ledger lines and print aggregates by role, tier and phase.
## Interface
`ledger.mjs add --role R --tier H|S|O --phase P --tool-uses N --tokens N [--model M]`; `ledger.mjs summary [--phase P]` prints JSON {subagents,tool_uses,tokens,by_tier,by_role}. Exit 0 ok, 2 bad args.
## Behavior
- add appends one JSON object {ts,role,tier,phase,tool_uses,tokens,model?} per line to build/state/ledger.jsonl (mkdir -p).
- summary aggregates all lines (or only --phase): counts lines as subagents, sums tool_uses/tokens, splits tokens by tier (H/S/O) and by role.
- Roles: researcher, spec_writer, test_writer, worker, architect, reviewer. Non-numeric tool_uses/tokens are rejected.
## Invariants
- Append-only; summary never writes; one line per finished subagent.
## Edge cases
- Missing ledger file on summary prints zeros. Unknown role/tier is exit 2.
## Guardrails
- Node stdlib only. No git, no network.
## Out of scope
- Pricing/cost math (P1.6), budget enforcement, estimates.
