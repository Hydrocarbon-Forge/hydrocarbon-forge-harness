# Local Model Worker Route

Substrate supports delegating worker tasks to a local OpenAI-compatible inference server (such as llama.cpp server, Ollama, or vLLM) via OpenCode's custom provider route.

---

## Architecture Overview

A local model route is configured as a custom provider inside OpenCode. When a task routes to a local model:

1. **Per-Run Isolation**: The adapter generates a per-run configuration file (`opencode.json`) within the task's execution directory. This configuration defines the custom provider with `@ai-sdk/openai-compatible`.
2. **Ephemeral Credentials & Endpoints**: The server base URL and model definitions live strictly in `.substrate/settings.local.json` and in the ephemeral per-run configuration file. They are never committed to the git repository or exposed to task prompts.
3. **Automatic Cleanup**: Upon task completion (whether successful, failed, or cancelled), the per-run configuration file is deleted.
4. **Targeted Concurrency**: Worker concurrency for local OpenCode execution defaults to 2 (configurable via `backends.opencode.max_concurrency`) to avoid overwhelming local GPU or CPU inference capacity.

---

## Configuration

Local provider settings must be stored in `.substrate/settings.local.json`. Substrate explicitly rejects `backends.opencode.provider` if defined in any non-local settings file (such as `.substrate/settings.json` or global user configuration).

### Setting Base URL via CLI

Use `substrate config set` with the `--local` flag to write the endpoint URL into `.substrate/settings.local.json`:

```bash
substrate config set backends.opencode.provider.base_url "http://<host>:<port>/v1" --local
```

> [!IMPORTANT]
> The URL must use the `http:` or `https:` scheme. Any other scheme is rejected with exit code 2. Never commit local IP addresses or hostnames to version-controlled files.

### Configuration Schema

In `.substrate/settings.local.json`:

```json
{
  "backends": {
    "opencode": {
      "provider": {
        "id": "local",
        "npm": "@ai-sdk/openai-compatible",
        "base_url": "http://<host>:<port>/v1",
        "models": {
          "local-llama": {
            "name": "Local Llama 3"
          }
        }
      }
    }
  }
}
```

- `id`: Provider identifier inside OpenCode (defaults to `"local"`).
- `npm`: SDK package for OpenCode provider resolution (must be `"@ai-sdk/openai-compatible"`).
- `base_url`: HTTP/HTTPS endpoint of the local OpenAI-compatible server.
- `models`: Dictionary of model keys served by the local instance.

---

## Routing to Local Models

A profile or role slot names the local model using either the key from `provider.models` or `<id>/<key>`.

### Project Profile Definition

In `.substrate/settings.json`:

```json
{
  "profiles": {
    "local-worker": {
      "plan": {
        "model": "claude-sonnet-5-5",
        "effort": "high"
      },
      "work": {
        "model": "local-llama"
      }
    }
  },
  "defaults": {
    "planner_provider": "claude",
    "worker_provider": "local-worker"
  }
}
```

When the worker task executes:
- The adapter resolves `local-llama` against `provider.models`.
- The adapter translates the model flag to `-m local/local-llama`.
- The ephemeral `opencode.json` configures the `local` provider with endpoint `"http://<host>:<port>/v1"`.
- If `provider.models` is empty while a profile slot names a local model, Substrate reports `unknown model` with exit code 2.
