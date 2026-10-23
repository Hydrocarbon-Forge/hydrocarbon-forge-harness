# Plan lint

Plan lint checks the manifest and the task specs a planner writes. It has one job: block only a plan that cannot run. A blocker is an error. It refuses the plan, and a planner format retry follows while attempts remain (`plan.format_rejected`). Every other rule is a warning. A warning never refuses a plan and never costs a retry (R12.3). The engine enforces what the warnings describe: a change outside a task's write set is dropped at merge, and each task and the final `integration_verify` run their own checks.

Rules live in `src/spec/rules.ts` and are run by `lintPlan` in `src/spec/linter.ts`.

## What blocks

A plan is refused, and the planner is asked again, only when scheduling cannot start or the engine's state would be corrupted:

- the manifest is missing, unreadable, does not parse, or fails its schema (L001);
- a task spec the manifest names is missing, lies outside the run directory, cannot be read, does not parse, or fails its frontmatter schema (L001, L003);
- a duplicate task id, or a task id that is not a valid id (L002);
- the dependency graph has a cycle, including a self-dependency (L005);
- a contract file lies outside the repository, so the stub commit cannot add it to the run branch (L006).

A task class needs no rule: any class name routes. An unknown class takes the `work` slot, or the built-in fallback route (`src/roles/router.ts`, `resolveTaskRoute`), and never blocks.

The contract typecheck, the required sections, the verify commands, the scope rules and a `depends_on` that names no task are not blockers. A dependency that names no task is a warning (L004, 2026-10-23): the engine drops it when it reconciles the plan and says so in a `plan.synced` warning.

Placeholder text (L013) is a warning. The spec parser never refuses a spec for it (2026-10-23). A bare `...` in a sentence, or call shorthand in backticks, is not a placeholder; a bare ellipsis counts only as the whole content of a line or bullet, or as `etc...`.

## Warnings

When the planner's plan is accepted, its warnings are kept, so the reviewer can read them:

- `.substrate/runs/<id>/plan-warnings.txt` holds every warning, one per line: the rule id, the task (`-` for a plan-wide warning) and the message, tab-separated. The file is removed when the plan has none.
- The `plan.produced` event carries `warnings` (the first 20, each message at most 300 characters) and `warning_count` (the total).
- A text run, `substrate plan` and a resume that accepts an edited plan print one note after `plan ready`: `note: the plan has <n> warnings (see .substrate/runs/<id>/plan-warnings.txt); the first: <id> <message>`.
- The json result and `result.json` carry `plan_warnings` (the count) when the plan has warnings.

A resume refuses an edited plan only for a blocker, with exit 2 and no spawn. Warnings pass.

## Rules

Severity is what the rule reports. "Retry" is whether a finding of that severity costs a planner format retry. Before R12.3, every error cost one; now only the blockers do.

| ID | What it checks | Before | Now | Retry before | Retry now |
|---|---|---|---|---|---|
| L001 | Manifest and task spec frontmatter schema | error | error (blocker) | yes | yes |
| L002 | Task id format and uniqueness | error | error (blocker) | yes | yes |
| L003 | A declared spec file missing on disk | error | error (blocker) | yes | yes |
| L003 | An orphan `.md` file under `tasks/` that no task names | error | warn | yes | no |
| L004 | `depends_on` names an unknown task (dropped by the engine, 2026-10-23) | error | warn | yes | no |
| L005 | Dependency cycle, including self-dependency | error | error (blocker) | yes | yes |
| L006 | A contract file outside the repository | error | error (blocker) | yes | yes |
| L006 | Any other unsafe path: read, write, create, protected, or a cwd | error | warn | yes | no |
| L007 | A write pattern that matches no file at base | error | warn | yes | no |
| L008 | Two tasks in one DAG layer whose targets overlap | warn | warn | no | no |
| L009 | A write or create that intersects another task's protected path | error | warn | yes | no |
| L010 | An empty verify list (L001 also refuses it: the schema needs one command) | error | warn | yes | no (L001 still refuses) |
| L011 | A verify binary that cannot be resolved, or a verify cwd that does not exist | error | warn | yes | no |
| L012 | A verify that names a test path nothing provides | error | warn | yes | no |
| L013 | A placeholder token (TODO, FIXME, TBD, `<placeholder>`, a bare `...` line, `etc...`) outside code fences in Interface or Behavior | error | warn | yes | no |
| L014 | A required section missing or empty (the ingest heading check is removed; L014 covers it) | error | warn | yes | no |
| L017 | The read set exceeds the context budget | error | warn | yes | no |
| L018 | The contract typecheck fails, or cannot run | error | warn | yes | no |
| L019 | A contract file missing on disk, or an Interface that names an undeclared contract file | error | warn | yes | no |
| L020 | A code fence that holds implementation bodies | warn | warn | no | no |
| L021 | `integration_verify` is empty | warn | warn | no | no |
| L023 | A verify that passes at the base ref (red-check), only when `lint.red_check` is `true` (default `false`: not run) | warn | warn | no | no |
| L024 | Class `tests` writes a non-test path, or another class writes a test path | warn | warn | no | no |
| L026 | More tasks than the maximum | warn | warn | no | no |
| L027 | A protected path that does not exist at base and is not created by a dependency | error | warn | yes | no |
| L028 | A tests task with more than about 10 test targets | warn | warn | no | no |

L015 is retired (R7.7): a class with no routing entry routes through the fallback. L016, L022 and L025 (per-task and run budget caps, and the approval threshold) were removed on 2026-10-23 with those caps. The plan's cost estimate is reported on `plan.lint` as `estimated_usd` and gates nothing. There is no approval pause (owner, 2026-10-23).

L023 runs every verify command at the base ref, so it is off by default. Set `lint.red_check` to `true` in settings to turn it on; it is always a warning and never blocks a plan.

## Checks outside the rule table

These are plan-reading steps, not rules. They refuse the plan with the same retry:

- the planner did not finish with `PLAN READY` or `NEEDS INPUT`, or `QUESTIONS.md` and the finish line disagree;
- a fenced block names a path outside the run directory;
- `manifest.yaml` is missing from the run directory.

The approval lint (the `LINTING` step) runs the same rules on the plan as the approval step reads it. It refuses only on the blockers above.

## Related

- `docs/plan/DECISIONS.md`, the note of 2026-10-21 (R12.3), is the binding policy.
- `docs/reference/cli.md` describes the commands that show lint results.
