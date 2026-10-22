# CLI reference

This page describes the `substrate` command as the code implements it. Every flag, command and exit code below was checked against `src/cli/` and the built CLI. Settings files and their layers are in [config.md](config.md). Callers that are agents should read [caller-guide.md](caller-guide.md) first.

In this document `substrate` means either `node bin/substrate.mjs` or `node dist/substrate.mjs` from the repository root.

## Invocation

```text
substrate <command> [options] [arguments]
substrate <prompt words>
```

- With no arguments, `substrate` prints the command list and global options and exits 0. `--help` or `-h` does the same, for any command. There is no per-command help text.
- A first word that is not a command is a run prompt. `substrate "fix the flaky test"` is the same as `substrate run "fix the flaky test"`. A single word works too, so a mistyped command name starts a run instead of failing.
- `-p` or `--print` with no command runs a prompt headlessly. An option that is not in the option table is an error: `Error: Unknown option`, exit 2. Only `bench` gets its option names past that check, and it does not use them (see bench).
- A flag from the option table is accepted by every command, even when that command does not read it. Such a flag is ignored. For example `report --output-format json` is accepted and still prints text.
- `--resume` and `--continue` with no command print help. Use `substrate run --resume <target>`, `substrate run -c`, or `substrate resume <target>`.

## Exit codes

Copied from SUBSTRATE-PLAN.md section 4.6:

| Code | Meaning |
|---|---|
| `0` | success, including a run whose final integration check could not run (a warning; see Integration verify) |
| `1` | run failed: a task failed for good, the integration verify failed, the run could not go on without an answer that does not exist (see Failed and partial runs), or an unexpected internal error ended it (see Internal errors) |
| `2` | usage/config error |
| `3` | needs human: the planner left questions (`QUESTIONS.md`), or a run paused for approval at Substrate's permission gate, a permission denial or a rate limit. Exit `3` for approval depends on the gate, not on a harness denial. An escalation with no question is not `3`: it fails the task and the run with exit `1` |
| `4` | a limit was reached: the run budget (`--max-budget-usd`, a budget stop) or the wall-clock time limit (`--timeout`, a timeout stop, R11.2). The run is paused and a resume continues it |
| `130` | SIGINT (Ctrl+C) |
| `143` | SIGTERM |

For a run, the engine maps its state to a code: finished and planned (a plan-only run, R10.5) are `0`; failed or cancelled is `1`; paused for budget is `4`; paused for a user cancel is `130`; any other pause, including a run paused for answers to `QUESTIONS.md`, is `3`. Commands that are not runs use `0`, `1` and `2` as their entries describe.

## Global options

| Option | Used by | Description |
|---|---|---|
| `-h`, `--help` | all | print help |
| `-p`, `--print` | run | run headlessly and print the result |
| `-c`, `--continue` | run | continue the most recent session |
| `--resume <target>` | run | resume a run or session by id |
| `--session-id <id>` | run, resume | bind to or create a session |
| `--fork-session` | run, plan, resume | branch a session; `run` needs `--resume` or `--continue`, `resume` needs a session target |
| `--output-format <fmt>` | run, plan, resume, status, models, usage, doctor, backends, sessions, history | `text` (default), `json`, or `stream-json`. `json` prints one compact line (no indentation), so a caller can parse all of stdout at once or line by line. `stream-json` prints one object per line. In `text` mode, `run`, `plan` and `resume` print live progress on stdout (see Progress output). Commands that do not read it always print text. |
| `--settings <file>` | most commands | read this settings file instead of the project's |
| `--sandbox` | run, verify | enable the bubblewrap sandbox (`sandbox.enabled`) |
| `--merge` | run, resume | merge a finished run into the checked-out branch for this run only, as if `git.auto_merge` were `true`. The request's `merge: true` does the same; the flag wins over the request field. Neither given, a new run uses the setting (default `true`), and a resume uses the choice its run recorded on `run.created` (R10.3). |
| `--no-merge` | run, resume | keep a finished run on its run branch for this run only, as if `git.auto_merge` were `false`; `substrate merge <run>` lands it later. The request's `merge: false` does the same. `--merge` with `--no-merge` exits 2. |
| `--review` | run | plan only, then stop for review (R10.5): the run ends `planned` and records `--work`, so `substrate resume <id>` runs the reviewed plan. Needs `--work` (exits 2 without it). |
| `--concurrency <n>` | run, resume, plan | the number of workers that may run at once for this run, a whole number from 1 to 16 (otherwise exit `2`: `--concurrency must be a whole number from 1 to 16`). It overrides `concurrency.workers`. The value is recorded on `run.created`, and a resume uses it unless `--concurrency` is given again. `plan` accepts it; a plan starts no workers. `--concurrency 1` runs the tasks one at a time. |
| `--no-governor` | all | deprecated no-op. The governor was deleted on 2026-10-20; the flag is still accepted and ignored so existing callers do not break |

## Progress output

`run`, `plan` and `resume` report what they are doing while they work, so a caller does not need to poll `status` or read event files. `--output-format` (or `SUBSTRATE_OUTPUT_FORMAT`) picks the form.

**Following a run from another process (R10.2).** Every run writes its progress to `.substrate/runs/<id>/progress.log` in every output format: each progress line the text renderer prints, the summary block, and a header `# run <id> started <ISO time>`. A resume appends `# resumed <ISO time>` and goes on. The log is appended and flushed line by line; a write that fails never fails the run (one warning goes to stderr). The first lines of a run say how to follow it:
  - text: after the start line, `[mm:ss] follow this run from another terminal: substrate watch <id>` and `[mm:ss] log: .substrate/runs/<id>/progress.log`
  - json and stream-json: one stderr line, `run <id> started; follow it with: substrate watch <id>` (a resume says `resumed`); the stdout contract is unchanged

Once a run ends, in any state, its outcome is kept in the run directory: `summary.txt` (the summary block exactly as printed), `result.json` (the object `--output-format json` prints) and `REPORT.md` (the run report, see Run report below). A resumed run overwrites all three when it ends. A run that ends in an exception, or is interrupted before its summary exists, still gets its `REPORT.md`.

Two other processes can read a run while it works: `substrate watch <id>` follows it (see below), and `substrate status <id> --output-format json` gives a snapshot that a poll can read. Neither takes the run lock or writes anything.

Durability of the journal: `events.jsonl` is appended with a synchronous write per event, before the next step; the write is not `fsync`ed, so a power loss can lose the last events the operating system had not yet written. A kill of the process does not lose a written event.

**Plan warnings (R12.3).** Lint refuses a plan only when it cannot run (see [plan-lint.md](plan-lint.md)). Every other lint finding is a warning and never costs a planner retry. An accepted plan's warnings are recorded in `.substrate/runs/<id>/plan-warnings.txt`, one per line: the rule id, the task (`-` for a plan-wide warning) and the message, tab-separated. The file is removed when the accepted plan has none. The text progress names the count and the first warning, and the json result counts them (`plan_warnings`).

