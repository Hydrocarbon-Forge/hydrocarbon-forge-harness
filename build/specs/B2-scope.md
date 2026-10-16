---
id: B2-scope
title: Bootstrap tool scope.mjs
class: bootstrap
depends_on: []
read: [ORCHESTRATOR-PROMPT.md, build/tools/wt.mjs, build/tools/guard.mjs]
write: []
create: [build/tools/scope.mjs, build/tools/scope.selftest.mjs]
protected: [build/tools/guard.mjs, build/tools/wt.mjs, build/orchestrator/**, .claude/**]
verify:
  - { run: "node build/tools/scope.selftest.mjs", timeout_s: 60 }
---
## Objective
Check a WP worktree's changes against its spec scope; optionally revert out-of-scope edits.
## Interface
`scope.mjs <WP> [--revert]` prints JSON {ok,violations[],protected_modified[],out_of_scope[]}. Exit 0 clean, 1 violations found, 2 usage/missing worktree or spec.
## Behavior
- Changes = `git status --porcelain` inside .worktrees/<WP> (tracked mods + untracked), as repo-relative paths.
- Allowed = spec frontmatter write+create globs; denied = spec protected plus always [build/tools/guard*.mjs, build/tools/wt*.mjs, build/orchestrator/**, .claude/**, .substrate-task/**]; files listed in build/state/scope/<WP>.tests (if present) are denied for non-test-writer changes.
- Also fails when the main tree has tracked modifications (`git status --porcelain --untracked-files=no` non-empty): violation "main tree dirty".
- --revert restores tracked out-of-scope files (git checkout --) and deletes untracked out-of-scope paths; never touches allowed files.
## Invariants
- Read-only without --revert; revert never touches allowed files.
## Edge cases
- Missing .tests file means no test protection. Missing worktree/spec is exit 2, not a violation report.
## Guardrails
- Node stdlib only. No commits, no pushes, no network.
## Out of scope
- Running verify, merging, heal/replan decisions.
