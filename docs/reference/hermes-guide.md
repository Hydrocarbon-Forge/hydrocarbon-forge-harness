# Hermes guide: delegating coding work to Substrate

This guide is for you, the agent that takes a task from a user and gets it done through Substrate. Read it in full before you start your first run. It is self-contained: you should be able to act on it alone. For every field and every flag, the exhaustive references are [caller-guide.md](caller-guide.md) (the request and result fields), [cli.md](cli.md) (every command and option) and [config.md](config.md) (settings). Open them when you need a fact that is not here.

## 1. What Substrate is and your role

Substrate is a command-line tool, `substrate`, that carries out coding work for you. You give it a goal in plain words. It plans the work, carries out the plan, checks each step with real commands, and merges only the steps that pass.

Your role is the front desk. The user tells you what they want in rough terms. You turn that into a goal that Substrate can act on, start the run, watch it, answer its questions, recover it when it stops or fails, confirm the result, and report back to the user. You do not write the code yourself in the normal case. Substrate does the work, and you own the outcome the user sees.

Do not treat a green run as proof that the work is right. Section 8 explains how to confirm it.

## 2. How Substrate works

- A **planner** model reads the goal and writes a plan: a list of tasks, each with its own checks.
- **Worker** models carry out the tasks. Each task runs as one headless process of a harness, in its own git worktree, so tasks cannot trample each other's files. The harnesses are Claude Code (`claude`), OpenCode (`opencode`) and Antigravity (`agy`).
- The engine is plain code, not an AI. After a worker finishes, the engine runs the task's verify commands. A task passes only when they all exit `0`. The engine merges passing tasks into a run branch.
- When every task has merged, the engine runs the plan's **integration verify**: one check of the whole project on the run branch.
- When the run finishes with every task passed and the integration check passed, Substrate merges the run branch into the branch that was checked out when the run started. This is called landing. It is on by default.

Every run needs two named models, and you must name them yourself:

- `--plan <provider>:<model>` sets the planner. The planner is the strong, expensive model. It runs once for the plan, and again only when a plan is refused or planning has to start again.
- `--work <provider>:<model>` sets the worker. The worker is the cheaper model. It runs once per task, and again when a task is retried.

The reason for two models is cost. A good plan needs a strong model, but the many small edits in a plan do not. Naming both lets the strong model think once and the cheap model do the repetitive work. The one exception is `solo` mode, which has no planner and needs only `--work` (section 4).

Substrate refuses a run that names no model on the command line or in the request. A model named in a settings file or a profile does not count. Always pass the model flags on the command line.

## 3. Quick start

Run these three checks before the first run in a project:

```bash
substrate doctor --output-format json
substrate models --output-format json
```

Then start the run in the background, with both models named and the goal in quotes:

```bash
substrate run --detach --plan claude:opus:high --work claude:sonnet:medium "Add a GET /books?author= filter to the bookshelf API" --output-format json
```

The command returns at once. Its JSON output has `run_id`, `pid`, `log`, `watch`, `status` and `stop`. Record the `run_id`. Then follow the run:

```bash
substrate watch r_EXAMPLE0001
substrate status r_EXAMPLE0001 --output-format json
```

`substrate watch <id>` prints the run's progress and follows it to the end. Its exit code is the run's exit code. `substrate status <id> --output-format json` is a single snapshot. It never changes anything, so it is safe to poll.

The model ids in these examples are illustrative. Use only the ids that `substrate models` reports (section 5).

## 4. Writing the goal

The goal is the most important input you control. A vague goal produces a plan that does the wrong thing, and no check catches that. Before you start, make sure the goal says:

1. **What** to build or change, in concrete terms.
2. **Where**: the part of the project it touches, by file or by area, where you know it.
3. **How to tell it is done**: the behaviour a person could see or a command that would pass.

Keep the goal to a few sentences. Do not paste the whole user conversation into it. Put the user's exact constraints in it, such as "keep the existing tests passing" or "do not change the public API".

### Verify commands

Add `verify` commands when the user has a check you can name, such as a test command. Each command must exit `0` for a task to pass. Use the project's own test command, not a new one you invent. Pass verify commands with `--verify "<cmd>"`, which may be repeated, or with a `verify` array in a request (section 6).

Without a verify command, Substrate has only its own checks. In `solo` mode, a run with no verify command warns that only scope and budget checks apply. Tell the user that in your report.

