# Configuration Reference

Substrate reads its settings from JSONC files (JSON with comments and trailing commas), from a few environment variables, and from command flags. The settings schema is `Settings` in `src/contracts/index.ts`. It is strict: an unknown top-level key makes the load fail with exit 2.

---

## Configuration Files

| Layer | File | Where it is found |
|---|---|---|
| User | `settings.json` | `~/.config/substrate/`, or the directory named by `SUBSTRATE_CONFIG_DIR` |
| Project | `.substrate/settings.json` | the project directory |
| Local | `.substrate/settings.local.json` | the project directory (`substrate init` adds it to the `.gitignore` it writes) |
| Explicit | any file | `--settings <file>`, or `SUBSTRATE_SETTINGS` when the flag is absent |

The project directory is `SUBSTRATE_PROJECT_DIR` when that variable is set. Otherwise it is the current directory; some commands pass the repository root instead. A missing user, project, local or explicit file is skipped, except that an explicit file that does not exist is an error. A file that is not valid JSONC, or whose top level is not an object, is an error (exit 2).

---

## Precedence

The loader starts from the built-in defaults (`DEFAULT_SETTINGS` in `src/config/index.ts`) and applies these layers in this order. Each later layer overrides the earlier ones:

1. **Built-in defaults.** `DEFAULT_SETTINGS`, listed in each section below. The built-in worker route is not one of them; see Route precedence.
2. **User file.**
3. **Project file.**
4. **Local file.**
5. **Explicit file.** `--settings` wins over `SUBSTRATE_SETTINGS`; only one of the two is read.
6. **Environment variables that set settings:** `SUBSTRATE_MAX_BUDGET_USD`, `SUBSTRATE_MODEL` and `SUBSTRATE_WORKER_MODEL`.
7. **Command flags.** Each command builds these from its flags. For example, `run` maps `--model` to the planner (or to the worker in solo mode), `--worker-model` to the worker, `--effort` to the planner effort and `--max-budget-usd` to `budgets.run.max_usd`.

`SUBSTRATE_PERMISSION_MODE` and `SUBSTRATE_OUTPUT_FORMAT` are not settings. They supply the default permission mode and output format for `run` and `plan` when the matching flag is absent. The permission mode is Substrate's approval gate. It does not change how harnesses are launched, which is always with permissions bypassed.

### Merge rules

- Objects merge key by key, recursively. A value from a higher layer replaces the same key from a lower layer.
- Arrays and primitive values replace the lower-layer value. They are not concatenated.
- `null` replaces the lower-layer value; the schema then decides whether that is valid.
- A `pricing` object from a higher layer replaces the lower-layer `pricing` as a whole.
- The merged result is validated against the schema. A value that fails validation is an error (exit 2) that names the key.
- `backends.opencode.provider` may be set only in the local file. An explicit file whose path ends in `settings.local.json` also counts as local. Setting the key anywhere else is an error (exit 2), even if the value is otherwise valid.
- Every name in `defaults` must have an entry in `profiles`. Otherwise the load fails (exit 2).

---

## The `config` Command

- `substrate config list` prints the merged settings as JSON.
- `substrate config get <key>` prints one value by dotted path. A key that is not in the settings schema exits 2 with `unknown settings key: <key>`. A known key that is unset prints `undefined` and exits 0. With `--output-format json` the value is always a valid JSON value: a string is quoted (`"claude"`), and an unset key prints `null`.
- If the settings files fail to load, `list` and `get` exit 2. In text mode the error goes to stderr. In json mode it is one `{"error":...}` object on stdout.
- `substrate config set <key> <value>` writes the project file. With `--local` it writes the local file. It validates the merged result before writing.

`config set` applies the same provider rule as the loader. Without `--local`, `backends.opencode.provider` is refused with exit 2 and nothing is written, so later loads are not broken. Pass `--local` for the provider key. The endpoint setup is described in [local-model.md](local-model.md).

---

## Environment Variables

Only the variables below are read by the code.

