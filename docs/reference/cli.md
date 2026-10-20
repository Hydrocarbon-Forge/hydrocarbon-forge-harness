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
| `0` | success |
| `1` | run failed |
| `2` | usage/config error |
| `3` | needs human (approval at Substrate's permission gate, or escalation L3). Exit `3` for approval depends on the gate, not on a harness denial |
| `4` | budget exhausted |
| `130` | SIGINT (Ctrl+C) |
| `143` | SIGTERM |

For a run, the engine maps its state to a code: finished is `0`; failed or cancelled is `1`; paused for budget is `4`; paused for a user cancel is `130`; any other pause, including a run paused for answers to `QUESTIONS.md`, is `3`. Commands that are not runs use `0`, `1` and `2` as their entries describe.

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
| `--no-governor` | all | deprecated no-op. The governor was deleted on 2026-10-20; the flag is still accepted and ignored so existing callers do not break |

## Progress output

`run`, `plan` and `resume` report what they are doing while they work, so a caller does not need to poll `status` or read event files. `--output-format` (or `SUBSTRATE_OUTPUT_FORMAT`) picks the form.

- **`text` (default).** Progress lines and the summary block go to stdout, in order, so one stream carries the whole run. Errors and warnings go to stderr. Every progress line starts with `[mm:ss]`, the time since the run started. Lines written:
  - `run <id> started: mode <mode>, planner <harness:model>, worker <harness:model>` (a `solo` run has no planner)
  - `routed to plan (<rationale>)` or `routed to solo (<rationale>)`
  - `planning with <harness:model>`, then `planner attempt <k> finished, $<cost>` for each planner attempt
  - `plan rejected (attempt <k>/<max>): <first two messages>` when the engine refuses a planner output, and the retry that follows. Lint messages carry their ids, such as `[L003]`.
  - `plan ready: <n> tasks`, then one indented line per task: id, title, `[class]`, and `after <deps>` when the task has dependencies
  - per task: `[task <id>] started (gen <g>, attempt <a>) on <harness:model>`, `worker finished, $<cost>`, `verify passed` or `verify failed: <command>: <one line of output>`, `merged, $<cost>`, and `failed: <failure_class>: <message>` (a planner failure has no task id, so its line reads `[task ] failed: ...`)
  - `integration verify started`, `integration verify passed` or `failed`, `budget warning: ...`, `run paused: <reason>`
  - `run <id> <status>: <passed>/<total> passed, $<cost>`, then the summary block

  The summary block keeps its existing lines and adds `Merged:` (`yes` when a task reached the run branch, `no` otherwise, `pending (git.auto_merge)` when the run is merged after the summary). A run that did not finish with exit `0` also prints `Drafts and logs: .substrate/runs/<id>/` (relative to the project directory) and `Next: substrate resume <id>`. A run paused for answers prints its own resume line instead.

- **Heartbeat.** When no progress line has been written for 15 seconds, the run writes `[mm:ss] still working: <phase> (<s>s, $<cost>)`, and again every 15 seconds until the next progress line. The phase is `planning`, `setup`, `task <id> running`, `verifying <id>`, `merging <id>`, `scheduling` (between tasks), or a named step such as `integration verify`, `replanning <id>` or `paused`. The seconds count the time in that phase. `SUBSTRATE_HEARTBEAT_MS` changes the interval (see [config.md](config.md)).

- **`json`.** One compact line when the run ends. It carries no progress, so use `text` or `stream-json` to watch a run.

- **`stream-json`.** One JSON object per line, in order: every engine event as it happens, the heartbeats, and a final `result` line. Event lines carry the catalog name in `type` (`usage.recorded` streams as `usage`), with `run_id`, `seq` and `ts`. A heartbeat line has `"type": "heartbeat"`, `run_id`, `ts`, `elapsed_s` (seconds since the run started), `phase`, `phase_elapsed_s` and `cost_usd`, and no `seq`. Fields added for progress:
  - `plan.format_rejected` (new event): `attempt`, `max_attempts`, and `errors`, at most 5 strings of 300 characters each. It is emitted for each refused planner output, before the retry.
  - `run.routed` gains `rationale`.
  - `task.session.started` gains `backend` and `model`.
  - `task.verify.finished` gains `failed_command` and `failed_output` (one line, at most 300 characters) when a verify fails.
  - `plan.produced` lists each task as `id`, `spec`, `title`, `class` and `depends_on`.

A `text` run looks like this (the fake harness, two tasks, timestamps all under one second):

```text
[00:00] run r_HXEFJJSPAOZC started: mode plan, planner claude:claude-sonnet-5-5, worker claude:haiku
[00:00] routed to plan (--mode plan)
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
Total Cost: $0.00
Exit Code:  0
Merged:     yes
```

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
- **Roles**: `--plan <provider[:model[:effort]]>` sets the planner and `--work <provider[:model[:effort]]>` sets the worker. Either one switches the run to the request path. `--model` sets the planner (in `auto` and `plan` modes) or the worker (in `solo`). `--worker-model` sets the worker. `--effort` sets the planner's effort. The named models are used for the whole run: `--plan` for the planner, `--work` for every task (or the solo worker), and they beat profiles and `routing`/`roles` settings (see Route precedence in [config.md](config.md)). `resume` does not read them.
- **Mode**: `--mode auto|solo|plan`. The default is `auto`. In `auto`, the deterministic router decides: a request that names one existing file and uses a mechanical verb (such as bump, rename, typo, format, move, delete or remove) runs as `solo`, and every other request runs as `plan`. `solo` runs one worker with no planner. `plan` always plans. An explicit `solo` or `plan` skips the router. Naming a planner does not change the route (R7.2 superseded the R6.4 rule that it forced `plan`): `auto` still needs both models named, and the router alone decides `plan` or `solo`. To force planning, pass `--mode plan`.
- **Verify**: `--verify "<cmd>"` adds a verify command. It can be repeated. In `solo` mode, a run with no verify command warns that only scope and budget checks apply. The same warning prints when `auto` routes a run to `solo`.
- **Limits**: `--max-budget-usd <amount>` caps the run's spend, `--timeout <seconds>` caps its wall-clock time.
- **Tools**: `--allowed-tools` and `--disallowed-tools` take a list (comma-separated or repeated).
- **Permissions**: `--permission-mode default|plan|acceptEdits|dontAsk|bypassPermissions`. The run default is `dontAsk`. This is Substrate's approval gate. It does not change how the harness is launched: harnesses always run with permissions bypassed (owner decision 2026-10-19).
- **History**: `--history-all` includes archived runs from every charter version in the planner's context.
- **Exit codes**: see the table above. A run that needs answers exits `3` and prints a `needs_input` result with its questions. Answer them with `resume --answers`.
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

Runs the planner only. It forces `--mode plan` and `plan` permissions, so it writes a plan and stops before any worker runs. It accepts the same prompt, `--request`, `--plan`, `--work`, `--model`, `--effort`, `--max-budget-usd` and `--timeout` options as `run`. Without a prompt or request it exits 2 with `prompt required`. It needs only a planner model (`--plan <provider>:<model>`, or `planner.model` in the request) and the same git repository rule as `run`.

```bash
substrate plan --plan claude:opus:high "rename the config key"
```

## resume

```text
substrate resume [options] <run-id | session-id>
```

- With a target, resumes that run. With a session id, resumes the session's latest run. `--session-id` or `--resume` can name the target instead of a positional argument.
- A run whose event log says it has finished prints `Run <id> is already finished. Nothing to resume.` and exits 0.
- A run paused with questions needs answers. `--answers <file|->` reads a JSON object `{"answers":[{"id":"Q1","text":"..."}]}` from a file or stdin. A question left out takes its `default`. A question with no default and no answer exits 2. An answer for an unknown question id exits 2. `--answers` on a run with no pending questions exits 2.
- `--fork-session` with a session target forks the session first.
- Exit codes follow the run exit codes above.

```bash
substrate resume r_ABC123DEF456
substrate resume <run_id> --answers answers.json
```

## status

```text
substrate status [--output-format json] [run-id]
```

Shows a run's state, its tasks and any pause reason. Without a run id it uses the most recent run in `.substrate/runs/`. With no runs it exits 2 with `No run found to display status`. `--output-format json` prints a JSON object.

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

Merges a finished run branch into the current branch. A missing run id exits 2 with `Run ID required`, and an unknown run exits 2 with `Error: unknown run <id>`. The merge is refused, exit 1, when the run did not finish successfully, when tracked files have uncommitted changes, or when a preflight check finds a conflict; the conflicting files are listed on stderr. `--abort-on-conflict` takes the abort path on a conflict. `--dry-run` runs the checks without merging.

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