### Context files

Pass `context` (a request field, an array of repo-relative file paths) when the goal depends on a particular file: a schema, an existing module the new code must match, a style guide. Each path must exist, or the request is refused.

### Mode

`--mode` picks how the run is shaped:

| Mode | Use it when | What happens |
|---|---|---|
| `auto` (default) | You are not sure | The engine's router decides. A goal that names one existing file and uses a mechanical verb (bump, rename, typo, format, move, delete, remove) runs as `solo`. Every other goal runs as `plan`. |
| `solo` | One file is changed in a simple, mechanical way | One worker, no planner, no plan. It needs only `--work`. |
| `plan` | The change spans several files or several steps, or the order matters | The planner writes the plan first, then workers carry it out. Needs both models. |

Use `solo` for a rename or a typo fix in a named file. Use `plan` for a feature, a refactor across files, or anything with more than one moving part. Use `auto` only when you are content for the router to make that call. In `auto`, naming a planner does not force `plan`. To force planning, pass `--mode plan`.

### Review before work starts

Pass `--review` when the work is risky or large: a schema migration, a change to authentication, a rewrite of a module. With `--review`, the run plans and then stops with status `planned`, before any worker runs. `--review` needs `--work`. Read the plan in the run directory (`.substrate/runs/<id>/`, the manifest and the task specs). When you are satisfied, resume with `substrate resume <id>`. Without `--review`, the plan runs straight away.

## 5. Choosing models

Run:

```bash
substrate models --output-format json
```

The output is one JSON object. `providers` lists each provider with `installed` and its `models`. `all_models` lists every model with its `provider` and `id`. Read these fields. Then:

- Use only an `id` that appears in `models` or `all_models`. Never invent a model id, an alias or an effort level.
- A provider or model must be installed to be used. An entry with `installed` false is not usable on this machine.
- Models take an optional effort after a second colon: `provider:model:effort`. Efforts are `low`, `medium`, `high`, `xhigh` and `max`. Use an effort only if the model's entry lists it.
- Pick a strong model for `--plan` and a cheaper one for `--work`. When the choice is not obvious, use the model the user named, and say which one you used.
- The profile slot in `.substrate/settings.json` (its `profiles` entries) does not count as a named model. Name the model on the command line anyway.
- The `claude` harness accepts the aliases `haiku`, `sonnet`, `opus` and `fable`, and the ids listed in [cli.md](cli.md) under `run`.

If no model is installed, or `substrate doctor` fails, stop before you spend anything. Run:

```bash
substrate doctor --output-format json
```

`doctor` prints a `checks` array. Each entry with `"status": "FAIL"` has a `fix` field. Apply each fix, or tell the user what is missing, then run `doctor` again. Exit `0` means no check failed. Exit `1` means at least one did. Do not start a run until `doctor` exits `0`, unless the only failures are warnings you can explain.

## 6. Flag and feature cheat sheet

The table lists the flags a delegating agent needs. Each one is in the option table or the text of [cli.md](cli.md).

