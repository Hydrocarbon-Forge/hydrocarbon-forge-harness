---
id: B2-merge
title: Bootstrap tool merge.mjs
class: bootstrap
depends_on: []
read: [ORCHESTRATOR-PROMPT.md, build/tools/wt.mjs]
write: []
create: [build/tools/merge.mjs, build/tools/merge.selftest.mjs]
protected: [build/tools/guard.mjs, build/tools/wt.mjs, build/orchestrator/**, .claude/**]
verify:
  - { run: "node build/tools/merge.selftest.mjs", timeout_s: 120 }
---
## Objective
Merge listed WPs in order through wt.mjs, run the integration gate, bisect on failure.
## Interface
`merge.mjs <WP>...` merges strictly in argv order; prints JSON {merged[],culprit?}. Exit 0 all merged and gate green, 1 merge or gate failure, 2 usage error.
## Behavior
- Record pre-batch main HEAD first. For each WP run `node build/tools/wt.mjs merge <WP>`; abort on first failure (earlier merges stay, exit 1).
- Gate: when src/ exists in main, run `npm run typecheck && npm test`; otherwise skip as {gate:skipped}.
- Gate failure: `git reset --hard <pre-batch-sha>`, then re-merge WPs one by one, running the gate after each; the first red merge is the culprit (printed, kept merged alone or reset away — always leave main at a green or pre-batch sha, never red).
## Invariants
- Sequential merges only. Never push, never reset past the pre-batch sha, never leave main red.
## Edge cases
- Single-WP gate failure names that WP. Dirty main surfaces wt.mjs's refusal verbatim.
## Guardrails
- Node stdlib only (spawnSync git/npm). No pushes, no network beyond what npm needs.
## Out of scope
- Scope/verify (done before merge), conflict resolution (fail loudly instead).
