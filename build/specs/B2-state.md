---
id: B2-state
title: Bootstrap tool state.mjs
class: bootstrap
depends_on: []
read: [ORCHESTRATOR-PROMPT.md, build/tools/wt.mjs]
write: []
create: [build/tools/state.mjs, build/tools/state.selftest.mjs]
protected: [build/tools/guard.mjs, build/tools/wt.mjs, build/orchestrator/**, .claude/**]
verify:
  - { run: "node build/tools/state.selftest.mjs", timeout_s: 60 }
---
## Objective
Track bootstrap WP statuses, retry counters and release scope in build/state/state.json. Pure Node, stdlib only.
## Interface
`state.mjs init-from-plan [--plan P] [--target R] [--workers N]`; `get <WP>`; `set <WP> <STATUS>`; `set phase:<N> approved`; `list [STATUS]`; `next [--limit K]`. Root via git top-level. Exit 0 ok, 1 illegal transition/usage (stderr reason), 2 missing file.
## Behavior
- init-from-plan parses the §16 tables (ID|Title|Deps|Write set|Verify|Tier/Eff|TF|Sz|Rel) into state.json {release_target,max_workers,approved_phases:{B2:true},wps:{id:{title,deps[],write[],rel,tier,eff,tf,sz,phase,status:PENDING,gen:1,heals:0,replans:0}}}; refuses overwrite unless --force.
- set enforces PENDING→SPEC→TESTS→IMPL→SCOPE→VERIFY→MERGED, VERIFY→HEAL (needs heals<1, heals+1), any non-terminal→REPLAN (needs replans<2, replans+1, gen+1)→SPEC, any non-terminal→BLOCKED; else exit 1.
- next prints JSON ids in §16 order: status PENDING, deps all MERGED, rel≤target, phase approved; greedily skip write-set overlap; cap --limit (default max_workers).
- Overlap: equal globs, or one (minus trailing /**) is a path prefix of the other.
## Invariants
- state.json is the only store; counters never decrease; every mutation goes through set.
## Edge cases
- Unknown WP, bad STATUS, unmet deps, empty next set (prints []) are all normal exits, never crashes.
## Guardrails
- Node stdlib only. No git writes, no network. Never touch worktrees, specs, ledger.
## Out of scope
- Product engine states (plan §5), pricing math, ledger aggregation.
