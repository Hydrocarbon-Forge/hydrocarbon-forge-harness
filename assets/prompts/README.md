# Substrate prompt library

These files are the product's prompts. They are data, not code. TypeScript only loads a file, substitutes `{{variables}}`, and passes the result to a harness. Do not copy prompt text into `.ts` files; change it here.

## Why the split
- `assets/agents/<role>.md` = the **static system prompt** for a role (YAML frontmatter + body). It never contains variables, so harnesses can cache it.
- `assets/prompts/**` = **user-turn templates** and **appended references** that carry the variables for one turn.

## Layout
```
assets/
  agents/
    planner.md  worker.md  test-writer.md  reviewer.md     static system prompts
    governor.md                                              optional, disabled by default
  prompts/
    planner/
      format.md          exact plan format + worked example + pre-flight checklist (appended to the planner system prompt)
      request.md         first user turn of a planning session
      correction.md      user turn when the linter rejects the plan (resumed planner session)
      answers.md         user turn when the caller answers questions (resumed planner session)
      replan-l1.md       user turn: rewrite ONE failed task's spec (fresh planner session)
      replan-l2.md       user turn: amend contracts/manifest/specs (fresh planner session)
    worker/
      task.md            user turn for a worker (spec path)
      heal.md            user turn for the single L0 fix attempt (resumed worker session)
      class/<class>.md   short addendum appended to the worker system prompt for that task class
    test-writer/task.md  user turn for a tests-class task
    reviewer/review.md   user turn for the optional review phase
```

## How each spawn is assembled
| Spawn | `system_append` (static) | `prompt` (user turn) |
|---|---|---|
| Planner, first turn | `agents/planner.md` body + `prompts/planner/format.md` | `prompts/planner/request.md` |
| Planner, format retry | (same session, resumed) | `prompts/planner/correction.md` |
| Planner, resume with answers | (same session, resumed) | `prompts/planner/answers.md` |
| Planner, L1 replan | `agents/planner.md` body + `prompts/planner/format.md` | `prompts/planner/replan-l1.md` |
| Planner, L2 amendment | `agents/planner.md` body + `prompts/planner/format.md` | `prompts/planner/replan-l2.md` |
| Worker | `agents/worker.md` body + `prompts/worker/class/<class>.md` (if it exists) | `prompts/worker/task.md` |
| Worker, heal | (same session, resumed) | `prompts/worker/heal.md` |
| Test-writer (class `tests`) | `agents/worker.md` body + `agents/test-writer.md` body + `prompts/worker/class/tests.md` | `prompts/test-writer/task.md` |
| Reviewer | `agents/reviewer.md` body | `prompts/reviewer/review.md` |

Code concatenates with a blank line between parts. The engine, never a model, performs this assembly: no agent is asked to "prepend" rules to another agent's prompt.

## Variables
Syntax is `{{name}}` only: no logic, no loops, no conditionals. Code builds every multi-line value (lists, tables, diagnostics) as plain text before substitution. A variable with no value is replaced by `(none)`. Rendering must fail loudly if any `{{...}}` remains after substitution or if a template needs a variable the caller did not pass.

| Template | Variables |
|---|---|
| `planner/request.md` | `request`, `run_id`, `base_ref`, `repo_root`, `classes`, `task_budget`, `run_budget`, `max_tasks`, `charter`, `history`, `instruction_files`, `skills`, `repo_map` |
| `planner/correction.md` | `attempt`, `max_attempts`, `diagnostics` |
| `planner/answers.md` | `answers` |
| `planner/replan-l1.md` | `task_id`, `generation`, `failure_class`, `spec_path`, `failure_details`, `diff_summary`, `worker_summary`, `task_spec`, `related_contracts`, `dependents`, `decisions` |
| `planner/replan-l2.md` | `task_id`, `failure_class`, `escalation_reason`, `failure_details`, `worker_summary`, `manifest`, `task_states`, `contracts`, `decisions` |
| `worker/task.md`, `test-writer/task.md` | `spec_path` (absolute) |
| `worker/heal.md` | `failures` (failing command, exit code, stdout/stderr tails, capped at 8 KB total) |
| `reviewer/review.md` | `task_specs`, `contracts`, `diff` |

## Override order (first match wins)
1. `.substrate/prompts/<same relative path>` and `.substrate/agents/<role>.md` (project, shareable)
2. `~/.config/substrate/prompts/...` and `~/.config/substrate/agents/...` (user)
3. the files in this directory (built in; resolved relative to the installed package, never the current directory)

## Protocols these prompts rely on (the engine must implement exactly these)
- **Planner output**: files written into the planner's working directory (the run directory): `manifest.yaml`, `tasks/<ID>.md`, contract stubs at their repo-relative paths, `decisions.md`. Fallback only when the planner cannot write files: fenced blocks whose info string is `<language>:<relative path>`.
- **Planner finish line**: `PLAN READY` (plan complete), `NEEDS INPUT` (a `QUESTIONS.md` exists; the run pauses and the questions go to the caller), `REVISED <ID>` or `ESCALATE: <reason>` (L1 replan), `AMENDED` (L2).
- **Worker finish line**: exactly `DONE` or `BLOCKED: <reason>`. The engine never trusts it as success; scope, protected files and `verify` decide.
- **Reviewer first line**: `VERDICT: PASS` or `VERDICT: FAIL`.

## Editing rules
- Keep system prompts under about 120 lines and class addenda under 6 lines. Long prompts get skimmed by the cheap models that run them.
- Write rules as short imperative sentences. State the failure mode a rule prevents when it is not obvious.
- Never put test-only hooks, magic strings or model names in a prompt.
- When a protocol line above changes, change the parser and these files in the same work package, and update the tests that assert them.
