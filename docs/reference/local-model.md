# Local Model Worker Route

A local OpenAI-compatible inference server, such as the llama.cpp server, can run worker tasks. Substrate reaches it through OpenCode's custom provider. The endpoint is stored only in `.substrate/settings.local.json`, which `substrate init` lists in the `.gitignore` it writes.

Nothing is routed to the local provider unless a route names one of its models.

---

## Configuration

### 1. Set the endpoint

Write the endpoint URL into the local settings file:

```bash
substrate config set backends.opencode.provider.base_url "<endpoint URL>" --local
```

The URL must start with `http:` or `https:`. Any other scheme is rejected with exit code 2.

Always pass `--local`. Without it, `config set` writes the provider key into `.substrate/settings.json`, reports success, and every later load then fails with exit code 2 (see [config.md](config.md)).

### 2. Describe the provider

In `.substrate/settings.local.json`, the provider block is:

```json
{
  "backends": {
    "opencode": {
      "provider": {
        "id": "local",
        "npm": "@ai-sdk/openai-compatible",
        "base_url": "<endpoint URL>",
        "models": {
          "local-llama": { "name": "Local Llama 3" }
        }
      }
    }
  }
}
```

- `base_url` (required): the endpoint of the local server. It must be an `http:` or `https:` URL. A path such as `/v1` is kept as written.
- `id` (optional, default `local`): the provider name used in OpenCode model strings.
- `npm` (optional): must be `@ai-sdk/openai-compatible`, which is also the default.
- `models` (optional, default empty): the model keys that the server serves. Each key may have a `name` used as its display name.

`backends.opencode.provider` may be set only in the local file. Setting it in the project file, the user file, or any other explicit file is an error (exit 2).

### 3. Route work to the local models

A profile names the models for each provider, and `defaults.worker_provider` names the provider whose profile routes worker tasks. The provider name is also the backend name, so the local models go under the `opencode` profile:

```json
{
  "profiles": {
    "claude": {
      "plan": { "model": "claude-sonnet-5-5", "effort": "high" },
      "work": { "model": "claude-sonnet-5-5", "effort": "medium" }
    },
    "opencode": {
      "plan": { "model": "local-llama" },
      "work": { "model": "local-llama" }
    }
  },
  "defaults": {
    "planner_provider": "claude",
    "worker_provider": "opencode"
  }
}
```

A profile whose name is not a backend name (for example `local-worker`) is not usable: the route's backend is the profile name, no adapter has that name, and the run pauses with `backend_unavailable`.

Two built-in settings take precedence over profiles:

- `routing.feature` is not a default. The `feature` class uses an explicit `routing.feature` if set, else the worker profile's slot, else the built-in claude route (`claude-sonnet-5-5`). An explicit route for a task class wins over a profile slot (see Route precedence in `config.md`).
- `roles.worker` is not a default. When set, it replaces the backend and model of the single worker in solo mode; when unset, solo mode uses the `feature` route above.

To run a solo task on the local model, set the solo worker route:

```json
{
  "roles": {
    "worker": { "backend": "opencode", "model": "local-llama" }
  }
}
```

---

## Model Names

- A profile or role slot may name a local model by its key (`local-llama`) or by `<provider id>/<key>` (`local/local-llama`).
- The adapter maps the key to `<provider id>/<key>` in the model string it passes to OpenCode. An effort adds `#<effort>` to the end.
- `substrate models` lists each local key and each `<provider id>/<key>` id under the `opencode` provider, when the provider is set. The listing does not need the local server to be reachable.
- When the `opencode` harness is installed and a requested id is not in that listing, request validation reports `unknown model`.

---

## What Happens at Run Time

When a session starts on the local route, the OpenCode adapter:

1. Writes an agent file and an `opencode.json` file into the task's working directory (the task worktree). The `opencode.json` file holds the provider block: the `npm` package, `options.baseURL` set to `base_url`, and the `models` table.
2. Starts `opencode` with the mapped model string.
3. Removes both files when the session finishes or is killed.

The endpoint is passed to OpenCode only through that per-run file. It is not part of the prompt or of the task spec.

If a local model is named and no endpoint is configured, the session fails at once with a `protocol` error and exit code 1, and one `[substrate] warn:` line on stderr gives the same reason. The error text names the two settings the adapter reads: `backends.opencode.provider.base_url` in `.substrate/settings.local.json`, or the legacy `backends.opencode.extra.customBaseUrl`.

The live smoke test (`test/live`) takes the endpoint from a test-only environment variable, named in `test/live/helpers.ts` (function `liveLocalSettings`). That variable is required when the opencode live model is a local llama.cpp route (for example `llama.cpp/<model>`), and the test fails before any run if it is missing. Set it to the server's address, in the form `http://<host>:<port>/v1`; the value is written only into the toy repository's `settings.local.json`, never into a committed file. It is ignored for a non-local model.

---

## Concurrency

The scheduler caps simultaneous OpenCode processes only when `backends.opencode.max_concurrency` is set and `roles.worker.backend` is `opencode`. It reads `roles.worker.backend` only, so the cap has no effect on profile-routed workers unless `roles.worker` also names `opencode`. The adapter's own reported value of 2 is not read by the engine (see [adapters.md](adapters.md)).