- **`text` (default).** Progress lines and the summary block go to stdout, in order, so one stream carries the whole run. Errors and warnings go to stderr. Every progress line starts with `[mm:ss]`, the time since the run started. Lines written:
  - `run <id> started: mode <mode>, planner <harness:model>, worker <harness:model>` (a `solo` run has no planner)
  - `routed to plan (<rationale>)` or `routed to solo (<rationale>)`. The rationale says why: `explicit mode flag` (the mode was set explicitly), `mechanical edit of a named file` (auto mode, one existing file named with a mechanical verb, so solo), or `request is not a mechanical edit of a named file` (auto mode, so plan)
  - `planning with <harness:model>`, then `planner attempt <k> finished, $<cost>` for each planner attempt
  - `plan rejected (attempt <k>/<max>): <first two messages>` when the engine refuses a planner output, and the retry that follows. Lint messages carry their ids, such as `[L003]`.
  - `plan ready: <n> tasks`, then, when the accepted plan has lint warnings (R12.3), `note: the plan has <n> warnings (see .substrate/runs/<id>/plan-warnings.txt); the first: <id> <message>` on its own line, then one indented line per task: id, title, `[class]`, and `after <deps>` when the task has dependencies
  - per task: `[task <id>] started (gen <g>, attempt <a>) on <harness:model>`, `worker finished, $<cost>`, `verify passed` or `verify failed: <command>: <one line of output>`, `merged, $<cost>`, and `failed: <failure_class>: <message>` (a planner failure has no task id, so its line reads `[plan] failed: ...`; a run-level event with no task id reads `[run]`)
  - `integration verify started` (once, after every task of the plan has merged: R9.1), `integration verify passed`, `integration verify failed: <command, first 160 characters> (exit <n>)` (or `(timed out)`; older logs print a plain `failed`), `budget warning: ...`, `run paused: <reason>`
  - `setting up the integration check (<n> setup commands)`, then `setup done`, or `setup failed: <command, first 160 characters> (exit <n>)` (or `(timed out)`). The plan's `setup` commands run once in the integration worktree before the final verify (R12.2); a worktree that is set up already runs nothing. No base check runs: no note about the base commit is printed.
  - `integration verify skipped (single task: its own checks already ran)` for a one-task plan (R12.2)
  - `warning: integration verify could not run (<command, first 160 characters>: <reason>); the work is merged but was not verified as a whole` for a final check that could not run (R12.2). The run still finishes; see Integration verify above.
  - `run <id> <status>: <passed>/<total> passed, $<cost>`, then the summary block

  A failed planning run has no branch, so its summary reads `Branch:     (none, planning failed)`, its json result carries no `branch`, and its `Next:` line reads `substrate resume <id>  (plans again; planning costs again)`, because resume plans again and spends again (R10.4: a failed run is resumed, known issue 41 reversed).
  The summary block keeps its existing lines and adds `Merged:` (`yes` when the run's work is in the checked-out branch, `no` otherwise), and, when the final check could not run, `Verification: not run (<reason>)` (R12.2). A run that finished with exit `0` also prints a `Result:` block: `Result: <n> files changed on branch <run branch>` (or, when it did not merge, `Result: finished: work is on branch <run branch>, not merged yet`), then `Merged into <base branch> (working tree updated)`, or the reason the run is not merged (`not merged: ...`), or, when `--no-merge` or `git.auto_merge: false` kept it, `Result: finished: work is on branch <run branch>, not merged (merging was turned off)` with `Next: substrate merge <id>`; then `Files:` with up to 10 changed file names (`  ... and <k> more` when there are more). The summary is written after the landing, so `Merged:` is final when it prints. Before the last `run ... finished` line a progress line says where the work went: `[mm:ss] merged into <branch>`, or `[mm:ss] not merged: <reason>`. A run that did not finish with exit `0` prints the run report after the lines above, in place of the old `Drafts and logs`, `Next`, `Reason`, `Output` and `NOT merged` lines (P2.2, see Run report below). The report opens with one plain sentence that says what was merged and what happened (for example `Nothing was merged. 1 of 2 tasks finished; T2 failed after one fix and two replans (the replan budget ran out).`). It then names each task with its state, its changed files, its failure in plain words, the command that failed and its output tail, and its saved patch. It names the produced work (the run branch and its commits, the saved patches and the run directory `Drafts and logs:`), what the engine tried (`Recovery:`), the `Reason:` line (the raw failure class and message), and the `Next:` commands. An interrupted run prints `Interrupted. Resume with: substrate resume <id>` in the same place. A run paused for answers prints its questions and then its `Next:` line with `--answers`.

- **Heartbeat.** When no progress line has been written for 15 seconds, the run writes `[mm:ss] still working: <phase> (<s>s, $<cost>)`, and again every 15 seconds until the next progress line. Until the first cost is reported (claude reports a session's cost when the session ends), the line reads `[mm:ss] still working: <phase> (<s>s; cost is reported when planning ends)` in planning, or `... when this step ends` in any other phase, so no `$0.0000` is shown for a cost not yet known. The phase is `planning`, `setup`, `task <id> running` (`running <id>, <id>` while several workers run at once, R8.3), `verifying <id>`, `merging <id>`, `scheduling` (between tasks), or a named step such as `integration verify`, `replanning <id>` or `paused`. The seconds count the time in that phase. `SUBSTRATE_HEARTBEAT_MS` changes the interval (see [config.md](config.md)).

- **`json`.** One compact line when the run ends (`result.json` holds the same object). It carries no progress, so use `text` or `stream-json` to watch a run. Besides the run's fields it carries the run `report` (the object REPORT.md is written from: `outcome`, `verdict`, `merged`, `tasks` with each task's state, files, `plain_reason`, `failing_command`, `output_tail`, `patch_path`, `produced`, `integration`, `recovery` and `next`), and where the work landed: `merged` (boolean), `branch`, `base_branch`, `files_changed` (up to 50 file names), `files_changed_total`, and `next` (exact command strings a caller may run, such as `substrate merge <id>` or `substrate resume <id>`). A failed run also carries `failure_class`, `message` (empty when the failing event had none) and `drafts_dir` (relative to the project). A run whose accepted plan had lint warnings carries `plan_warnings`, their count (R12.3). When the final integration check recorded an outcome, the json also carries `verification` (`passed`, `failed`, `skipped` or `not_run`), and for `not_run` a `verification_note` with the reason (R12.2).

- **`stream-json`.** One JSON object per line, in order: every engine event as it happens, the heartbeats, and a final `result` line. Event lines carry the catalog name in `type` (`usage.recorded` streams as `usage`), with `run_id`, `seq` and `ts`. A heartbeat line has `"type": "heartbeat"`, `run_id`, `ts`, `elapsed_s` (seconds since the run started), `phase`, `phase_elapsed_s` and `cost_usd` (a number, or `null` until the first usage record), and no `seq`. Fields added for progress:
  - `plan.format_rejected` (new event): `attempt`, `max_attempts`, and `errors`, at most 5 strings of 300 characters each. It is emitted for each refused planner output, before the retry.
  - Planner session failures (R7.9): a session that claude stops at its `--max-budget-usd` cap fails `budget_exceeded` with the message `planner stopped at its budget cap of $<cap> (spent $<spent>); the run budget is $<run budget>`. Any other session failure fails `worker_crashed` with `Planner session failed with exit code <n>: <what the harness reported>`, where the report is the error result's subtype and error lines, or the harness error, and `no error output from <harness>` when it reported nothing.
  - Planner refusals (R7.7): a planner output is refused by the format lint, by the contract typecheck (run in the run directory that holds the manifest), or by the approval lint (the lint the approval step runs, with placeholder stubs). Every refusal is a `plan.format_rejected` and a retry while attempts remain: `budgets.planner_format_retries` plus one in all. Nothing is committed for a refused plan, so `contracts.committed` is emitted only for the plan that passes. After the last attempt the run ends `failed`, with a `task.failed` of class `spec_invalid` whose message carries the last diagnostics. Each diagnostic has the run directory and the repository root taken out. Only a blocker refuses a plan; every other lint finding is a warning, which is recorded and never costs a retry (R12.3, see [plan-lint.md](plan-lint.md)).
  - `run.routed` gains `rationale`.
  - `task.session.started` gains `backend` and `model`.
  - `integration.failed` carries `failure_class: integration_failed`, `message` (the `Reason` text above), `command` (at most 500 characters), `exit_code` (absent when the command timed out) and `output_tail` (the last 2000 bytes of its output, secrets redacted, the worktree and repository paths removed). Runs before R7.11 wrote `base: true` (the base check failed the run) or `base: false`; new runs no longer write `base`.
  - `integration.skipped` (new, R12.2): `reason: single_task`, in place of `integration.started` for a one-task plan.
  - `integration.could_not_run` (new, R12.2): `command` (at most 500 characters) and `reason`. The run then finishes with exit `0`; no `integration.failed` is written.
  - `integration.repair.started` (new, R12.4): `task_id` (`REPAIR-<attempt>`), `attempt` and `max` (the configured attempts). One per repair attempt of a failed final check.
  - `integration.repair.finished` (new, R12.4): `task_id`, `attempt` and `passed`. When an attempt did not pass, `reason` (at most 500 characters) says why: a guard rejection, a check that still fails, or `CHECK-UNFIXABLE: <reason>`.
  - `integration.finished` gains `repaired` (1 to 5) when the check passed only after repair attempts: the attempt that passed it.
  - `integration.started` carries no fields. Runs before R12.2 may carry `base_verify_passed` (the base check, R7.11), which is no longer written; readers must accept it and ignore it.
  - `integration.setup.started` (new, R12.2): `commands` (the number of setup commands), emitted only when the setup runs, before `integration.started`.
  - `integration.setup.finished` (new, R12.2): `passed`, and when it did not pass `command` (at most 500 characters), `exit_code` (absent when the command timed out) and `timed_out` (true when it did).
  - `task.setup.failed` (new, R13.1): `task_id`, `generation`, `attempt`, `command` (at most 500 characters) and `reason` (`exit <n>`, `timed out` or `could not start`). The plan's setup failed in a task worktree. This is a warning, not a failed task: the worker still runs, and its prompt names the failed command and the tail of its output so it can repair its environment. A task never fails, and never counts a heal or replan, for a setup failure.
  - `task.verify.finished` gains `failed_command` and `failed_output` (one line, at most 300 characters) when a verify fails.
  - `plan.produced` lists each task as `id`, `spec`, `title`, `class` and `depends_on`. R12.3 adds `warnings`, the first 20 lint warnings of the accepted plan (`id`, `task` when the warning names one, and `message` of at most 300 characters), and `warning_count`, their total. An empty list and a zero count mean the plan had none.
  - `contracts.committed` gains `note` when the planner's manifest `base_ref` was ignored. The run's own base (HEAD when the run starts, the commit the planner is given in its request) is authoritative, and the manifest's `base_ref` is advisory: a value that is absent, `(none)`, the current branch's name, or unresolvable, or that names the run base's commit under another name, is ignored and the run base is used. Text mode prints the note as `note: planner base_ref 'main' ignored; using run base <short sha>`. A manifest `base_ref` that names a different commit that does resolve is used as the base, as before.
  - the final `result` line carries `branch`, `merged`, `base_branch`, `files_changed`, `files_changed_total` and `next`, and for a failed run `failure_class`, `message` and `drafts_dir`, with the same meaning as in `json`.

A `text` run looks like this (the fake harness, two tasks, timestamps all under one second):

```text
[00:00] run r_HXEFJJSPAOZC started: mode plan, planner claude:claude-sonnet-5-5, worker claude:haiku
[00:00] routed to plan (explicit mode flag)
[00:00] planning with claude:claude-sonnet-5-5
[00:00] planner attempt 1 finished, $0.0001
[00:00] plan ready: 2 tasks
[00:00]   T1  Add feature helper  [feature]
[00:00]   T2  Add the other file  [feature]  after T1
[00:00] [task T1] started (gen 1, attempt 1) on claude:claude-sonnet-5-5
[00:00] [task T1] worker finished, $0.0001
[00:00] [task T1] verify passed
[00:00] [task T1] merged, $0.0001
[00:00] [task T2] started (gen 1, attempt 1) on claude:claude-sonnet-5-5
[00:00] [task T2] worker finished, $0.0001
[00:00] [task T2] verify passed
[00:00] [task T2] merged, $0.0001
[00:00] integration verify started
[00:00] integration verify passed
[00:00] run r_HXEFJJSPAOZC finished: 2/2 passed, $0.0003

--- Run Summary ---
Run ID:     r_HXEFJJSPAOZC
Session ID: sess_103c3ff8-b339-4fba-a384-a09171c11110
Status:     finished
Branch:     substrate/runs/r_HXEFJJSPAOZC
Tasks:      2 passed / 2 total
Total Cost: $0.0003
Exit Code:  0
Merged:     yes
```

## watch

```text
substrate watch [--no-follow] [--output-format stream-json] [run-id]
```

Follows a run from any terminal or process, at any time. Without a run id it follows the newest run that is still running in this project, else the newest run. It prints the run's history from `events.jsonl` with the same renderer a live run uses, so the lines match what the run printed (the `[mm:ss]` is the time since the run started), then follows new events, polling about twice a second.

- A heartbeat line `[mm:ss] still working: <phase> (<s>s, $<cost>)` is printed when nothing has been printed for 15 s (`SUBSTRATE_HEARTBEAT_MS` changes the interval).
- When the run reaches a terminal state (finished, failed, paused, interrupted or budget-stopped), watch prints the run's summary block (its `summary.txt`) and exits with the run's exit code (`result.json`'s `exit_code`).
- If the process that started the run has gone while the run is not terminal (killed, crashed, the machine restarted), watch stops: `run <id> is not running (the process that started it has gone). Resume with: substrate resume <id>`, exit `1`.
- `--no-follow` prints the history and exits `0` at once, without the summary.
- `--output-format stream-json` prints the raw events as JSON lines, history and then new events, instead of the text. `--output-format json` is refused (exit `2`); use `status`.

Watch takes no lock and writes no file. A resumed run's history shows its `# resumed` line from the progress log.

Exit codes of `watch`: the run's own exit code when it ends while watched or when it has ended (`0`, `1`, `3`, `4`, `130`, ...); `1` when the run's process has gone; `2` for `No such run: <id>`, or when the project has no runs.

## runs

```text
substrate runs [--all-projects] [--output-format json]
```

Lists the runs in this project, newest first, one line each: id, status, start time (how long ago, and ISO), cost, `passed/total` tasks, `merged yes|no`, and the first 60 characters of the request. `--all-projects` lists the runs of every project on this machine instead, newest first. Projects come from the registry at `$XDG_STATE_HOME/substrate/projects.json` (default `~/.local/state/substrate/projects.json`), which records each project that runs `run`, `plan`, `resume` or `init`, and which is backfilled once from the usage mirror when it does not exist yet. A project whose directory or `.substrate` directory is gone is left out and dropped from the registry. Each row names its project: the text shows the project name before the request, and the json adds `project` (the absolute path) and `project_name`. The text status word is the one `status` shows (R11.3): `running`, `stopped (process gone)`, `planned`, `finished`, `failed`, `paused: stopped by you` (a Ctrl+C or `substrate stop`), `paused: budget`, `paused: needs your answers`, `paused: <reason>`, or `cancelled`. The JSON `status` keeps its own values: `running`, `stopped`, `planned`, `finished`, `failed`, `paused`, `interrupted` (a user stop) and `cancelled`. With no runs it prints `No runs yet` and exits `0`. `--output-format json` prints one JSON array of objects (`run_id`, `status`, `started_at`, `cost_usd`, `passed`, `total`, `merged`, `request` up to 200 characters). `history` lists archived runs and is unchanged.

## stop

```text
substrate stop [--force] [run-id]
```

Stops a running run from any terminal. The run's process is sent SIGTERM, the same graceful path as Ctrl+C: its workers are killed with their process groups, and the run is `paused` with reason `user_cancel`, so `substrate resume <run-id>` continues it (tasks that passed are not run again). Output: `stopping run <id> (pid <n>)...`, then `run <id> stopped. Resume with: substrate resume <id>`, exit `0`.

- **Which run.** With a run id, that run. Without one, the one run that is running in this project; when two or more are running, `stop` exits `2`, lists them, and names `substrate stop <run-id>`.
- **Waiting.** `stop` waits up to 15 seconds for the process to exit. If it has not, it exits `1` with `run <id> did not stop within 15 s; use: substrate stop --force <id>`.
- **--force.** After that wait, `stop --force` sends SIGKILL to the same process. Workers the run recorded are ended by the next `substrate resume`, as after any SIGKILL (see Interrupt and resume).
- **Safety.** The pid comes from the run's lock file. It is signalled only when its command line names `substrate`; otherwise `stop` exits `1` with `pid <n> is not a Substrate process (stale lock); not signalling it` and sends nothing.
- **A run that is not running** exits `0` and says so: `run <id> is not running (it ended finished)` for a run that finished or failed, or `run <id> is not running (stopped). Resume with: substrate resume <id>` for a run whose process went without a clean stop. With no run running in the project it prints `no run is running in this project`.
- An unknown run id exits `2` with `No such run: <id>`.
- `--output-format json` prints one object: `run_id`, `stopped` (true when the process ended), `pid` (the run's process, or null), and `next` (the command that continues the run, or null).

## run

```text
substrate run [options] [prompt]
```

Runs a goal end to end: plans it (unless the mode is `solo`, or `auto` routes it to `solo`, see Mode), starts workers in git worktrees, verifies each task, and merges what passes.

- **Prompt**: the first argument. If it is missing and stdin is piped, the trimmed stdin text is the prompt. With neither, exit 2 with `prompt required on command line or stdin`.
- **Required models**: the caller must name the models. `auto` and `plan` need a planner and a worker; `solo` needs the worker only. A model counts only when it is given on the command line (`--plan`, `--work`, `--model`, `--worker-model`) or in the request payload (`planner.model`, `worker.model`). Settings files, profiles and defaults do not count. A missing model exits 2 before any run directory, `.substrate/` directory, git action or harness process is created, naming what is missing with an example. In `json` and `stream-json` output it prints `{"error":"..."}` on stdout.
- **Git repository**: `run` and `plan` need a git repository. Inside a work tree the run proceeds as before. A directory that is not a repository and is empty (a `.substrate` directory is ignored) is initialised with `git init` and one empty commit (`substrate: initial empty commit`), and the run prints `initialised a new git repository (empty directory)` (stdout in text mode, stderr in json modes). Any other content exits 2 with the message "not a git repository: run git init (and commit) first, or run substrate in an empty directory". A repository with no commits gets the same initial commit when its tree is empty; with content it exits 2. Substrate never initialises a repository in your home directory.
- **Commit identity**: engine merges use git's configured `user.name` and `user.email`. When git has neither, the merge commit is authored as `substrate <substrate@localhost>` through the environment of that one git command. Substrate never overrides a configured identity and never writes git config.
- **Request file**: `--request <file|->` reads a JSON request from a file (relative to the project) or from stdin with `-`. A request cannot be combined with a prompt. An invalid request prints `{"error":"invalid_request","problems":[...]}` on stdout and exits 2. The fields are listed in [caller-guide.md](caller-guide.md).
- **Roles**: `--plan <provider[:model[:effort]]>` sets the planner and `--work <provider[:model[:effort]]>` sets the worker. Either one switches the run to the request path. `--model` sets the planner (in `auto` and `plan` modes) or the worker (in `solo`). `--worker-model` sets the worker. `--effort` sets the planner's effort. The named models are used for the whole run: `--plan` for the planner, `--work` for every task (or the solo worker), and they beat profiles and `routing`/`roles` settings (see Route precedence in [config.md](config.md)). `resume` does not read them. The claude harness accepts the aliases `haiku`, `sonnet`, `opus` and `fable`, and the ids `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5` and `claude-fable-5-1`. `claude-fable-5-1` has no price in the table, so its cost shows as unknown. An id outside this list exits 2 before the project directory is touched: no git repository is created and no `.substrate` directory is written.
- **Mode**: `--mode auto|solo|plan`. The default is `auto`. In `auto`, the deterministic router decides: a request that names one existing file and uses a mechanical verb (such as bump, rename, typo, format, move, delete or remove) runs as `solo`, and every other request runs as `plan`. `solo` runs one worker with no planner. `plan` always plans. An explicit `solo` or `plan` skips the router. Naming a planner does not change the route (R7.2 superseded the R6.4 rule that it forced `plan`): `auto` still needs both models named, and the router alone decides `plan` or `solo`. To force planning, pass `--mode plan`.
- **Verify**: `--verify "<cmd>"` adds a verify command. It can be repeated. In `solo` mode, a run with no verify command warns that only scope and budget checks apply. The same warning prints when `auto` routes a run to `solo`.
- **Limits** (off by default, owner 2026-10-21): with no limit set a run is never ended for its cost or its time, and its cost is shown live in `status` and `watch` (`budget: none`). Turn a brake on only when you want it: `--max-budget-usd <amount>` caps the run's spend, `--timeout <seconds>` caps its wall-clock time (R11.2, known issue 60). `substrate stop <id>` ends a run at any time. The clock counts the time of this process, planning included, and starts again on each resume. Whole seconds, 1 or more; any other value exits `2` with `--timeout must be a whole number of seconds, 1 or more`. The project setting `budgets.run.max_wall_min` (minutes) applies when the flag is not given, and the request's `budget.max_wall_min` (minutes) too; the flag wins. When the limit is reached the run stops like a budget stop (see Time limit stop below): exit `4`, paused with reason `timeout`, a progress line `run paused: timeout (<n>s limit reached)`, and `Next: substrate resume <id> --timeout <larger n>`. A run that finishes before the limit is unaffected. `--concurrency <n>` sets how many workers run at once (see the options table).
- **Tools**: `--allowed-tools` and `--disallowed-tools` take a list (comma-separated or repeated).
- **Approval by estimate**: the estimated cost pauses a run for approval (`needs_approval`) only when `budgets.approval_threshold_usd` is set; it is unset by default. `--permission-mode default` always asks, whatever the estimate.
- **Permissions**: `--permission-mode default|plan|acceptEdits|dontAsk|bypassPermissions`. The run default is `dontAsk`. This is Substrate's approval gate. It does not change how the harness is launched: harnesses always run with permissions bypassed (owner decision 2026-10-19).
- **History**: `--history-all` includes archived runs from every charter version in the planner's context.
- **Detach (R10.3).** `--detach` starts the run in the background and returns at once, so the run no longer depends on this terminal. The CLI starts itself again as a detached child (its own session, stdin ignored or fed the piped prompt, SIGHUP ignored) with the same arguments minus `--detach`, and writes its output to `.substrate/detached/<unix-ms>-<pid>.log`. Once the child's run holds its lock, the command prints `run <id> started in the background (pid <n>)` and the lines `watch:  substrate watch <id>`, `status: substrate status <id>`, `stop:   substrate stop <id>` and `log:    .substrate/runs/<id>/progress.log`, then exits `0`. `--output-format json` prints one object: `run_id`, `pid`, `log`, `watch`, `status`, `stop`. The request is checked in the started process, which runs the same preflight as a foreground run: a missing model, an invalid request or a directory that is not a repository exits `2` with the same message, and no run is created. The check takes a fraction of a second, and its message comes back through the command's output. If the child exits before its run exists, the command prints the tail of the log and exits with the child's code; a child with no run after 30 seconds is ended and the command exits `1`. `--detach` with `--output-format stream-json` exits `2` with `--detach cannot stream; use substrate watch`. Follow it with `watch`, check it with `status`, end it with `stop` (see stop), and continue it with `resume` after a stop.
- **Exit codes**: see the table above. A run that needs answers exits `3` and prints a `needs_input` result with its questions. Answer them with `resume --answers`.
- **Integration verify (R9.1, R12.2).** `integration_verify` is a whole-project command. It runs once, after every task of the plan has merged, on the run branch. Tasks merge into the run branch as they pass, with no whole-project verify between merges.
  - **Setup first (R12.2).** The plan's `setup` commands run once in the integration worktree before the final verify, with the same cwd, timeouts and environment as in a task worktree. They run once per worktree: repair attempts and re-verifies in the same worktree do not reinstall, and a worktree created again after a resume runs them again. A plan without `integration_verify` runs no setup and no verify.
  - **No base check (R12.2).** No `integration_verify` runs on the base commit before the final verify, and no note about the base is printed. The base is verified only when the final verify has failed, as the anchor of the bisect below.
  - **Single task (R12.2).** A plan with one task is not verified again: its own checks ran in its worktree, and the run branch is base plus that task. The run records `integration.skipped` (`reason: single_task`), finishes, and its `verification` is `skipped`. A plan with two or more tasks runs the final verify.
  - **Outcomes (R12.2).** The final verify has one of three verdicts or no verdict:
    - `passed`: every command passed. The run finishes and lands as usual; `verification` is `passed`.
    - `failed`: the commands ran and one exited non-zero with ordinary output. The run fails with exit `1`, as before; `verification` is `failed`.
    - `could_not_run`: no verdict was produced. It is a warning, not a failure: the run finishes with exit `0` and lands as usual, so the work is merged but not verified as a whole. It applies when the setup failed (`its setup failed (exit <n>)`), when a command was not found or could not be executed (exit `127` or `126`), when a command could not be started, when its output carries one of the tool-missing markers in `src/engine/verify-markers.ts` (for example `This is not the tsc command you are looking for`, the stub package `npx` fetches when `tsc` is not installed), or when the command timed out. `verification` is `not_run` and `verification_note` gives the reason. Output that matches no marker, such as `Cannot find module` for a missing project module, is a failure.
  - **Bisect (R9.1).** Only a `failed` verdict bisects. It names a culprit only when bisect can isolate one: a task whose merge alone turns a passing set of merged tasks into a failing one, with the base as the anchor. A set of merged tasks is not tested while a task outside it depends on one of its tasks, because its failure may only be the absent dependent's (a test-first plan is red until its implementer merges). Otherwise the run fails with `integration_failed: <command> exited <n>` and the output tail, and names no task.
- **Internal errors (R9.1).** An unexpected exception in the engine ends the run as failed, with exit `1`. The summary prints the normal failed-run lines, `Reason: internal error: <message>` and `Next: This is a Substrate bug; the run directory keeps the event log: .substrate/runs/<id>/`. The stack trace goes to `error.txt` in the run directory, not to stdout. The event log ends with a `run.finished` event that carries `failure_class: internal_error` and the message. Worktrees and task branches are swept, and the work of tasks that did not merge is kept under `packets/`. `--output-format json` carries the same `failure_class` and `message`.
- **Failures**: in text mode each failed task prints one stdout line, `[task <id>] failed: <failure_class>: <message>`. A planner failure has no task id, so its line reads `[task ] failed: ...`. The message is one line of at most 2000 characters. A crashed planner session names its exit code and the harness's own error, and a plan that never validates lists its diagnostics. The `failure_class` is unchanged. Json output carries the same message on the `task.failed` event in `events`.

```bash
substrate run --plan claude:opus:high --work claude:sonnet:medium --request - --output-format json < request.json
substrate run --mode solo --work claude:sonnet --verify "npm test" "add a retry to the client"
substrate run --plan claude:opus:high --work claude:sonnet:medium "rename the config key"
```

## plan

```text
substrate plan [options] [prompt]
```

Runs the planner only. It forces `--mode plan` and `plan` permissions, so it writes a plan and stops before any worker runs. **Planned (R10.5).** A plan-only run ends `planned` with exit `0`: `Status: planned`, the task list with `N planned` tasks, `Merged: no`, and a `Next:` line that says to review or edit the plan in `.substrate/runs/<id>/` (manifest.yaml and the task specs), then run `substrate resume <id> --work <provider:model[:effort]>`. No worker runs, and no task reports a result. `run --review` is the same path with `--work` required, and it records the worker, so a bare `substrate resume <id>` runs the plan. `status`, `runs` and `watch` show the run as `planned`. It accepts the same prompt, `--request`, `--plan`, `--work`, `--model`, `--effort`, `--max-budget-usd` and `--timeout` options as `run`. `--detach` is not supported for `plan` and exits `2` with `--detach is not supported for plan; use substrate run --detach` (R10.3). Without a prompt or request it exits 2 with `prompt required`. It needs only a planner model (`--plan <provider>:<model>`, or `planner.model` in the request) and the same git repository rule as `run`.

```bash
substrate plan --plan claude:opus:high "rename the config key"
```

## resume

```text
substrate resume [options] <run-id | session-id>
```

- With a target, resumes that run. With a session id, resumes the session's latest run. `--session-id` or `--resume` can name the target instead of a positional argument.
- A run whose event log says it has finished prints `Run <id> is already finished. Nothing to resume.` and exits 0.
- **Any run that did not finish is resumed (R10.4; known issue 41 reversed).** In text mode, a resume of a run that is not running prints that run's report before it continues (P2.2). A run that ended failed, a paused, interrupted or budget-stopped run, and a run stopped uncleanly are all continued. The plan is not recreated. The tasks that passed or merged stay. The failed tasks retry as a new generation with a fresh attempt counter and a fresh replan ladder, on a new worktree and branch made from the run branch's current HEAD (so a task dropped for a merge conflict builds on its merged siblings). Their dependents that were skipped return to the queue. The run's spend so far counts against its budget. The progress names the reopening: `resuming failed run <id>: retrying T2; keeping T1 (passed)` and `skipped dependents return to the queue: T3`. When every task merged and integration verify failed, resume runs only the verify again; a human who fixes the run branch (`git switch substrate/runs/<id>` in a worktree, commit, then resume) gets it landed. A run that failed in planning plans again and prints `no plan was accepted; planning again (planning costs again)`. A failed run's work never lands in the user's branch unless the run finishes.
- A run whose event log says it has finished and is not merged prints `Run <id> is already finished. Nothing to resume.` and `not merged yet: substrate merge <id>`, and exits 0.
- A run paused with questions needs answers. `--answers <file|->` reads a JSON object `{"answers":[{"id":"Q1","text":"..."}]}` from a file or stdin. A question left out takes its `default`. A question with no default and no answer exits 2. An answer for an unknown question id exits 2. `--answers` on a run with no pending questions exits 2.
- **Detach (R10.3).** `resume --detach` continues the run in the background, with the same output and exit behaviour as `run --detach`.
- **Landing and workers (R10.3).** A resume keeps the landing its run recorded on `run.created` (`merge`): a run made with `--no-merge` stays on its branch when resumed without flags, and `--merge` on the resume lands it. It also keeps the worker count recorded as `concurrency`, unless `--concurrency` is given again. A run recorded before these fields (an older log) uses the project setting for both.
- `--fork-session` with a session target forks the session first.
- Exit codes follow the run exit codes above.
- **Models (R8.2, known issue 18).** The run records the models the caller named (`roles.requested`) on its `run.created` event. A resume uses them. Naming a role again replaces it for the rest of the run: `--plan` or `--model` for the planner, `--work` or `--worker-model` for the workers (`--work claude:opus` takes the form `provider[:model[:effort]]`). Settings files do not change a recorded model.
- **Recorded inputs (R11.1).** A resume rebuilds nothing from its own options except what the caller gives again. The run's request text (`run.created` `prompt`) is what the planner is given when planning runs again after a stop or a failed planning, and what a solo worker is given. The mode, the permission mode, the verify and context lists, the `permissions` allow and deny lists, the sandbox setting and the history flag (`--history-all`) come from `run.created` too. The run budget comes from `run.created` as `max_budget_usd` (the `--max-budget-usd` or request value, else the project setting when the run started) and from the latest `run.resumed` or `run.reopened` that recorded a replacement. A resume without `--max-budget-usd` keeps the recorded budget; with it, the new value replaces the recorded one and is recorded on the resume's event. **Time limit (R11.2).** The time limit is recorded the same way: `run.created`, `run.resumed` and `run.reopened` carry `time_limit_s` (seconds, or `null` when no limit is set). A resume without `--timeout` keeps the recorded limit; `--timeout` given again replaces it and is recorded on the resume's event. A resume starts a fresh clock: the limit counts from the resume's own process, not from the run's first start. A run recorded with no limit takes the project setting when it resumes.
- **Planning again (R11.3).** A resume that plans again prints `planning was cut short before a plan was produced; planning again (planning costs again)` when planning stopped, timed out or failed before any plan existed. It prints `no plan was accepted; planning again (planning costs again)` when a plan was produced and refused. Either way the planner gets the run's request text again.
- **Stale workers (R8.2).** Each worker session is recorded under `.substrate/runs/<id>/workers/` while it runs. A resume ends any recorded worker still alive whose command line names its harness, before it continues, so a CLI killed with SIGKILL leaves no harness process behind.

```bash
substrate resume r_ABC123DEF456
substrate resume <run_id> --answers answers.json
```

## status

```text
substrate status [--output-format json] [run-id]
```

Shows a run's state, its tasks and any pause reason. The text status word (`paused: stopped by you` for a user stop, `paused: budget`, `paused: needs your answers`, `stopped (process gone)`, and so on) is the same one `substrate runs` prints (R11.3). Without a run id it uses the most recent run in `.substrate/runs/`. With no runs it exits 2 with `No run found to display status`. It never takes the run lock and never writes, so it works while the run is live, paused, failed or finished.

The text starts with a live header, then the `=== Run Status ===` block, which keeps only the pending questions and the task table (R11.1). Each fact is printed once: the run id, the state with its reason, the task counts and the cost are in the header, and the resume command is named once, in `Next:` (`Process:` reads `none (paused)`, `none (planned)` or `not running (stopped)`, or `none (the run has ended)` for an ended run; the `Outcome:` line appears only when `summary.txt` or `result.json` exist). Costs have four decimals; the budget shows two. With a time limit the Phase line also shows `Time limit: <n>s (elapsed <m>s)`, where `elapsed` counts from the run's latest start or resume (R11.2); the JSON has `time_limit_s` (`null` when no limit is set).

```text
Run r_BHS2PJJ53GQG  stopped (process gone)   elapsed 00:03   request: make a snake game
Planner claude:claude-sonnet-5-5   Worker claude:haiku   merge: on
Phase:  finishing     last activity 3s ago     Cost $0.0000 (budget: none)
Process: not running (stopped)
Tasks: 0 passed, 1 running, 0 failed, 0 waiting
  SOLO                                 running  gen 1  attempt 1  3s
Log:   .substrate/runs/r_BHS2PJJ53GQG/progress.log
Next:  substrate resume r_BHS2PJJ53GQG
```

- the status word, with its reason (R11.1): `running` (the process holds the lock), `stopped (process gone)` (no terminal event and no live process), `planned` (a plan-only run, ready for review: resume it to run the plan), `finished`, `failed`, `cancelled`, `paused: budget`, `paused: needs your answers`, `paused: stopped by you (user_cancel)` (a stop or Ctrl+C), or `paused: <reason>` for other pauses. The JSON `status` field keeps its own values (`paused`, `interrupted`, `stopped`, ...).
- `Phase:` is the phase the run's progress lines name (`running T1, T3` while two workers run), `paused` for a paused run, `planned` for a planned one, and `ended` once the run is over; `last activity` is the age of its newest event
- `Process:` is `pid <n> alive` for a live process, `none (paused; resume with: substrate resume <id>)` for a paused run, `none (planned; resume with: ...)` for a planned one, `not running (stopped; resume with: ...)` for a stopped run, and `none (the run has ended)` for a finished or failed one
- one row per task: id, title, state (`passed`, `running`, `failed`, `waiting` or `skipped`), generation, attempt, cost, `merged`, or the failure class, or `after <deps>`
- `Next:` is the command a caller runs next: `substrate watch <id>` while running, `substrate resume <id>` when stopped or paused, `substrate merge <id>` for a finished run that is not merged
- a run that has ended names its `summary.txt` and `result.json` on an `Outcome:` line
- a run that is not running and did not finish (stopped, paused, interrupted or failed) prints the run report, the same text the end of the run prints (P2.2). Its `Next:` line is the report's, so the resume command is named once. A run killed hard (no end recorded) shows `stopped uncleanly` in its verdict, with what exists and the resume command

The `State:` line of the older block is the run's state as the journal ends: a run that finished or failed reads `FINISHED` or `FAILED` (it read `EXECUTING` before R10.2, because the reader ignored `run.finished`).

`--output-format json` keeps every field it had and adds: `status`, `phase`, `elapsed_s`, `last_event_ts`, `cost_usd`, `budget_usd` (null when no budget is set), `process` (`{pid, alive}`, or null), `request` (the first 200 characters of the prompt), `planner` and `worker` (`harness:model`), `task_list` (one object per task: `id`, `title`, `class`, `state`, `depends_on`, `generation`, `attempt`, `cost_usd`, `started_at`, `merged`), `counts` (`passed`, `running`, `failed`, `waiting`, `skipped`), `log`, `next` (command strings), and, for a run that has ended, `summary` and `result` (the file paths, or null). The existing `tasks` object is unchanged; the task rows are `task_list`.

For a poll, call `substrate status <id> --output-format json` and read `status`, `phase` and `counts`; when `status` is `finished`, `failed`, `paused`, or `interrupted`, read `result.json` in the run directory.

## tasks

```text
substrate tasks [run-id]
```

Prints a table of the run's tasks. Without a run id it uses the most recent run directory whose name starts with `r_`. It has no JSON output and no task filter. Use `status` or `report` for more detail.

## report

```text
substrate report <run-id>
```

Prints a text diagnostic for a run: goal, duration, a table of tasks (state, generation, attempts, failure), tokens in and out, cost, files changed and verify outcomes. A missing run id exits 2 with `Run ID required`. An unknown run exits 2. `--output-format` is accepted and ignored. Reports are text only.

## verify

```text
substrate verify <task-id> [--run <run-id>] [--timeout <seconds>] [--sandbox]
```

Re-runs a task's verify commands in its worktree, `.substrate/worktrees/<run-id>/<task-id>`. With no `--run`, it searches the worktrees for the task. Each command prints `[verify] <cmd> -> exit <n>`. Exit `0` when every command passes, `1` when any fails, `2` for a missing task id or a missing worktree. `--timeout` overrides every command's timeout. `--sandbox` runs the commands in the sandbox.

## merge

```text
substrate merge [--dry-run] [--abort-on-conflict] [run-id]
```

Merges a finished run branch into the current branch. A missing run id exits 2 with `Run ID required`, and an unknown run exits 2 with `Error: unknown run <id>`. A finished run lands by default (R10.1), so this command is for a run kept on its branch by `--no-merge` or refused at landing. The merge is refused, exit 1, when the run did not finish successfully, when tracked files have uncommitted changes, or when a preflight check finds a conflict; the conflicting files are listed on stderr. `--abort-on-conflict` takes the abort path on a conflict. `--dry-run` runs the checks without merging.
`--partial` (R8.2) lands the passed tasks of a failed run on purpose. It needs a run that failed and has at least one task merged into its run branch, else it exits 1. It runs the plan's `integration_verify` commands on the run branch in a throwaway worktree first (removed afterwards); only when they all pass does the run branch merge into the checked-out branch. Otherwise it exits 1 with `not merged: integration verify failed on the run branch: <command> ...` and the output's last line on stderr, and nothing changes. The setup runs first, in the throwaway worktree (R12.2). A check that could not run (see Integration verify) is a warning on stderr, `warning: integration verify could not run (...)`, and the passed tasks land as the verify had passed. The uncommitted-changes and conflict refusals are the same as for a finished run. A failed run's summary names `substrate merge <run> --partial` in `next` when it has a passed task.

## undo

```text
substrate undo [--hard] [run-id]
```

Moves the run branch back to the checkpoint before its most recent merged batch. Without a run id it uses the most recent run that has a checkpoint. With none it exits 1 with `no checkpoint recorded for run`. It refuses to run while the run branch is checked out, and it exits 1 in that case. `--hard` also resets the run's integration worktree to the checkpoint, if that worktree exists.

## discard

```text
substrate discard [--force] [run-id]
```

Removes a run's worktrees and deletes its run branch. If a run process is still alive, the command exits 1 unless `--force` is given. With `--force` it sends the process SIGTERM first. A missing run id exits 2.

## models

```text
substrate models [--provider <name>] [--refresh] [--output-format json]
substrate models --stats [--since 7d|YYYY-MM-DD] [--output-format json]
```

- Lists each installed provider (`claude`, `opencode`, `agy`), its version and pin status, and its models with the efforts they accept, their price per million tokens and the profile slots that use them. Models with no known price show `unpriced`. A `== all models ==` table follows.
- `--provider <name>` limits the listing to one provider. An unknown provider exits 2.
- `--refresh` queries the providers again and rewrites the cache in `.substrate/state/models.json`. Without it a fresh cache is reused.
- `--stats` prints per-model task statistics for each provider: tasks, first-pass rate, heal rate, replans, average input and output tokens, and cost per passed task. `--since` limits the statistics to recent runs. It takes `7d` (days back) or a `YYYY-MM-DD` date. A cost shows `unknown` when a price is missing.
- `--output-format json` prints the catalog as one JSON object, or the statistics as `{"since":...,"stats":[...]}` with `--stats`.

```bash
substrate models
substrate models --provider claude --output-format json
substrate models --stats --since 30d
```

## usage

```text
substrate usage [--by model|provider|role|run|task|class|day] [--since 7d|YYYY-MM-DD]
                [--provider <name>] [--model <id>] [--run <run-id>] [--cache]
                [--all-projects] [--rebuild] [--output-format json] [run-id]
```

`cost` is an alias of `usage` with the same behaviour and options.

- Reads the usage ledger (`.substrate/ledger/usage.jsonl`). It sums the recorded tokens and cost and never recomputes a price.
- `--by` groups rows. The default is `model`. Any other value exits 2 with `invalid --by`.
- `--since` keeps only entries on or after the date. Any other form exits 2 with `invalid --since`.
- `--provider`, `--model` and `--run` filter entries. A positional run id is the same as `--run`.
- `--cache` adds cache read, cache write and reasoning token columns.
- A cost that Substrate cannot price is shown as `$x.xxxx (+ n unknown)`. The tokens of those calls are still counted.
- `--all-projects` reads the global mirror of the ledger (`usage.global`). Without a mirror it prints `no global mirror` and exits 0.
- `--rebuild` rebuilds the ledger from each run's recorded events before reporting, and prints `rebuilt <n> line(s) from <m> run(s)`.
- With no entries, text output prints `no usage recorded` and exits 0. JSON output has the same shape with empty `rows`.
- `--output-format json` prints `{"by","since","filters","rows","totals"}`. Each row has `group`, `runs`, `calls`, `input_tokens`, `output_tokens`, `cost_usd` and `unknown_cost_rows`.

```bash
substrate usage --by model
substrate usage --by day --since 30d --cache
substrate cost --by task --since 7d --output-format json
```

## agents

```text
substrate agents
substrate agents import --from claude|opencode
```

- `agents` prints one line per role that has a prompt file (the built-in set is in `assets/agents/`): the role, where its prompt came from (`project`, `user` or `built-in`) and the file path. A project file at `.substrate/agents/<role>.md` overrides the user and built-in files for that role.
- `agents import --from <claude|opencode>` converts definitions from `.claude/agents` or `.opencode/agents` in the project into `.substrate/agents/`. An agent whose name already exists in `.substrate/agents/` is skipped, never overwritten. It prints `Imported` and `Skipped` lists. A missing source directory exits 2. Other errors exit 1.
- `agents import` has no path, overwrite or directory options. Passing one is rejected with `Unknown option`, exit 2. `--dry-run` is accepted and does nothing.
- The source directory is fixed: `.claude/agents` for `claude`, `.opencode/agents` for `opencode`. The target is fixed: `.substrate/agents`.

## backends

```text
substrate backends [--output-format json]
```

Prints each adapter's version pin, installed version and status, and the capabilities of each harness (`claude`, `opencode`, `agy`).

## sessions

```text
substrate sessions [--output-format json]
```

Lists recorded sessions with their id, creation time, mode, run count and latest prompt, from `.substrate/sessions/`. The command has no way to limit the number of rows. Text output prints a header and one line per session. JSON output prints `{"sessions":[...]}`.

## config

```text
substrate config list
substrate config get <key>
substrate config set <key> <value> [--local]
```

- `list` prints the merged configuration as JSON: indented in text mode, one compact line with `--output-format json`.
- `get` prints one value by dotted key path. A key that is not in the settings schema exits 2 with `unknown settings key: <key>` on stderr, with a hint, or with a one-line `{"error":...}` object on stdout in json mode. Wildcard maps (`pricing.models.<id>.*`, `routing.<class>.*`, `profiles.<name>.*`) accept any name in their place. A known key with no value in any file prints `undefined` and exits 0. In json mode the value is always valid JSON: a string prints quoted (`"claude"`), and an unset key prints `null`. If the settings files fail to load, `list` and `get` exit 2, with the error on stderr in text mode or as a one-line `{"error":...}` object on stdout in json mode.
- `set` writes the value into `.substrate/settings.json`. With `--local` it writes `.substrate/settings.local.json` instead. It prints `Set <key> = <value>`. Before it writes, it applies the same checks as the loader to the merged result. If the result would not load, `set` exits 2 with `Invalid setting <key>: ...` on stderr and writes nothing. The provider key `backends.opencode.provider` is local-only: without `--local` the refusal names the key and hints at `--local`.
- A bad operation exits 2 (`Unknown config operation`). `set` with missing arguments exits 2 with its usage line.

```bash
substrate config get budgets.run.max_usd
substrate config set concurrency.workers 4
```

## doctor

```text
substrate doctor [--output-format json]
```

Checks what a run depends on and prints one line per check, with a `fix:` line under each one that is not a pass:

- Node.js version (`>= 22`) and git version (`>= 2.30`).
- Each provider's installed version against its pin. A mismatch is `FAIL`.
- Whether `settings.json` loads.
- Profile entries: each profile model must appear in its provider's model list.
- bubblewrap, reported as `WARN` when missing. The sandbox is off by default.
- A provider that is not installed is `FAIL` when a profile or default names it, and `WARN` otherwise.

`--output-format json` prints the node, git, bubblewrap and adapter versions and a `checks` array. Exit `0` when no check is `FAIL`, `1` otherwise.

## init

```text
substrate init [--force]
substrate init --provider <claude|opencode|agy> --plan <model[:effort]> --work <model[:effort]> [--fast <model[:effort]>]
```

- Creates the runtime directories under `.substrate/`: `runs`, `worktrees`, `state`, `sessions`, `ledger` and `archive`.
- Writes `.substrate/.gitignore`, which ignores `runs/`, `worktrees/`, `state/`, `sessions/`, `ledger/` and `settings.local.json`.
- Writes the charter stub `.substrate/charter.md` when it is absent. An existing charter is never overwritten, even with `--force`.
- Without slot flags, it prints the installed providers and the model ids each one reports. It writes nothing else.
- With slot flags, it writes the profile into `.substrate/settings.json`: `profiles.<provider>.plan`, `.work` and `.fast`, and the `defaults` for that provider. `--provider` is required with any slot flag, and `--plan` and `--work` must come together. A model id that the provider does not list exits 2 with the valid ids. An effort must be one of `low`, `medium`, `high`, `xhigh` or `max`.
- An existing `settings.json` or `.gitignore` is kept and reported as `kept <path>`. `--force` overwrites them.

```bash
substrate init --provider claude --plan opus:high --work sonnet:medium
```

## charter

```text
substrate charter show
substrate charter set <file|->
substrate charter bump <version>
```

- `show` prints `.substrate/charter.md`. It exits 2 when there is no charter.
- `set` replaces the charter body from a file, or from stdin with `-`. Empty content exits 2 (`charter content cannot be empty`). A missing file exits 2.
- `bump` sets the project version. The version must match `^v\d+$`, otherwise it exits 2. It keeps the charter text, writes the version into the charter frontmatter, and creates `.substrate/archive/<version>/` with an `INDEX.md` when that does not exist yet.

## history

```text
substrate history [--all-versions] [--output-format json]
```

Lists archived runs for the current charter version, or for every version with `--all-versions`. Text output prints one line per run: `<run_id> | <status> | <goal> | <ended_at>`. With no archived runs it prints `no archived runs` and exits 0. JSON output prints `{"versions":[...]}`.

## archive

```text
substrate archive <run-id>
```

Writes a finished, failed or cancelled run into `.substrate/archive/<version>/<run-id>/` and adds it to the version's `INDEX.md`. A run still in progress exits 1 (`run <id> is not terminal`). An unknown run exits 2.

## gc

```text
substrate gc [--older-than <duration>]
```

Deletes the raw data directory `.substrate/runs/<run-id>/` for runs that already have an archive record, when that archive's `summary.md` is older than the threshold. The default threshold is `30d`. An invalid duration exits 2. It prints `removed <n> run(s)`. It never deletes an unarchived run, a worktree or a branch.

## bench

```text
substrate bench [task-glob ...]
```

Runs the benchmark suite in `bench/` against the task files that match the globs, relative to the current directory. With no glob it uses `bench/tasks/**`.

- For each task and each arm it copies the task's fixture into a temporary directory, runs its setup and verify commands there, and removes the directory. No model is called.
- The cost of each attempt is a constant per arm: A `0.5`, B `0.1`, C `0.3` and D `0.01` USD. The printed costs and rates therefore are not measurements.
- Only the task globs reach the command. `--dry-run` is not passed through, so it does not prevent the attempts. The other bench options (`--arms`, `--repetitions`, `--format`, `--output`, `--max-budget`, `--concurrency`, `--tasks`, `--top-model`, `--cheap-model`, `--local-model`) are dropped by the dispatcher. A value after one of them is read as a task glob, which fails with `No benchmark tasks found matching pattern(s)`.
- Exit `0` on success, `1` on error.

## Interrupt and resume (R8.2)

- **Ctrl+C (SIGINT) or SIGTERM** stops the run promptly (under 5 seconds with a hung harness). The harness processes of the run's workers are killed with their process groups. The run is `paused` with reason `user_cancel`, and its summary ends with `Interrupted. Resume with: substrate resume <run-id>`.
- **Exit codes.** SIGINT exits `130` and SIGTERM exits `143`. A second signal forces the exit at once. The summary of an interrupted run says `Status: paused` and `Exit Code:` with the signal's code.
- **The checkout is untouched.** An interrupted run merges nothing and leaves your checkout as it was. Its task worktrees stay on disk, because resume needs them.
- **Resume** continues the run: tasks that passed are not run again, and the models of the run are used (see resume).
- **substrate stop** (from any terminal) sends SIGTERM to the run's process and waits up to 15 s. It takes this same graceful path, so a run started in another terminal stops the same way; resume it afterwards. See [stop](#stop).
- **SIGKILL** (no chance to clean up) writes no `run.paused` event and can leave a harness process behind. The next `substrate resume` ends the recorded process before it continues; a run lock left by the killed CLI does not block the resume.

## Time limit stop (R11.2)

Only when a time limit is set (`--timeout`, `budgets.run.max_wall_min`; none by default). A run whose process reaches its `--timeout` limit (or the `budgets.run.max_wall_min` setting) stops the way a budget stop does: the in-flight worker or planner is killed with its process group, nothing new starts and nothing merges after the stop, and the task worktrees and branches are kept for the resume. The run is paused with reason `timeout` and exits `4`. The summary's `Reason:` reads `timeout: the run reached its <n>s time limit; <task> passed, <task> interrupted, <task> not started`, and `Next:` reads `substrate resume <run> --timeout <n>` with `<n>` twice the limit. A run stopped during planning has no plan yet, so the resume plans again with the request kept.

## Budget stop and refused landings (R8.2)

- **Budget stop.** Only when a run budget is set (`--max-budget-usd`, `budgets.run.max_usd`; none by default, so a run with no budget is never stopped for its cost). A run that spends its run budget stops with exit `4` and `Status: paused`. The worker in flight is killed, as the run budget's kill always is (R1.4), and its unverified work is not kept; a task that passed before the stop is merged on the run branch. The summary's `Reason:` reads `budget_exhausted: spent $<spent> of the $<budget> run budget; <task> passed, <task> interrupted, <task> not started`, and `Next:` reads `substrate resume <run> --max-budget-usd <n>` with `<n>` above the spend. The resume uses the new budget; the spend already recorded counts against it. A paused run keeps its task worktrees and branches for the resume.
- **Landing (R10.1).** A run lands into the checked-out branch when it ends `finished` with every task passed and integration verify passed, unless `--no-merge`, the request's `merge: false` or `git.auto_merge: false` turns it off. A failed, partial, paused, interrupted or budget-stopped run never lands, and `substrate plan` never lands. A run lands only into the branch it started on: if you switched branches while it worked, it is not merged and the summary says `not merged: you switched from <X> to <Y> while the run was working; check out <X> and run: substrate merge <run>`. A conflict with your branch is refused the same way, naming the files, with no merge state left behind.
- **Refused landing.** A run that passed and was asked to merge (by default, `--merge`, the request's `merge` field or `git.auto_merge`) while your checkout has uncommitted changes to tracked files is still `Status: finished`, with `Merged: no`, `Exit Code: 1` (the merge command's refusal code) and this line in `Result:`: `not merged: your working tree has uncommitted changes; commit or stash them, then run: substrate merge <run>`. Nothing is lost: the run branch keeps the work, and `substrate merge <run>` lands it once the checkout is clean. In json the same sentence is `not_merged_reason`.
- **Progress.** A task that fails for good prints one `[task <id>] failed: <class>: <reason>` line. Its failed attempts print nothing extra; the replan ladder prints its own lines.

## Run report (P2.2)

Every run that does not finish with exit `0` says what happened. The report is built from the run's event log and the files it left (its packets, its run branch and commits). The text, the json `report` field and `REPORT.md` are all rendered from the same object, so they agree.

- **Where it appears.** The end of a `run` or `resume` in text mode (see the summary above); the `report` object of `--output-format json` and of the `result.json` file; `REPORT.md` in the run directory, written at every end (finished, failed, paused, interrupted, stopped, internal error), including an end that came from an exception; and `substrate status <id>` and `substrate resume <id>` for a run that is not running.
- **Outcome.** `finished`, `failed`, `paused`, `interrupted` (you stopped it with Ctrl-C or `substrate stop`), `internal_error`, `stopped_uncleanly` (the process is gone and the log has no end), or `planned`.
- **Tasks.** Each task has a state (`passed`, `failed`, `skipped`, `interrupted` or `not_started`), its generation, the fixes the worker made, the replans the ladder ran, its changed files, its failure in plain words (for example `a verify command failed`), the verify command that failed and the last ten lines of its output, and its saved patch.
- **Produced.** The run branch and the commits above its base, the saved patches (`packets/<task>-g<n>.patch`) and the run directory.
- **Recovery.** The engine's own attempts (fixes, L1 and L2 replans, repair attempts) and the one sentence that says why it stopped trying, for example `the replan budget ran out`, `the final check could not run` or `merge conflict with T3`.
- **Next.** The exact commands that apply: `substrate resume <id>`, `substrate merge <id> --partial` (only when a task passed, its plan has `integration_verify`, and the run failed), `git diff <base>..<run branch>`, `git apply <patch>`, and `substrate status <id>`.
- **Failure classes.** Each failure class has a plain-words sentence. A class the table does not name is shown as its raw class and message.

## Failed and partial runs (R8.1)

- **Independent tasks keep going.** A failed task does not stop its siblings. Each dependent of a failed task is skipped: its event is `task.skipped` with `reason: dependency_failed`, `failed` (the direct dependencies that failed) and `skipped`, and its progress line reads `[task T3] skipped (depends on T2, which failed)`.
- **The summary counts every outcome.** `Tasks:` reads `N passed, M failed, K skipped / T total`, the failed-task count and the skipped count appear only when they are not zero. The run report's first line says what was not merged, with the counts (`Nothing was merged. 1 of 3 tasks finished; T2 failed ...; 1 skipped`), and the passed work stays on the run branch. With the merge flag nothing lands from a run that did not finish with exit `0`. (P2.2 replaced the older `NOT merged: <n> of <t> tasks failed or were skipped` line, which could contradict the task counts.)
- **The run ends failed, with its reason.** Once nothing can run, `run.finished` carries `exit_code: 1`, `reason: tasks_failed` and `failed_tasks` (the ids of the failed tasks). `Reason:` names the failure of the task that failed last, for example `integration_failed: <command> exited <n>` or `worker_crashed: ...`.
- **Merge conflicts drop the task.** The conflicting task fails with `merge_conflict` and `can_replan: false`; its detail names the tasks it collided with. The tasks merged before it stay on the run branch.
- **Cleanup.** A run that finishes (`FINISHED` or `FAILED`) removes its task worktrees, its integration worktree and every task branch `substrate/tasks/<run>/*`. The run branch `substrate/runs/<run>` is kept. A paused run keeps them, because resume needs them.
- **Evidence.** The work of each task that did not merge is kept under the run directory: `.substrate/runs/<run>/packets/<task>-g<n>.patch` (what the task changed) and the attempt reports `packets/<task>-g<n>-attempt<k>.json` (the verify results of each attempt, with the output of the last one), plus the failure packet `packets/<task>-g<n>.json` when the ladder ran.
- **The checkout stays clean.** `.substrate/` is added to the repository's `.git/info/exclude` at run start, so `git status` in your checkout never shows it. A run that does not land (`--no-merge`, or a refused landing) changes nothing in your checkout outside `.substrate/`.
- **A dirty checkout does not stop the run (R8.2).** Batches merge into the run branch through the integration worktree and never touch your checkout, so uncommitted changes there do not fail a task or the run. The checkout is checked where the work lands: `substrate merge` and the run's merge flag refuse tracked uncommitted changes with exit `1` and leave the run branch intact (see Budget stop and refused landings).


## Automatic repair of a failed integration check (R12.4)

When the run's final `integration_verify` fails for a real reason (its commands ran and one exited non-zero), Substrate repairs the code before it judges the run. A repair is not made for a check that could not run (that stays a warning, R12.2), for a one-task plan (its own checks ran in its worktree, and the check is not run again), or when `integration.repair_attempts` is `0`. Those cases behave as before.

- **Attempts.** Up to `integration.repair_attempts` attempts (default `2`, from `0` to `5`, see [config.md](config.md)). Each attempt is one repair worker, in a new worktree off the current integration HEAD, set up with the plan's `setup`. The worker gets the request, the check command, the last 60 lines of the check's output, the tasks that merged, and on attempt 2 the outcome of attempt 1. It runs as the `debug` task class and is routed like any worker: attempt 2 takes the ladder's escalation.
- **Acceptance.** An attempt passes only when it commits a change, the anti-cheat guard accepts it (below), and the check passes in the repair worktree. The repair is then merged into the integration branch and the run branch advances to it, and the final check runs again on the merged result. A passing re-run finishes the run as if the check had passed first time (merge per `git.auto_merge`, exit `0`). The summary says `Repaired:   integration check passed after <n> repair attempt(s)` and the json carries `repaired: <n>`.
- **Exhaustion.** After the last attempt the run fails as it does for any failed check: `Reason:` and `Output:` show the last re-run, the branch is kept, and the summary adds `Repair: <n> attempts, none passed (<reason of the last attempt>)` with one line per attempt (`attempt <n>: passed`, or `attempt <n>: rejected: <reason>`). The json carries the same facts as `repair` (`attempts`, `passed`, `reason`, `outcomes`). Exit `1`. The culprit search (R9.1) runs only now. A repair that was merged and failed the re-run stays on the run branch, as a merged task's work does.
- **CHECK-UNFIXABLE.** A worker whose final line is `CHECK-UNFIXABLE: <reason>` says the check cannot be fixed by editing code in this repository (for example a tool that is not installed). No further attempt runs, and the reason is recorded.
- **What a repair may not do.** The attempt is rejected, the rejection counts as a failed attempt, and the reason is recorded, when its commit:
  - changes nothing;
  - deletes a test file, or renames one away. A test file is anything under `test/`, `tests/`, `__tests__/` or `spec/`, or named `*.test.*`, `*.spec.*`, `*_test.*` or `test_*`;
  - adds a skip or ignore marker: `.skip(`, `xit(`, `xdescribe(`, `it.todo`, `test.todo`, `@Ignore`, `@Disabled`, `pytest.mark.skip`, `pytest.skip(`, `t.Skip(`, `#[ignore]`, `skipIf` or `unittest.skip`. `.only(` is not a skip;
  - touches anything under `.substrate/`, which holds the run's records and the manifest.
  The table is in `src/engine/repair-guard.ts`. A repair also may not edit the check or what it tests, and the prompt says so (`assets/prompts/worker/repair.md`), but only the rules above are enforced.
- **Known limit.** The guard reads what the commit changed. A worker could still change a script that the check runs (for example the body of a script that `npm run verify` calls) so that it passes. Substrate does not detect that; review the merged change.
- **Limits and stops.** A repair worker is a worker: a set run budget, the `--timeout` time limit and `substrate stop` apply to it as they do to a task, and an interrupt (exit `130`) stops it. A repair never pauses the run for answers.
- **Resume.** A run that is resumed after a failed or interrupted check gets a fresh set of attempts. Each attempt's worktree and branch are named by the round of the check (`REPAIR-<n>` in the round's worktree directory).
- **Progress and status.** The progress lines are `integration check failed; repairing (attempt <n> of <max>)`, `repair attempt <n> rejected: <reason>` for a rejected attempt, and `integration verify passed after repair` when the check passes. `substrate status` lists each attempt as a `REPAIR-<n>` row with the usual words (running, passed, failed).
- **Turn it off.** Set `integration.repair_attempts` to `0` in the project settings (`.substrate/settings.json`) or the user settings. A run then fails on the first failed final check, as it did before R12.4.
