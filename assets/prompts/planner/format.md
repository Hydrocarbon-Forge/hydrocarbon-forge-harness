## Plan Format (exact; the engine parses and lints this)

### Files and locations (relative to your working directory)
```
manifest.yaml
tasks/<ID>.md                      one per task; <ID> matches ^[A-Z][A-Za-z0-9_-]{0,31}$
<repo-relative path>               contract stub files, same relative path as in the repository
decisions.md
QUESTIONS.md                       only when you must ask (see "Finishing")
```
If your tools cannot write files, emit each file instead as a fenced block whose info string is `<language>:<relative path>`, for example a block opened with `yaml:manifest.yaml`. Use this fallback only when writing files is impossible.

### manifest.yaml
```yaml
version: 1
run_id: <given in the request>
goal: <one sentence>
base_ref: <copy the base_ref from the request exactly, character for character>
ecosystem: node-ts            # optional: node-ts | python | rust | go | other
setup:                        # run once in every task worktree before its worker, and once in the integration worktree before integration_verify, with network; install dependencies here (installed packages are not in git); may be empty
  - run: npm ci
    timeout_s: 300
contracts:
  files:                      # repo-relative paths of every contract stub you wrote
    - src/util/slugify.ts
  typecheck:                  # commands that prove the stubs compile
    - run: npx tsc --noEmit
      timeout_s: 120
integration_verify:           # run once, after every task has merged (not between merges), in the integration worktree after setup; a plan with one task is not verified again, and a check whose tool is missing is a warning, not a failed run
  - run: npx tsc --noEmit
    timeout_s: 300
tasks:
  - id: T1
    spec: tasks/T1.md
  - id: T2
    spec: tasks/T2.md
budget:                       # optional; an estimate of the run's cost for the plan summary, not a limit
  max_usd: 2
```
A command is `{ run, timeout_s, cwd?, env? }`. `cwd` is repo-relative.

### tasks/<ID>.md
YAML frontmatter, then exactly these seven sections in this order.
```markdown
---
id: T2
title: Implement slugify
class: feature
depends_on: [T1]
read: [src/util/strings.ts]            # context the worker should read (keep small)
write: []                              # existing files it may modify
create: [src/util/slugify.ts]          # new files it may create
protected: []                          # files that must be byte-identical afterwards (test files from a tests task)
verify:
  - run: npx tsc --noEmit
    timeout_s: 120
effort: medium                         # optional: low | medium | high | xhigh | max
budget: { max_usd: 0.5 }               # optional; an estimate of this task's cost for the plan summary, not a limit
---
## Objective
One paragraph: what exists after this task and why.

## Interface
Exact signatures, types and file paths. Point to contract stubs by path.

## Behavior
Numbered, testable statements of required behaviour. In a `tests` task, these are the test targets: at most about 10 numbered items that carry risk, each with a short reason on the same line.

## Invariants
What must stay true (existing behaviour, performance, style).

## Edge cases
Inputs and states the worker must handle, including failure paths. Keep it to the cases that matter; `None` is acceptable. In a `tests` task, list only edge cases where a bug is likely and costly.

## Guardrails
What the worker must not touch or do; known traps in this repository.

## Out of scope
Things that look related but belong to other tasks or to nobody. In a `tests` task, name what is deliberately not tested.
```
Rules for these files:
- Paths are repository-relative with forward slashes: no absolute paths, no `..`. Globs (picomatch) are allowed in `read` and `protected`; use explicit paths in `write` and `create`.
- `write` lists files that already exist in the repository at `base_ref`. A file that does not exist yet goes in `create`, including a file that one of your contract stubs introduces and a later task implements.
- The body must not contain implementation code, only signatures and short illustrative snippets. No `TODO`, `FIXME`, `TBD`, `...` or `<placeholder>` in Interface or Behavior.
- The spec must stand alone: the worker sees only this file, the files in `read`, the stubs and the repository.

### Contract stubs
Type declarations (`interface`, `type`, `declare function`, abstract signatures, schemas). If the language forces a body, use the minimum that typechecks. They live at the same relative path the final file will have, are committed before any worker starts, and are replaced by the implementing task.

### Worked example
Request: "add a slugify helper". One task, no tests (the request does not ask for them). The manifest is the one shown above with `tasks: [{ id: T1, spec: tasks/T1.md }]` and `contracts.files: [src/util/slugify.ts]`. T1 is class `feature` and creates the implementation:
```markdown
---
id: T1
title: Implement slugify
class: feature
depends_on: []
read: [src/util/strings.ts]
write: []
create: [src/util/slugify.ts]
protected: []
verify:
  - run: npx tsc --noEmit
    timeout_s: 120
---
## Objective
A `slugify` helper that turns free text into a URL slug, used by the blog routes.

## Interface
`export function slugify(text: string): string` in `src/util/slugify.ts` (contract stub already present).

## Behavior
1. Lowercases the text and joins its words with single hyphens: `Hello,  World!` gives `hello-world`.
2. Strips leading and trailing hyphens: `  !Hi!  ` gives `hi`.
3. Returns an empty string when the input has no letters or digits.

## Invariants
Existing exports of `src/util/strings.ts` are unchanged.

## Edge cases
None beyond the behaviour above.

## Guardrails
Do not change other helpers in `src/util/`.

## Out of scope
Non-ASCII transliteration (for example `é` to `e`) and length limits.
```
Its verify is a typecheck, which runs in the worktree once the task is done. Keep Behavior to the statements that matter, usually 3 to 5 for a small helper, never more than about 10.

### Pre-flight checklist (the linter reports these)
Lint refuses a plan only when it cannot run, such as a missing task spec, a duplicate task id, an unknown dependency or a dependency cycle. Every other item below is a warning: the reviewer sees it, and the plan still runs.
1. Task ids are unique and match the pattern; every task in `manifest.yaml` has a spec file and every spec file is listed.
2. `depends_on` names existing tasks and has no cycles.
3. Every `write` path exists in the repository; new files use `create`. No path escapes the repository.
4. No two tasks that can run at the same time write or create the same file.
5. A file that a task lists under `protected` may be created or written only by the `tests` task that owns it, or by a task the protecting task depends on (directly or transitively) and so runs before it. Any other task that writes or creates it, and the protecting task or its descendants, is a warning. The fix is to add `depends_on` to the protecting task or remove the path from its `protected` list.
6. Every task has at least one `verify` command that can actually run when the task is done: its binary exists, and any test file it names exists at base or is created by the task or a dependency. A verify that cannot run is a warning: replace it with a command that can (a compile, typecheck, lint or smoke run).
7. All seven sections are present and non-empty; no placeholder text in Interface or Behavior.
8. Every `class` is one of the classes listed in the request.
9. `read` stays small (a handful of files); if it does not, the task is too large.
10. Contract stubs compile with the `contracts.typecheck` commands.
11. At most 40 tasks.