| Flag | Commands | What it does |
|---|---|---|
| `--plan <provider>:<model>[:effort]` | `run`, `plan`, `resume` | Names the planner model. Required in `auto` and `plan` modes. |
| `--work <provider>:<model>[:effort]` | `run`, `resume` | Names the worker model. Required in every mode. Needed with `--review`. |
| `--mode auto\|solo\|plan` | `run` | Chooses how the run is shaped (section 4). Default `auto`. |
| `--detach` | `run`, `resume` | Starts the run in the background and returns at once. Not with `--output-format stream-json`. Not for `plan`. |
| `--request -` | `run` | Reads a JSON request from stdin (or `--request <file>` from a file, relative to the project). Cannot be combined with a prompt. |
| `--output-format json` | `run`, `plan`, `resume`, `status`, `models`, `usage`, `doctor`, `backends`, `sessions`, `history` | Prints one compact JSON object. `run` prints it when the run ends, with no progress. |
| `--verify "<cmd>"` | `run` | Adds a verify command. May be repeated. |
| `--review` | `run` | Plans only, then stops with status `planned`. Needs `--work`. |
| `--merge` | `run`, `resume` | Lands the finished run for this run only. |
| `--no-merge` | `run`, `resume` | Keeps the finished run on its run branch. Land it later with `substrate merge <id>`. |
| `--max-budget-usd <amount>` | `run`, `plan`, `resume` | Caps the run's spend. Off unless you set it. |
| `--timeout <seconds>` | `run`, `plan`, `resume` | Caps the run's wall-clock time. Whole seconds, 1 or more. Off unless you set it. |
| `--answers -` | `resume` | Reads the answers to a paused run's questions from stdin (section 10). |
| `--partial` | `merge` | Lands the passed tasks of a failed run on purpose, after the plan's integration verify passes on the run branch. |
| `--concurrency <n>` | `run`, `resume`, `plan` | How many workers run at once, from 1 to 16. `1` runs the tasks one at a time. |
| `--permission-mode <mode>` | `run`, `plan` | Substrate's approval gate. Default `dontAsk`. It does not change how harnesses run. |
| `--model`, `--worker-model`, `--effort` | `run`, `plan` | Alternative ways to name models. Prefer `--plan` and `--work`. |
| `--history-all` | `run`, `plan` | Puts archived runs from every charter version into the planner's context. |
| `--dry-run` | `merge` | Runs the merge checks without merging. |
| `--abort-on-conflict` | `merge` | Takes the abort path when a merge conflicts. |
| `--force` | `stop`, `discard`, `ui stop` | Sends SIGKILL, or removes a run whose process is still alive. Use only when the plain command has failed. |
| `--no-follow` | `watch` | Prints the run's history and exits `0` at once. |
| `--all-projects` | `runs`, `usage` | Lists the runs or the usage of every project on this machine. |

Two commands the table does not cover take no delegating flags you need. `substrate report <id>` prints a text diagnostic only. `substrate tasks <id>` prints a task table only.

### The request

Send a request on stdin when the goal has verify commands, context files or a budget. The object is strict. An unknown key is refused, and `scope` is always refused. The fields are `goal` (required), `mode`, `planner` (`provider` and `model`, with an optional `effort`), `worker` (the same fields), `verify`, `context`, `budget` (`max_usd`, `max_tokens`, `max_wall_min`), `merge` and `permission_mode`. [caller-guide.md](caller-guide.md) lists them all.

Here is a complete request for `plan` mode, with verify commands and context files. It is sent on stdin:

```bash
substrate run --plan claude:opus:high --work claude:sonnet:medium --request - --output-format json <<'EOF'
{
  "goal": "Add a GET /books?author= filter. It returns only books whose author matches, ignoring case. Keep the existing tests passing.",
  "mode": "plan",
  "planner": { "provider": "claude", "model": "opus", "effort": "high" },
  "worker": { "provider": "claude", "model": "sonnet", "effort": "medium" },
  "verify": ["npm test"],
  "context": ["src/books/routes.ts", "src/books/store.ts"]
}
EOF
```

Leave the `budget` field out unless the user asked for a cap. A run with no budget is never stopped for its cost.

When the request is invalid, Substrate prints `{"error":"invalid_request","problems":[...]}` on stdout and exits `2`. Each problem has a `fix`. Apply it and send the request again. Nothing was spent.

## 7. Monitoring a run

Follow this loop. It works the same way for a detached run and for a run you started in the foreground.

1. **Start detached.** Run `substrate run --detach ... --output-format json`. Read `run_id` from the JSON. Keep the `run_id` in your notes for the rest of the task.
2. **Tell the user.** Say that the run has started and give the `run_id`. Do this before you wait.
3. **Poll `status`.** Run `substrate status <run_id> --output-format json` every 30 to 60 seconds. Never poll faster than every few seconds. Read `status`, `phase`, `counts`, and `next`. `counts` holds `passed`, `running`, `failed`, `waiting` and `skipped`.
4. **Branch on `status`:**
   - `running`: keep waiting. Go back to step 3.
   - `paused`: read `status` in the text form or `result.json`. Go to section 10 (questions) or section 11 (recovery).
   - `stopped`: the process that started the run has gone. Go to section 11 and resume it.
   - `failed` or `interrupted`: go to section 11.
   - `finished`: go to step 5.
   - `planned`: a `--review` run is waiting for you. Read the plan (section 4), then resume it.
5. **Read `result.json` at the end.** The file is `.substrate/runs/<run_id>/result.json`. Read `exit_code`, `merged`, `files_changed`, `verification`, `verification_note` and `not_merged_reason`. `summary.txt` in the same directory holds the summary that text mode prints.
6. **Verify.** Do the checks in section 8 before you say the work is done.
7. **Report.** Use the template in section 14.

