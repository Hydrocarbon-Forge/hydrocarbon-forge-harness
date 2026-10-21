# Substrate caller guide

Substrate runs a coding task for you. A planner model writes a plan, cheaper worker models carry it out, and Substrate merges only what passes its checks. You call the `substrate` CLI. Pass `--output-format json` and read the JSON object on stdout. The object is one compact line. Use the exit code to decide what to do next.

## Before you start

Check that Substrate and its providers are ready. Exit code `0` means every check passed.

```bash
substrate doctor --output-format json
```

If the exit code is `1`, a check failed. Each failed entry in `checks` has `"status": "FAIL"` and a `fix` field. Apply the fix before you continue.

## Choose models

```bash
substrate models --output-format json
```

The output is one JSON object. `providers` lists each provider with `installed` and its `models`. `all_models` lists every model with its `provider` and `id`.

Use only an id from `models`. Never invent a model id. Put the id in `model` inside `planner` or `worker`. Always name a model: `run` and `plan` refuse a request, or a command line, that names none. The profile slot in `.substrate/settings.json` does not count as a named model.

## Build a request

Write one JSON object and send it to `substrate run` on stdin (see Run). The object is strict: an unknown key is rejected, and `scope` is always rejected.

- `goal` (string, required): what to build, in plain words. It must not be blank.
- `mode` (optional): `auto` (default, the engine chooses), `solo` (one worker, no planner), or `plan` (a planner writes the plan, then workers run it). In `auto`, a goal that names one existing file and uses a mechanical verb (such as bump, rename, typo, format, move, delete or remove) runs as `solo`; every other goal runs as `plan`. Naming a planner does not force `plan`: a mechanical named-file goal still runs as `solo` in `auto`. To force planning, set `mode` to `plan`.
- `planner` (object): `provider` (required: `claude`, `opencode` or `agy`), `model` (required in `auto` and `plan` modes, an id from `models`), `effort` (optional: `low`, `medium`, `high`, `xhigh` or `max`). Not allowed with `mode` `solo`.
- `worker` (object): the same fields as `planner`. Required in every mode, and `model` must be named.
- `verify` (optional array of strings): shell commands. Each must exit `0` for a task to pass. Each must not be blank.
- `budget` (optional object): `max_usd`, `max_tokens`, `max_wall_min`, all numbers.
- `permission_mode` (optional): `default`, `plan`, `acceptEdits`, `dontAsk` or `bypassPermissions`. This is Substrate's approval gate. It does not change how the harness is launched, which is always with permissions bypassed.
- `context` (optional array of strings): repo-relative file paths. Each must exist.

This is a complete valid request for `solo` mode:

```json
{
  "goal": "Create hello.txt containing the word hello",
  "mode": "solo",
  "worker": {
    "provider": "claude",
    "model": "haiku"
  },
  "verify": ["grep -q hello hello.txt"]
}
```

If the request is invalid, Substrate exits `2` and prints one JSON object on stdout: `{"error":"invalid_request","problems":[{"field","message","fix"}]}`. Fix each problem, using its `fix` text, and send the request again.

## Run

Send the request on stdin. Always pass the model flags on the command line as well: `--plan <provider>:<model>` and `--work <provider>:<model>` in `auto` and `plan` modes, and `--work <provider>:<model>` alone in `solo`. Substrate refuses a run that names no model on the command line or in the request:

```bash
substrate run --mode solo --work claude:haiku --request - --output-format json
```

The output is one JSON object with `run_id`, `status`, `exit_code` and `events`. Read `run_id` and the exit code (see Exit codes). Exit code `3` means the run needs a human. When the JSON has `subtype` `needs_input`, the planner paused for answers (see Handle needs_input).

Substrate merges a run that finishes with every task passed, and whose integration verify passes, into the branch that was checked out when the run started. The JSON then has `merged: true`. Pass `--no-merge` (or `"merge": false` in the request) to keep the work on the run branch: `merged` is `false` and `next` holds `substrate merge <run_id>`, which you may run later to land it. A landing is refused and the run stays `finished` with `merged: false` and a `not_merged_reason` when you switched branches during the run, when your checkout has uncommitted changes to tracked files, or when the changes conflict with your branch. From the JSON, read `merged`, `base_branch`, `files_changed` (up to 50 names; `files_changed_total` counts all of them) and `next`. A failed run also has `failure_class`, `message` and `drafts_dir` (the logs), and `next` names the resume command.

## Watching a run

Run `substrate run` in the foreground and read its stdout as it arrives. Do not poll `status` or read the event files. Stdout carries progress and the summary; stderr carries errors and warnings.

