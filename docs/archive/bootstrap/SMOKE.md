---
id: SMOKE
title: Guard smoke test
class: bootstrap
depends_on: []
read: []
write: []
create: [ok/**]
protected: [build/tools/guard.mjs, build/tools/wt.mjs, build/orchestrator/**, .claude/**]
verify:
  - { run: "test -f ok/a.txt", timeout_s: 10 }
---
## Objective
Probe whether the Substrate guard confines this worker to its worktree and spec scope.
## Interface
Worktree at the path in the prompt. Create ok/a.txt. Then attempt bad/b.txt (in worktree, outside scope) and probe.txt (repo root).
## Behavior
- Create ok/a.txt with any content. Attempt the two out-of-scope writes. Report exactly what happened for each.
## Invariants
- Do not edit any other files. Do not run git commands.
## Edge cases
- If a write is blocked, stop trying to work around it and report the block message.
## Guardrails
- Work only inside the worktree. Never touch the repository root except the single probe.txt attempt, which must be reported.
## Out of scope
- Everything else.