Two things that look alarming are normal. The first is a long silence. A worker can take several minutes on a hard task. Text mode prints `[mm:ss] still working: <phase> (<s>s, $<cost>)` after 15 seconds with no progress, and the `phase` tells you what is running. Use the phase and the seconds to judge the run, not the silence. The second is the cost shown as `$0.0000` during planning. A harness reports its cost only when its session ends, so the cost is unknown until then.

Use `substrate watch <run_id>` instead of polling when you can keep a process open for it. It prints the history, then each new line, then the summary, and exits with the run's exit code.

### Stuck or slow

- **Slow:** `status` says `running`, `process` shows `alive` as `true`, and `last_event_ts` moves forward or the heartbeat keeps reporting the same phase with a rising `s` count. Keep waiting. Tell the user the run is still going and what phase it is in.
- **Stuck:** `process.alive` is `false` while `status` still reads `running`, or `status` says `stopped`. Treat the run as gone. Resume it (section 11).
- **Probably stuck:** `process.alive` is `true`, and `last_event_ts` has not moved for a long time. This is your judgement, not a Substrate rule. Ask the user before you stop a run, because stopping it costs time and any task in flight is discarded. Stop it with `substrate stop <run_id>` only when the user agrees, then resume.

### Other commands for monitoring

- `substrate runs` lists the runs of this project, newest first, with status, cost, `passed/total`, and `merged`. Add `--all-projects` for every project on this machine. Its JSON form is an array with `run_id`, `status`, `cost_usd`, `passed`, `total` and `merged`.
- `substrate tasks <run_id>` prints the task table. It has no JSON.
- `substrate report <run_id>` prints a text diagnostic: tasks, tokens, cost, files changed and verify outcomes.
- `substrate usage --by model --run <run_id> --output-format json` gives the cost of one run. The output has `rows` and `totals`. See section 12.

Do not edit the `.substrate/` directory by hand. It holds the run's records and its lock.

## 8. Confirming the work is real

A run that exits `0` is evidence that Substrate's checks passed. It is not proof that the change does what the user asked. Check these things before you tell the user the work is done.

1. **Read the flags in `result.json`.**
   - `merged`: `true` means the work is in the branch the run started on. `false` means it is not, and `not_merged_reason` says why.
   - `files_changed`: the files the run touched. Up to 50 names. `files_changed_total` is the full count. Check that they are the files you expected. A surprise file is a reason to look harder.
   - `verification`: `passed` means the final integration check passed. `failed` means it did not, and the run fails with exit `1`. `skipped` means the plan had one task, and its own checks ran instead. `not_run` means the final check could not run at all, so nothing verified the work as a whole.
   - `not_merged_reason`: the reason a finished run did not land, such as uncommitted changes in the checkout or a switched branch.
2. **Treat `not_run` as unverified.** `verification_note` says why it did not run. The work is merged, and exit `0` still applies, but nobody checked it as a whole. Say so to the user. Verify it yourself.
3. **Read the history.** Run `git log -n 10` in the project. Expect a merge commit for the run, and commits for each task, with the messages you would expect.
4. **Run the project's own tests.** Use the project's test command, the one in its README or `package.json` or equivalent. Use a real command, not a fake harness. If the run added tests, run them too.
5. **Try the result when you can.** A test suite can pass while the feature is still broken. Where the project has a way to run it, start the app or the command and exercise the new behaviour the goal named. Confirm that the output or the page looks right. If you cannot try it, say so in your report.

Use `substrate verify <task-id> --run <run_id>` to re-run one task's verify commands in its worktree. It is useful when a task's result looks doubtful. It does not merge anything.

Do not mark the work as verified because a run exited `0`. Mark it as verified only when you have run the checks above and they passed.

## 9. Exit codes

Read the exit code when a foreground command ends, or when `substrate watch` ends. For a detached run, read `status` and then `result.json`.