- Text (the default): one line per step, each starting with `[mm:ss]` (time since the run started). The plan appears as `plan ready: <n> tasks` followed by one line per task. Each task shows its start, verify result and merge. A planner output that Substrate refuses shows as `plan rejected (attempt <k>/<max>): ...`. After 15 seconds with no progress, a `still working: <phase>` line appears.
- stream-json (`--output-format stream-json`): one JSON object per line. Read `type` on each line. Engine events (`run.routed`, `plan.started`, `plan.format_rejected`, `plan.produced`, `task.session.started`, `task.verify.finished`, `task.merged`, ...) come in order, heartbeats have `"type": "heartbeat"` with `phase` and `cost_usd`, and the last line is `"type": "result"`.
- json writes only the final object, so it shows no progress.

Use the exit code when the process ends.

If you cannot keep `substrate run`'s stdout open (a second terminal, a script that starts the run and reads it later), follow the run by its id:

- Note the run id. Text prints `run <id> started` on its first line; json and stream-json print `run <id> started; follow it with: substrate watch <id>` on stderr.
- `substrate watch <id>` prints the run's history, then each new line as it happens, then the summary when the run ends. Its exit code is the run's exit code.
- To poll, run `substrate status <id> --output-format json` and read `status` (`running`, `stopped`, `finished`, `failed`, `paused` or `interrupted`), `phase`, `counts` and `next`. `status` never changes anything, so it is safe to call often.
- When `status` says the run has ended, read `result.json` in `.substrate/runs/<id>/`. `summary.txt` in the same directory holds the summary block that text mode prints.
- `stopped` means the process that started the run has gone. Resume it with `substrate resume <id>`.

## Handle needs_input

Exit code `3` with `subtype` `needs_input` means the planner has questions. The result carries `run_id` and `questions`. Each question has an `id`, a `text` and, when one exists, a `default`.

Answer each question you have an answer for. A question you leave out uses its `default`. A question with no `default` must be answered. Send the answers on stdin as one JSON object:

```json
{
  "answers": [
    { "id": "Q1", "text": "redis" }
  ]
}
```

Then resume the run. Replace `<run_id>` with the `run_id` from the paused result:

```bash
substrate resume <run_id> --answers -
```

The exit code of the resumed run applies. If it is `3` again, read the new `questions` and answer them the same way.

## Read usage

```bash
substrate usage --by model --output-format json
```

The output has `rows`, one per model, and `totals`. Each row has `group` (the model id), `runs`, `calls`, `input_tokens`, `output_tokens`, `cost_usd` and `unknown_cost_rows`. `unknown_cost_rows` counts calls whose price Substrate does not know. Those calls are in the token counts, but not in `cost_usd`.

## Exit codes

- `0`: success.
- `1`: run failed. Some tasks may have merged: the run branch keeps them, and a run that failed never lands. Dependents of a failed task are skipped and listed as `skipped`. Read `Reason` and `failed_tasks`; the failed work is under `.substrate/runs/<run>/packets/`. If `next` lists `substrate merge <run_id> --partial`, the run branch holds passed tasks that you can land on purpose: that command runs the plan's integration verify on the run branch first and lands only if it passes. A failed run cannot be resumed: `substrate resume <run_id>` exits `1` with `failure_class: not_resumable` and says what to do instead. Start a new run with a narrower request, or land the passed tasks as above. An unexpected internal error also exits `1`, with `failure_class: internal_error` and its message; the `next` line says it is a Substrate bug and names the run directory, which keeps the event log and `error.txt`.
- `1` with `status` `finished`: the run passed, but the landing was refused. `merged` is `false` and `not_merged_reason` says why. Read `not_merged_reason`: uncommitted tracked changes (commit or stash them), a switched branch (check out the branch the run started on), a conflict (resolve it), or a `--no-merge` run (nothing is wrong). Then run the command in `next` (`substrate merge <run_id>`). The work stays on the run branch until then.
- `2`: usage or config error.
- `3`: needs human: the planner left questions (`needs_input`), or a run paused for approval at Substrate's permission gate, a permission denial or a rate limit. Exit `3` for approval depends on the gate, not on a harness denial. A task the engine cannot finish without an answer that does not exist is failed, not paused: that is exit `1`.
- `4`: budget exhausted. The run stopped between or during tasks. `message` says what was spent against the run budget and what each task was doing (passed, interrupted, not started). Passed work stays on the run branch. `next` names `substrate resume <run_id> --max-budget-usd <n>`, a budget above what was spent; run it to continue.
- `130`: interrupted (SIGINT).
- `143`: terminated (SIGTERM).