| Variable | Type | Description |
|---|---|---|
| `SUBSTRATE_CONFIG_DIR` | Directory | Replaces `~/.config/substrate` as the user settings directory. The user prompt directory is taken from it too. |
| `SUBSTRATE_PROJECT_DIR` | Directory | Replaces the project directory for the `.substrate/` settings files. The OpenCode adapter also reads it to find `settings.local.json`. |
| `SUBSTRATE_SETTINGS` | File path | Explicit settings file (layer 5). The `--settings` flag takes precedence over it. |
| `SUBSTRATE_MAX_BUDGET_USD` | Number | Sets `budgets.run.max_usd` (layer 6). A value that is not a number makes every command that loads settings exit 2. |
| `SUBSTRATE_MODEL` | String | Sets `roles.planner.model` (layer 6). |
| `SUBSTRATE_WORKER_MODEL` | String | Sets `roles.worker.model` (layer 6). |
| `SUBSTRATE_PERMISSION_MODE` | String | Default permission mode for `run` and `plan` when `--permission-mode` is absent. Allowed values: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`. Any other value makes every command that loads settings exit 2. It is Substrate's approval gate and does not change harness launch. |
| `SUBSTRATE_OUTPUT_FORMAT` | String | Default output format for `run` and `plan` when `--output-format` is absent: `text`, `json` or `stream-json`. Any other value is ignored. |
| `SUBSTRATE_HEARTBEAT_MS` | Number | Milliseconds without a progress line before a run writes a heartbeat (`still working: ...` in text, a `heartbeat` object in stream-json). Default 15000. A value that is not a positive number is ignored. See cli.md, Progress output. |
| `SUBSTRATE_DEBUG` | `1` | When set to `1`, debug log lines are written to stderr. |

---

## Settings Key Index

Each row is one dotted key the engine reads. A `*` segment stands for any name, such as a provider name or a task class. Schema keys that the engine does not read are described in the section that owns them, not in this table.

| Key | Type | Meaning |
|---|---|---|
| `budgets.run.max_usd` | number | Spend cap for a whole run in USD. Default 5. It also bounds the planner: each planner session is capped at the run budget not yet spent, at least 0.5 and never above this cap. |
| `budgets.run.max_tokens` | number | Token cap for a whole run. Unset by default. |
| `budgets.task.max_usd` | number | Spend cap for one task in USD. Default 0.5. It binds tasks only: the planner is bounded by the run budget (see `budgets.run.max_usd`), each planner session getting the run budget not yet spent, at least 0.5 and never above the run cap. |
| `budgets.task.max_tokens` | number | Token cap for one task. Unset by default. |
| `budgets.task.timeout_min` | number | Timeout for one task, in minutes. Falls back to 30 when unset. |
| `budgets.task.max_turns` | number | Turn cap for one task. Unset by default. |
| `budgets.l1_replans_per_task` | integer | Maximum L1 replans (heal and retry attempts) for one task. Default 2. |
| `budgets.l2_per_run` | integer | Maximum L2 full re-plans for one run. Default 2. |
| `budgets.planner_format_retries` | integer | Planner retries after an invalid plan: a format, contract typecheck or approval lint refusal (see the events in `cli.md`). Default 2. |
| `budgets.approval_threshold_usd` | number | Estimated cost above which approval is required. Default 2. |
| `concurrency.workers` | integer | Maximum number of worker tasks running at once, each in its own worktree. Default 3. |
| `defaults.planner_provider` | string | Provider whose `plan` profile slot routes the planner. |
| `defaults.worker_provider` | string | Provider whose profile routes worker tasks and the escalation chain. |
| `git.on_scope_violation` | `revert` or `fail` | What happens when a worker changes files outside its allowed paths. Default `revert`. |
| `git.auto_merge` | boolean | When `true`, a run that finishes with exit code 0 is merged with the same code the merge command uses. Default `false`. The `--merge` flag and the request's `merge: true` do the same for one run (see cli.md). |
| `instructions.workers` | `none` or `project` | When `project`, the planner request lists the project instruction files that exist (`CLAUDE.md`, `AGENTS.md`, `SUBSTRATE.md`). Default `none`. |
| `pricing.asOf` | string | Date the price table was last refreshed. |
| `pricing.sources` | array of strings | URLs that document the rates. |
| `sandbox.enabled` | boolean | When `true`, verify commands run inside `bwrap` where it is available. `run`, `plan` and `resume` refuse to start when it is `true` and `bwrap` is missing. Default `false`. |
| `usage.global` | boolean | When `true`, usage records are also appended to the global usage ledger. Default `true`. |
| `roles.planner.backend` | string | Backend of the planner route. Default `claude`. |
| `roles.planner.model` | string | Model of the planner route. Default `claude-sonnet-5-5`. |
| `roles.planner.effort` | effort level | Effort of the planner route. Default `medium`. |
| `roles.worker.backend` | string | Backend of the solo worker. Also the backend whose `max_concurrency` the scheduler applies. No default: unset, the solo worker uses the resolved `feature` route (see Route precedence). |
| `roles.worker.model` | string | Model of the solo worker. No default (see Route precedence). |
| `roles.worker.effort` | effort level | Effort of the solo worker. When unset, the effort of the `feature` route is used. |
| `routing.escalation` | array of strings | Model ids for escalation when no worker profile is set. Default `haiku`, `sonnet`, `opus`. |
| `routing.*.backend` | string | Backend of the route for one task class. |
| `routing.*.model` | string | Model of the route for one task class. |
| `routing.*.effort` | effort level | Effort of the route for one task class. |
| `profiles.*.plan.model` | string | Model of a provider's `plan` slot. |
| `profiles.*.work.model` | string | Model of a provider's `work` slot. |
| `profiles.*.fast.model` | string | Model of a provider's `fast` slot. |
| `backends.*.bin` | string | Executable name or path of a harness. |
| `backends.*.version_pin` | string | Version that `substrate doctor` compares the installed harness with. |
| `backends.*.max_concurrency` | integer | Cap on simultaneous processes for the backend named by `roles.worker.backend`. |
| `pricing.models.*.input_per_mtok` | number | Input rate in USD per million tokens. An effort-suffixed id (`-low`, `-medium`, `-high`) with no entry of its own uses its base id's rates when the base is priced; this is an approximation, because a higher effort tier may bill differently. |
| `pricing.models.*.output_per_mtok` | number | Output rate in USD per million tokens. |
| `pricing.models.*.cache_read_per_mtok` | number | Cache read rate in USD per million tokens. |
| `pricing.models.*.cache_write_per_mtok` | number | Cache write rate in USD per million tokens. |

---

## Settings Schema Reference

### `backends`

Per-harness settings. The keys are harness names: `claude`, `opencode` and `agy`.

Default: none (`{}`). Without an entry, `bin` is the harness name (`claude`, `opencode` or `agy`). The built-in version pins are `2.1.304` for `claude`, `2.0.21` for `opencode` and `1.4.2` for `agy`.

- `bin`: the executable name or path. The registry reads it for all three harnesses.
- `version_pin`: the version that `substrate doctor` compares with the installed version, for all three harnesses. The `claude` and `opencode` adapters also use it in their own environment check. The `agy` adapter's own check always uses its built-in `1.4.2`.
- `max_concurrency`: the scheduler caps simultaneous processes for the backend named by `roles.worker.backend` only. When unset, no per-backend cap applies. The adapter's reported capability is not read by the engine.
- `extra`: a free-form record. The only key the code reads is `customBaseUrl`, for OpenCode. Other keys are accepted and ignored.
- `provider`: the OpenCode local endpoint. It may be set only in the local file. See [local-model.md](local-model.md).

```json
{
  "backends": {
    "claude": { "version_pin": "2.1.304" },
    "opencode": { "bin": "opencode" }
  }
}
```

### `roles`

The planner and worker routes. Each route has `backend`, `model` and an optional `effort`.

Default: the planner route is `claude` / `claude-sonnet-5-5` / `medium`. `worker` has no default.

- `planner`: the planner route when `defaults.planner_provider` is not set.
- `worker`: in solo mode, its `backend` and `model` replace the task route for the single worker. It is a partial route: a request, environment variable or flag may set only `model` (or only `backend`), and the rest comes from the resolved `feature` route. Its `effort`, when set, replaces the effort of the feature route for the single worker, as its `backend` and `model` do. Its `backend` is also the backend the scheduler caps with `max_concurrency`. Unset, solo mode uses the resolved `feature` route.
- `reviewer`: accepted by the schema and not read by this version.
- `governor`: removed. The governor was deleted on 2026-10-20 (DECISIONS A2). A settings file that contains `roles.governor` is rejected by the strict schema, like any unknown key.

### `routing`

Per-class routes, plus the escalation list.

Default: `escalation` is `["haiku", "sonnet", "opus"]`. There is no default route: the built-in claude route (`claude` / `claude-sonnet-5-5` / `medium`) applies only when nothing else selects a route (see Route precedence).

- `routing.<class>`: a route for one task class (for example `feature`, `tests`, `refactor`). Only `backend`, `model` and `effort` are read. A `budget` entry is accepted and not read.
- `escalation`: a list of model ids. It is used for escalation only when no worker profile is set (`defaults.worker_provider` names no profile). With a worker profile, the chain is the profile's `fast`, `work` and `plan` models, in that order, without repeats.

### `profiles`

Per-provider model slots. Each provider name maps to `plan`, `work` and an optional `fast` slot. A slot is `{ "model": "<id>", "effort": "<level>" }`; `effort` is optional. `plan` and `work` are required.

```json
{
  "profiles": {
    "claude": {
      "plan": { "model": "claude-sonnet-5-5", "effort": "high" },
      "work": { "model": "claude-sonnet-5-5", "effort": "medium" }
    }
  }
}
```

- `plan` routes the planner (when `defaults.planner_provider` names the provider). It also routes the `debug` and `review` classes.
- `work` routes the `tests`, `feature` and `refactor` classes, and is the fallback for every other class.
- `fast` routes the `search`, `mechanical` and `boilerplate` classes. Those classes use `work` when `fast` is absent.
- A profile routes worker tasks only when `defaults.worker_provider` names it and the task class has no explicit `routing.<class>` entry. A profile is selected by `defaults.planner_provider` and `defaults.worker_provider`, or by a request that sets `planner` or `worker`; there is no `profile` key.

### Route precedence

A worker task's route is built from these steps. The route comes from the first of steps 2 to 4 that gives one. Then the request (step 1) is applied on top of it.

1. **Request.** The worker the caller names for this run: `--work`, `--worker-model` or `--model` in `solo`, or the request's `worker` object. Its `backend`, `model` and `effort` replace the route's fields; a field it does not set keeps the route's value. A named model is used for every task and every generation, so a retry or replan does not escalate away from it. Effort is the class's effort unless the request sets one. (R7.4)
2. **Explicit user settings.** `routing.<class>` for the task's class (the solo worker's class is `feature`). In solo mode, `roles.worker` (its `backend`, `model` and `effort`, from any settings layer) is applied on top of the route, as it was before R7.4.
3. **Selected profile.** The `fast`, `work` or `plan` slot of the `defaults.worker_provider` profile, for the task's class.
4. **Built-in fallback.** `claude` / `claude-sonnet-5-5` / `medium`, the last step. It is not a settings default, so a user value is never confused with it. `config list` and `config get` do not print it: `roles.worker` and `routing.feature` appear only when set.

In plan mode a `roles.worker` in a settings file is not read for tasks (step 2 covers `routing.<class>`); only a request names the worker there. A request is the only source of `roles.requested`, which run and plan set from the request payload and the command flags; a settings file that sets it is refused (exit 2).

The planner route is: the request's `planner` (its `backend` and `model`, with the profile or `roles.planner` values for anything it does not set), otherwise the `plan` slot of the `defaults.planner_provider` profile when that names a profile, otherwise `roles.planner`. A user `roles.planner` is ignored when a planner profile applies, as it was before R7.4.

### `defaults`

Which provider's profile routes the planner and the workers.

- `planner_provider`: provider whose `plan` slot routes the planner.
- `worker_provider`: provider whose profile routes worker tasks and the escalation chain.

Each name must have an entry in `profiles`. Otherwise the load fails (exit 2).

### `pricing`

Token rates used to compute cost when a harness does not report dollars.

- `asOf`: date the table was last refreshed.
- `sources`: URLs that document the rates.
- `models`: per model id, `input_per_mtok` and `output_per_mtok` (required), with optional `cache_read_per_mtok` and `cache_write_per_mtok`. Rates are USD per million tokens.

The built-in price table (`src/backends/default-pricing.ts`) is merged with this table one model id at a time: an entry here replaces the built-in entry for the same id, and other built-in ids stay. A model with no rates is recorded with `cost_source` set to `unknown`. An effort-suffixed id with no entry of its own uses its base id's rates when the base is priced, which is an approximation because a higher effort tier may bill differently.

### `budgets`

Spend, token and time limits, and retry counts.

Default: `run.max_usd` 5, `task.max_usd` 0.5, `l1_replans_per_task` 2, `l2_per_run` 2, `planner_format_retries` 2, `approval_threshold_usd` 2.

- `run`: `max_usd` and `max_tokens` are read. `max_wall_min` is accepted and is not enforced by the engine. `--max-budget-usd` and `SUBSTRATE_MAX_BUDGET_USD` set `run.max_usd`.
- `task`: `max_usd`, `max_tokens`, `timeout_min` (30 when unset) and `max_turns` are read.
- `l1_replans_per_task`, `l2_per_run`, `planner_format_retries` and `approval_threshold_usd` are read as described in the index.

```json
{
  "budgets": {
    "run": { "max_usd": 5 },
    "task": { "max_usd": 0.5, "timeout_min": 30 }
  }
}
```

### `concurrency`

- `workers`: the maximum number of worker tasks running at once, each in its own git worktree. Default 3. A task waits when the limit is reached, and a task that depends on another starts only after that task is merged. `backends.<name>.max_concurrency` also caps the processes of the worker backend (`roles.worker.backend`). A rate limit halves the number running (floor 1).

### `permissions`

- `allow` and `deny` are accepted. The engine does not read them. Worker and planner tool rules are fixed in code (`src/roles/worker.ts` and `src/engine/actions/plan.ts`), so these lists do not change what a worker or planner may do in this version.
- The schema has no ask list. A settings file that still has one under `permissions` fails validation, and the file must be edited to remove it.

### `sandbox`

- `enabled`: default `false`. When `true`, verify commands run inside `bwrap` where it is available. When it is `true` and `bwrap` is not installed, `run`, `plan` and `resume` refuse to start with an error.
- `network` was removed in R6.7 (see [Removed keys](#removed-keys)). Verify commands always get a fixed network setting in the code.

### `git`

Default: `on_scope_violation` `revert`, `auto_merge` `false`.

- `on_scope_violation`: `revert` or `fail`. It is read when a worker changes files outside its allowed paths.
- `auto_merge`: when `true`, a run that finishes with exit code 0 is merged with the same code the merge command uses. A caller opts in for one run with `--merge` or `merge: true` in the request; the setting itself stays `false` by default.
- `branch_prefix` was removed in R6.7 (see [Removed keys](#removed-keys)). Branch names are fixed in code (`substrate/tasks/...` and `substrate/runs/...`, DECISIONS).

### `instructions`

- `workers`: `none` (default) or `project`. The key is named for workers, but the code reads it in the planner: when it is `project`, the planner request lists the project instruction files that exist (`CLAUDE.md`, `AGENTS.md`, `SUBSTRATE.md`).

### `usage`

- `global`: default `true`. When `true`, each usage record is also appended to `$XDG_STATE_HOME/substrate/usage.jsonl`, or to `~/.local/state/substrate/usage.jsonl` when `XDG_STATE_HOME` is not set. The project ledger is always written under `.substrate/ledger/`.

### `execution`

- `strategy`: default `direct`. The schema accepts `direct` and `dispatcher`. The engine does not read this key; `direct` is the only behaviour in this version.

## Removed keys

These keys were removed in R6.7 because nothing read them and the decisions put them out of scope (`hooks`: DECISIONS, Out of scope; `git.branch_prefix`: DECISIONS, task and run branch names are fixed; `sandbox.network`: DECISIONS A6). The settings schema is strict, so a settings file that still contains one fails to load with exit 2, and the error names the key. Delete the key from the file to fix it:

- `hooks` (any layer)
- `git.branch_prefix`
- `sandbox.network`