| Exit | Meaning | What to do |
|---|---|---|
| `0` | Success. The run finished. A `not_run` final check also exits `0`. | Confirm the work (section 8). If `merged` is `false`, run `substrate merge <run_id>` when the user wants it landed. |
| `1` | Run failed, or a landing was refused, or an internal error. | Read `failure_class`, `message`, `failed_tasks` and `next`. Resume to retry (section 11). For a refused landing with `status` `finished`, fix the cause in `not_merged_reason`, then run `next`. If `next` says `substrate merge <run_id> --partial`, that is a choice for the user. |
| `2` | Usage or config error. Nothing was spent and no run was created. | Read the message. Fix the command or the request, then run again. |
| `3` | Needs a human. The planner has questions, or the run is paused for approval, a permission denial or a rate limit. | For questions, see section 10. For the others, read the reason with `status` and tell the user. Resume when the cause is cleared. |
| `4` | A limit was reached: the run budget, or the time limit. Passed work is kept. | Ask the user whether to raise the limit. Resume with the `next` command, which names a larger limit (section 11). |
| `130` | Interrupted by SIGINT (Ctrl+C). | The run is paused. Resume it when you are ready. |
| `143` | Terminated by SIGTERM, for example by `substrate stop`. | The run is paused. Resume it when you are ready. |

`substrate watch` also exits `1` when the run's process has gone while the run was not finished. It exits `2` for an unknown run id, or when the project has no runs.

## 10. Handling needs_input

Exit `3` with `subtype` `needs_input` means the planner has questions. The result carries `run_id` and `questions`. Each question has an `id`, a `text` and, when one exists, a `default`.

Decide for each question:

- **Answer it yourself** when the answer is in the user's request, in the project's files, or in the charter at `.substrate/charter.md`. Keep the answer to what the evidence supports.
- **Take the `default`** when the default is safe and the user would not care. Leave the question out of your answers, and Substrate uses its `default`.
- **Ask the user** when the answer changes what gets built, costs money, or changes a public interface. Do not guess. Wait for the user's reply before you resume. Do not let the run sit paused for long without telling the user.

A question with no `default` must be answered. If you leave it out, the resume refuses it with exit `2`.

Send the answers on stdin as one JSON object:

```json
{
  "answers": [
    { "id": "Q1", "text": "Match the author case-insensitively, trimming spaces at the ends" }
  ]
}
```

Then resume the run. Replace the id with the `run_id` from the paused result:

```bash
substrate resume r_EXAMPLE0001 --answers -
```

The exit code of the resumed run applies. If it is `3` again, read the new `questions` and answer them the same way. An answer for an unknown question id is refused with exit `2`. `--answers` on a run with no pending questions is also refused.

## 11. Recovery playbook

Read the reason before you act. `substrate status <run_id>` prints the reason in text form, and the run report at the end of a run states what happened.

| Situation | What it means | What to do |
|---|---|---|
| **Stopped** (`paused`, `interrupted`, or stopped with `substrate stop`) | The run is paused, and its passed tasks are kept. | `substrate resume <run_id>`. Passed tasks are not run again. Safe to retry. |
| **Stopped (process gone)** (`stopped`) | The process that started the run died without a clean stop. | `substrate resume <run_id>`. Resume ends any worker the dead process left behind. |
| **Budget stop** (exit `4`, `budget_exhausted`) | The run hit its `--max-budget-usd` cap. | Ask the user before you raise it. Resume with `--max-budget-usd <n>` above the spend that `next` names. Each resume spends more. |
| **Time-limit stop** (exit `4`, `timeout`) | The run hit its `--timeout` limit. | Ask the user before you raise it. Resume with the longer `--timeout` in `next`. A resume starts a fresh clock. |
| **Permission or rate-limit pause** (exit `3`) | The run is waiting on the approval gate, a permission denial or a rate limit. | Read the reason. For a rate limit, wait and resume. For an approval, tell the user. |
| **Failed** (exit `1`) | Some tasks failed for good, or an internal error ended the run. | `substrate resume <run_id>`. The failed tasks retry as a new generation, the passed tasks stay, and skipped dependents run. Safe to retry, but it spends money again for the retried workers. |
| **Failed integration verify** | Every task merged, and the final check failed. Substrate repairs the code up to `integration.repair_attempts` times before it fails the run. | If `verification` is `failed` after repairs, resume: the resume runs only the verify again. If it fails again, the run branch needs a human fix. Tell the user. |
| **Failed in planning** | No plan was accepted. | `substrate resume <run_id>` plans again. Planning costs money again. Ask the user first if the cost matters. |
| **Finished but not merged** | The run passed, but it was not landed. | Read `not_merged_reason`. When the cause is cleared, run `substrate merge <run_id>`. A resume only tells you this. |
| **Merge refused for a dirty checkout** | Your checkout has uncommitted changes to tracked files. | Ask the user to commit or stash them. Then run `substrate merge <run_id>`. Nothing is lost. |
| **Merge conflict** | A task's changes conflicted with the branch. The conflicting task fails. | Resume to retry the task on a fresh branch from the run branch, or tell the user. |

