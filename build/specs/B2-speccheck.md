---
id: B2-speccheck
title: Bootstrap tool speccheck.mjs
class: bootstrap
depends_on: []
read: [ORCHESTRATOR-PROMPT.md]
write: []
create: [build/tools/speccheck.mjs, build/tools/speccheck.selftest.mjs]
protected: [build/tools/guard.mjs, build/tools/wt.mjs, build/orchestrator/**, .claude/**]
verify:
  - { run: "node build/tools/speccheck.selftest.mjs", timeout_s: 60 }
---
## Objective
Validate a task spec's shape without judging its content.
## Interface
`speccheck.mjs <WP>` reads build/specs/<WP>.md; prints SPEC OK or the full error list. Exit 0 valid, 1 invalid, 2 missing spec.
## Behavior
- Frontmatter must carry id, title, class, depends_on, read, write, create, protected, verify; verify is non-empty with run and timeout_s on each entry; id matches the <WP> filename.
- Body must contain headings Objective, Interface, Behavior, Invariants, Edge cases, Guardrails, Out of scope (Open questions optional, anything ambiguous belongs there).
- Paths: no absolute paths, no `..` segments; globs use only `* ? **` and `/`.
- Code fences: none longer than 12 lines; reports every error, not just the first.
## Invariants
- Read-only; deterministic; never shells out.
## Edge cases
- Malformed frontmatter is an error entry, never a crash. Empty file is exit 1 with errors.
## Guardrails
- Node stdlib only. No git, no network.
## Out of scope
- Semantic review, Appendix A conformance, write-set disjointness (state.mjs next).
