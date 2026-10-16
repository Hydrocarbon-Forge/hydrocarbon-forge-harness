---
id: B2-packet
title: Bootstrap tool packet.mjs
class: bootstrap
depends_on: []
read: [ORCHESTRATOR-PROMPT.md, build/tools/wt.mjs]
write: []
create: [build/tools/packet.mjs, build/tools/packet.selftest.mjs]
protected: [build/tools/guard.mjs, build/tools/wt.mjs, build/orchestrator/**, .claude/**]
verify:
  - { run: "node build/tools/packet.selftest.mjs", timeout_s: 60 }
---
## Objective
Assemble a failure packet JSON for a failed WP from its verify report, scope result and capped diff.
## Interface
`packet.mjs <WP> [--gen N] [--scope PATH] [--message TEXT]` writes build/packets/<WP>.g<N>.json (N defaults to state.json gen, else 1). Exit 0 ok, 1 missing verify report, 2 usage error.
## Behavior
- Required input: build/reports/<WP>.verify.json. Optional: scope JSON file (--scope), worker one-liner (--message, stored as worker_summary and treated as untrusted).
- Diff: `git diff --stat` plus `git diff` in the worktree; patch capped at 200 KB (stat first; truncated:true when cut); patch written to build/packets/<WP>.g<N>.patch, referenced as patch_path.
- failure_class: protected entries→protected_modified; else scope violations→scope_violation; else verify_failed.
- related_contracts = spec read[] entries; dependents = state.json WPs listing <WP> in deps ([] when state.json absent).
## Invariants
- Never embeds transcripts; only the capped --message, diff stat/patch and command tails from the verify report.
## Edge cases
- Worktree removed: diff stat "worktree gone", patch empty. Oversize diff truncates from the tail.
## Guardrails
- Node stdlib only. No git writes, no network.
## Out of scope
- Replanning, healing, verdicts, BSP packet schema (plan App. A) — bootstrap shape only.
