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

Substrate keeps a passing run on its own run branch until it is merged. Pass `--merge` (or `"merge": true` in the request) when you want the work in the checked-out branch's working tree; the run is then merged and the JSON has `merged: true`. Without it, `merged` is `false` and `next` holds `substrate merge <run_id>`, which you may run to land the work. From the JSON, read `merged`, `base_branch`, `files_changed` (up to 50 names; `files_changed_total` counts all of them) and `next`. A failed run also has `failure_class`, `message` and `drafts_dir` (the logs), and `next` names the resume command.

## Watching a run

Run `substrate run` in the foreground and read its stdout as it arrives. Do not poll `status` or read the event files. Stdout carries progress and the summary; stderr carries errors and warnings.

- Text (the default): one line per step, each starting with `[mm:ss]` (time since the run started). The plan appears as `plan ready: <n> tasks` followed by one line per task. Each task shows its start, verify result and merge. A planner output that Substrate refuses shows as `plan rejected (attempt <k>/<max>): ...`. After 15 seconds with no progress, a `still working: <phase>` line appears.
- stream-json (`--output-format stream-json`): one JSON object per line. Read `type` on each line. Engine events (`run.routed`, `plan.started`, `plan.format_rejected`, `plan.produced`, `task.session.started`, `task.verify.finished`, `task.merged`, ...) come in order, heartbeats have `"type": "heartbeat"` with `phase` and `cost_usd`, and the last line is `"type": "result"`.
- json writes only the final object, so it shows no progress.

Use the exit code when the process ends.

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
- `1`: run failed.
- `2`: usage or config error.
- `3`: needs human (approval at Substrate's permission gate, or escalation L3). Exit `3` for approval depends on the gate, not on a harness denial.
- `4`: budget exhausted.
- `130`: interrupted (SIGINT).
- `143`: terminated (SIGTERM).