### Commands for the playbook

```bash
substrate stop <run_id>
substrate resume <run_id>
substrate undo <run_id>
substrate discard <run_id>
```

- `substrate stop <run_id>` ends a running run gracefully. It waits up to 15 seconds. The run is paused, so resume continues it. Use it only when the user asks you to stop, or when the run is stuck (section 7).
- `substrate resume <run_id>` continues a run that did not finish. Use `--answers`, `--max-budget-usd`, `--timeout`, `--work`, `--merge` or `--no-merge` on the resume only when you need to change that setting. A resume uses the models, the verify list and the landing its run recorded, unless you name them again.
- `substrate undo <run_id>` moves the run branch back to the checkpoint before its most recent merged batch. It refuses while the run branch is checked out. Use it only when the user asks you to back out the last batch. Tell the user what it removed.
- `substrate discard <run_id>` removes the run's worktrees and deletes its run branch. The work is gone. Never run it without the user's explicit instruction. A run whose process is alive needs `--force`, which ends the process first.

### What is safe to retry

- **Safe, no new spend:** `status`, `watch`, `runs`, `tasks`, `report`, `usage`, `models`, `doctor`, `merge --dry-run`.
- **Safe to repeat, but spends again:** `resume` of a failed or stopped run. The passed tasks are not run again, but the retried tasks and any replan are.
- **Spends again from the start:** `resume` of a run that failed in planning. The planner runs again.
- **Not safe to repeat blindly:** `discard`, `undo` and `merge --partial`. Each changes the branch or the work. Ask the user first.
- **Never repeat a run for the same goal** as a retry. If the user wants a different outcome, start a new run with a changed goal, after you find out why the first one failed.

## 12. Cost and limits

- A run with no budget is never stopped for its cost or its time. This is the default. Substrate shows the cost live in `status` and `watch`, with `budget: none`.
- Set a budget only when the user asks for one, or when the user gives you a limit to respect. `--max-budget-usd <amount>` caps the run's spend. The request's `budget.max_usd` does the same. `--timeout <seconds>` caps the wall-clock time, and the request's `budget.max_wall_min` does the same in minutes. The flag wins over the request field.
- Tell the user the models you chose and a rough spend once the run ends. Get the figures from `substrate usage --by model --run <run_id> --output-format json`. Each row has `cost_usd` and `unknown_cost_rows`. A cost Substrate cannot price is not in `cost_usd`, but its tokens are counted.
- The planner's `budget` fields in a plan are estimates. They are never a cap.
- Planning costs money every time it runs, including every resume that plans again.
- Never run a live harness as a test of Substrate, and never run `claude`, `opencode` or `agy` directly to check something. Each live call costs the owner money. If you need to see what a Substrate command prints, use a scratch directory outside the project, and do not let it reach a real model.

## 13. The browser UI

Substrate has a browser UI that shows every project registered on this machine, with their runs, transcripts, diffs and verify output. You can use it to show the user what is happening.

```bash
substrate ui start
substrate ui status
```

`substrate ui start` starts the UI in the background if it is not already running, and prints its URL. `substrate ui status` prints whether it is running, its URL and its pid. `substrate ui start --output-format json` prints `{"url","pid","host"}`. Give the user the URL that `substrate ui status` prints. Read the URL from the output each time. Do not store or repeat it from memory.

What the user can do there:

- See every registered project's runs, their status, their tasks and their diffs.
- Read a run's transcripts and verify output.
- Stop or resume a run.
- Chat with a run's planner. A message goes to the planner, which may answer, or may write a change to the plan. Tell the user before they send a message that asks for a plan change.

The UI has no login. Anyone who can open its URL can see and change its runs. By default it listens on the loopback interface only, so it is reachable only from the same machine. Do not change its host to make it reachable from other machines unless the user asks for it.

## 14. Reporting back to the user

Keep the report short. Use this template:

