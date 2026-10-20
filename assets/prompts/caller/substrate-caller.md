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

Use only an id from `models`. Never invent a model id. Put the id in `model` inside `planner` or `worker`. Leave `model` out to use the provider's profile slot in `.substrate/settings.json`.

## Build a request

Write one JSON object and send it to `substrate run` on stdin (see Run). The object is strict: an unknown key is rejected, and `scope` is always rejected.

- `goal` (string, required): what to build, in plain words. It must not be blank.
- `mode` (optional): `auto` (default, the engine chooses), `solo` (one worker, no planner), or `plan` (a planner writes the plan, then workers run it). In `auto`, a goal that names one existing file and uses a mechanical verb (such as bump, rename, typo, format, move, delete or remove) runs as `solo`; every other goal runs as `plan`.
- `planner` (optional object): `provider` (required: `claude`, `opencode` or `agy`), `model` (optional, an id from `models`), `effort` (optional: `low`, `medium`, `high`, `xhigh` or `max`). Not allowed with `mode` `solo`.
- `worker` (optional object): the same fields as `planner`. Every mode runs workers, so set it or the provider's default applies.
- `verify` (optional array of strings): shell commands. Each must exit `0` for a task to pass. Each must not be blank.
- `budget` (optional object): `max_usd`, `max_tokens`, `max_wall_min`, all numbers.
- `permission_mode` (optional): `default`, `plan`, `acceptEdits`, `dontAsk` or `bypassPermissions`. This is Substrate's approval gate. It does not change how the harness is launched, which is always with permissions bypassed.
- `context` (optional array of strings): repo-relative file paths. Each must exist.

This is a complete valid request for `solo` mode. It leaves out `model`, so the worker uses its profile slot:

```json
{
  "goal": "Create hello.txt containing the word hello",
  "mode": "solo",
  "worker": {
    "provider": "claude"
  },
  "verify": ["grep -q hello hello.txt"]
}
```

If the request is invalid, Substrate exits `2` and prints one JSON object on stdout: `{"error":"invalid_request","problems":[{"field","message","fix"}]}`. Fix each problem, using its `fix` text, and send the request again.

## Run

Send the request on stdin:

```bash
substrate run --request - --output-format json
```

The output is one JSON object with `run_id`, `status`, `exit_code` and `events`. Read `run_id` and the exit code (see Exit codes). Exit code `3` means the run needs a human. When the JSON has `subtype` `needs_input`, the planner paused for answers (see Handle needs_input).

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
