# Harness Adapters

Substrate does not call model APIs itself. Every model call is made by an external command-line harness, one headless process per session. The three harnesses are Claude Code (`claude`), OpenCode (`opencode`) and Antigravity (`agy`). Each one has an adapter in `src/backends/adapters/`, and the registry in `src/backends/registry.ts` creates them from settings.

---

## Summary

| Adapter | Harness | Built-in pin | Pin override | Models listed from | Denied tools reported by |
|---|---|---|---|---|---|
| `claude` | `claude` | 2.1.304 | `backends.claude.version_pin` | built-in aliases plus model ids from settings and the price table (no process is run) | the structured stream |
| `opencode` | `opencode` | 2.0.21 | `backends.opencode.version_pin` | the `opencode` models subcommand, plus the local provider models from settings | not reported as a signal |
| `agy` | `agy` | 1.4.2 | `backends.agy.version_pin` is used by `substrate doctor` only | the `agy` models subcommand | the error stream |

`bin` for each harness comes from `backends.<name>.bin`, and the default is the harness name. `max_concurrency` for each harness comes from `backends.<name>.max_concurrency`, and the scheduler applies it only to the backend named by `roles.worker.backend` (see [config.md](config.md)).

---

## Adapter Interface

Every adapter implements `HarnessAdapter` from `src/contracts/index.ts`:

- `capabilities`: a static `Capabilities` record with the harness name, its pin, and feature flags (effort, budget flag, cost reporting, resume, denial signal, and an optional `max_concurrency`).
- `validateEnvironment()`: runs the harness's version query and compares the result with the pin. The result is an environment report with `ok`, `pin_matches`, `version` and `problems`.
- `listModels()`: lists model ids for `substrate models`.
- `spawn(req)`: starts one session and returns a handle with an event stream, a `result()` promise and a `kill(reason)` method. The reason is `budget`, `timeout` or `cancel`.

A `SpawnRequest` carries the role, the working directory, the prompt, optional text appended to the system prompt, the model, the effort, the allow and deny lists, the budget, an optional environment, an optional raw output directory, and session information (an id to start with, an id to resume, or a fork flag).

### Events

Every adapter normalizes its output into these `BackendEvent` types:

| Event | Meaning |
|---|---|
| `session.started` | The session has a session id. |
| `assistant.text` | Text from the model. |
| `tool.call` | The model called a tool. |
| `tool.result` | A tool returned. |
| `permission.denied` | A tool call was denied. |
| `usage` | A usage record with tokens and cost. |
| `subagent` | The harness started a child session. |
| `error` | A typed error: `rate_limit`, `auth`, `crash`, `timeout` or `protocol`. |
| `session.result` | The final result: `ok`, `final_text`, `exit_code`, usage, and an optional stop reason. |

The `claude` adapter writes the raw stream of a session to `<session id>.ndjson` in the request's raw directory when one is given.

---

## `claude`

`src/backends/adapters/claude.ts`

- **Pin.** `2.1.304` unless `backends.claude.version_pin` is set. The check is exact string equality with the version the binary reports.
- **Environment check.** Runs the binary's version query with a 5 second timeout.
- **Model list.** Four aliases (`haiku`, `sonnet`, `opus`, `fable`) followed by every model id that settings name in `roles` or `routing`, or that the price table has. Claude has no list command, so no process is run.
- **Spawn.** Runs `claude` in print mode with stream JSON output and verbose logging. It passes:
  - the model, and the effort when one is set;
  - a session id to start with or a session id to resume (the id must be a UUID; a request without one is an error);
  - the appended system text, when present;
  - permissions bypassed (the harness's skip-permissions option, `dangerously-skip-permissions`) with prompts turned off. The engine's `permission_mode` is an approval gate and does not change this;
  - the request's deny list plus the Agent tool as disallowed tools. The allow list is not passed, because permissions are bypassed;
  - a USD cap, when the budget sets one above zero.
- **Environment.** The child process gets a fixed set of variables (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`) and the request's environment.
- **Cost.** Reported by the harness (`cost_reported` is true).

## `opencode`

`src/backends/adapters/opencode.ts`

- **Pin.** `2.0.21` unless `backends.opencode.version_pin` is set. The check passes when the version output contains the pin.
- **Environment check.** Runs the binary's version query with a 5 second timeout.
- **Model list.** Runs the `opencode` models subcommand in standalone mode with a 30 second timeout. Local provider models from settings are added to the list. If the subcommand fails and no local provider is configured, the listing is an error.
- **Spawn.** Runs the `run` subcommand in standalone mode with `--auto` (permissions bypassed) and JSON output, the model passed with `-m`, and the agent file created for the session. A session is resumed with `-s`, and a fork is requested with the fork option. The prompt is the last argument.
- **Model string.** The model is the id from the profile or the role. When an effort is set, `#<effort>` is appended. A local model key is mapped to `<provider id>/<key>` (see [local-model.md](local-model.md)).
- **Per-run files.** Before a session, the adapter writes an agent file under `.opencode/agents/` in the request's working directory, with the deny list as permissions. When a local provider or the legacy `customBaseUrl` is set, it also writes `opencode.json` there. Both files are removed when the session finishes or is killed. The working directory is the task's worktree. Child processes are started with `PWD` set to their working directory, because opencode resolves its project from `PWD`, not from the process directory.
- **Session ids.** Substrate sends opencode session ids in opencode's `ses_` form: an engine UUID is converted to `ses_` plus its 32 hex digits before it is passed to `-s`, and the converted id is the one reported back to the engine.
- **Local model without an endpoint.** When the model names a local provider model and no endpoint is set, the session fails at once with a `protocol` error and exit code 1. The error text names the two settings the code reads for the endpoint, `backends.opencode.provider.base_url` in `.substrate/settings.local.json` and `backends.opencode.extra.customBaseUrl`, and the same reason is written once to stderr as a `[substrate] warn:` line.
- **Max concurrency.** The adapter reports `max_concurrency` 2 by default. The engine does not read that value; the scheduler reads `backends.<name>.max_concurrency` instead.
- **Cost.** Where the harness output does not give a dollar figure, cost is computed from the price table. A model with no rates is recorded with cost source `unknown`.

## `agy`

`src/backends/adapters/agy.ts`

- **Pin.** `1.4.2`, fixed in the adapter. `backends.agy.version_pin` is read by `substrate doctor` for its comparison, but the adapter's own check always uses `1.4.2`.
- **Environment check.** Runs the binary's version query with a 5 second timeout. The check passes only when the trimmed output equals the pin exactly.
- **Model list.** Runs the `models` subcommand with a 30 second timeout.
- **Spawn.** Runs `agy` in print mode with stream JSON output, the model, and the effort when it is `low`, `medium` or `high` (other values are dropped with a warning). It uses accept-edits mode with the skip-permissions option (`dangerously-skip-permissions`, permissions bypassed), a print timeout of `0s` so a headless run never waits for input, and the conversation id to resume when one is given. When the request has appended system text, the prompt is `SYSTEM RULES`, then the appended text, then `TASK`, then the prompt.
- **Denied tools.** Permissions are bypassed, so a denial should not occur. If the harness still denies a tool, the denial is reported on the error stream. The exit code is still 0.
- **Cost.** Not reported by the harness. Cost is computed from the price table.

---

## Testing

The shared conformance suite is `test/conformance/suite.ts`, and `test/conformance/fake-adapter.ts` is a scripted adapter for tests. Neither is part of the user-facing CLI.