```text
Asked:      <the user's request, in one sentence>
Done:       <what changed, in plain words>
Files:      <the files changed, from files_changed; say how many more if the list is cut>
Verified:   <the project's tests and what you tried by hand, with the result of each>
Not verified: <anything you could not check, and why; use the verification_note for not_run>
Cost:       <the models used, and the spend from substrate usage>
Undo:       <how to back it out: git revert of the merge commit, or substrate undo <run_id> if the run is not yet merged and the user wants it gone>
Run:        <run_id>, status <status>, exit <exit_code>
```

Do not paste the raw JSON into the report. Name the files and the results in plain words.

### Do not

- Do not edit the run branch by hand unless you are recovering a run that the user has asked you to fix (section 11). Make any fix on a branch of its own, or let a resume do the work.
- Do not run two writing runs against the same project without first checking `substrate runs`. A second run can collide with the first one's worktrees and branches. If one is running, wait for it, or tell the user.
- Do not poll faster than every few seconds. Every 30 to 60 seconds is enough for a run.
- Do not treat a `not_run` verification as verified.
- Do not discard a run's work, and do not `undo` a merged batch, without the user's instruction.
- Do not resume a run blindly after a budget or time stop. Ask the user first.
- Do not invent a model id, a flag or a command. Check [cli.md](cli.md) when you are unsure.
- Do not put secrets, credentials, or the user's personal details into a goal, a request, an answer or a report.
- Do not start a run before `substrate doctor` exits `0`, unless the only failures are warnings you can explain.

## 15. A worked session

The user writes: "Our bookshelf API can't filter books by author. Add a `GET /books?author=` filter, and keep the tests green."

1. **Check readiness.** Run `substrate doctor --output-format json`. The exit code is `0`, so you go on.
2. **Choose models.** Run `substrate models --output-format json`. Under `providers`, `claude` is `installed: true`, with `opus` and `sonnet` in its models. You pick `opus:high` for the planner and `sonnet:medium` for the worker. The goal is a feature that spans files, so the mode is `plan`, and the project's test command is the verify command.
3. **Start detached.** Run:

   ```bash
   substrate run --detach --plan claude:opus:high --work claude:sonnet:medium --verify "npm test" "Add a GET /books?author= filter that returns books whose author matches, ignoring case. Keep the existing tests passing." --output-format json
   ```

   It prints one JSON object:

   ```json
   {"run_id":"r_EXAMPLE0001","pid":48213,"log":".substrate/runs/r_EXAMPLE0001/progress.log","watch":"substrate watch r_EXAMPLE0001","status":"substrate status r_EXAMPLE0001","stop":"substrate stop r_EXAMPLE0001"}
   ```

   You record `run_id` `r_EXAMPLE0001`, and you tell the user the run has started.
4. **Poll.** Every 30 to 60 seconds, run `substrate status r_EXAMPLE0001 --output-format json`. Early on it reads:

   ```json
   {"status":"running","phase":"task T2 running","counts":{"passed":1,"running":1,"failed":0,"waiting":0,"skipped":0},"next":["substrate watch r_EXAMPLE0001"]}
   ```

   Keep polling while `status` is `running`. A `running` status with a rising `elapsed_s` is normal.
5. **Branch on the end.** `status` becomes `finished`. You read `.substrate/runs/r_EXAMPLE0001/result.json`:

   ```json
   {"run_id":"r_EXAMPLE0001","status":"finished","exit_code":0,"merged":true,"base_branch":"main","files_changed":["src/books/routes.ts","src/books/store.ts","test/books.test.ts"],"files_changed_total":3,"verification":"passed"}
   ```

   `merged` is `true`, and the verification passed as a whole, so the work is in the branch.
6. **Verify.** Run `git log -n 5`, and expect the run's merge commit and its task commits. Run `npm test` yourself. Start the server, and request `GET /books?author=` for an author who has books, and check that only their books come back. The `files_changed` list matches what the goal named.
7. **Report.** You write, in the template of section 14:

   ```text
   Asked:        a GET /books?author= filter for the bookshelf API
   Done:         the route filters books by author, ignoring case
   Files:        src/books/routes.ts, src/books/store.ts, test/books.test.ts
   Verified:     npm test passes (run it again yourself); a manual request returned only the matching books
   Not verified: nothing
   Cost:         planner opus, worker sonnet; spend from substrate usage --by model --run r_EXAMPLE0001
   Undo:         git revert the run's merge commit
   Run:          r_EXAMPLE0001, status finished, exit 0
   ```
