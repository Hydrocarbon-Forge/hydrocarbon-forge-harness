# Configuration Reference

Substrate uses JSONC (JSON with Comments and trailing commas) configuration files to control model routing, external harness parameters, resource budgets, execution permissions, sandbox policies, and Git worktree management.

---

## Configuration Files and Layout

Substrate discovers configuration across multiple scopes:

- **User Global Configuration**: `~/.config/substrate/settings.json`
- **Project Configuration**: `.substrate/settings.json`
- **Project Local Overrides**: `.substrate/settings.local.json` (recommended for `.gitignore`)
- **Custom Configuration File**: Explicitly specified with `--settings <path>`

---

## Precedence Hierarchy

Substrate resolves configuration values using a strict 7-layer precedence order. Higher layers override values defined in lower layers:

1. **Layer 1: Embedded Defaults (`DEFAULT_SETTINGS`)**  
   Hardcoded fallback defaults built into the Substrate engine.
2. **Layer 2: User Global Settings**  
   Loaded from `~/.config/substrate/settings.json` (or the directory in `SUBSTRATE_CONFIG_DIR`).
3. **Layer 3: Project Repository Settings**  
   Loaded from `.substrate/settings.json` at the project repository root.
4. **Layer 4: Project Local Overrides**  
   Loaded from `.substrate/settings.local.json`. Use this for machine-specific overrides, such as local model IP addresses or personal API overrides.
5. **Layer 5: Explicit Settings File**  
   Supplied via the `--settings <file>` CLI option.
6. **Layer 6: Environment Variables**  
   Environment variables prefixed with `SUBSTRATE_*` overriding specific runtime attributes.
7. **Layer 7: Command-Line Flags**  
   Highest priority flags passed directly to CLI invocations (e.g., `--model`, `--max-budget-usd`, `--permission-mode`).

---

## Object Merging Rules

When combining settings across layers:

- **Plain Objects**: Merged recursively key-by-key. Nested dictionary values from higher layers override matching keys from lower layers while preserving unmatched keys.
- **Arrays**: Replaced completely. Array values in an overlay do not concatenate with base arrays.
- **Primitives**: Numbers, strings, booleans, and `null` values replace lower layer values directly.
- **Pricing Table (`pricing`)**: The `pricing` table object is replaced in its entirety as an atomic unit to ensure price table consistency.

---

## Environment Variables

Substrate recognizes the following standard environment variables:

| Variable | Type | Description |
|---|---|---|
| `SUBSTRATE_LIVE` | Boolean (`1` or `0`) | Enables live external harness invocations during test batteries and benchmark runs. |
| `SUBSTRATE_SETTINGS` | File path | Path to an explicit JSONC settings file. |
| `SUBSTRATE_CONFIG_DIR` | Directory path | Path overriding the default user config directory (`~/.config/substrate`). |
| `SUBSTRATE_PROJECT_DIR` | Directory path | Path overriding the project root directory. |
| `SUBSTRATE_PERMISSION_MODE` | String literal | Overrides permission policy (`default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`). |
| `SUBSTRATE_MAX_BUDGET_USD` | Number string | Caps total run expenditure in USD (e.g., `10.50`). |
| `SUBSTRATE_OUTPUT_FORMAT` | String literal | Controls default stdout format (`text`, `json`, `stream-json`). |
| `SUBSTRATE_MODEL` | String | Overrides primary model used for planning and solo modes. |
| `SUBSTRATE_WORKER_MODEL` | String | Overrides the worker model across all task routing classes. |

---

## Settings Schema Reference

Below is the complete specification for all top-level keys in `Contracts.Settings`.

### `backends`

Configures the external peer CLI harnesses managed by the process supervisor.

```json
{
  "backends": {
    "claude": {
      "bin": "claude",
      "version_pin": "2.1.301",
      "max_concurrency": 4,
      "extra": { "omitClaudeMd": true }
    },
    "opencode": {
      "bin": "opencode",
      "version_pin": "2.0.21",
      "max_concurrency": 2
    },
    "agy": {
      "bin": "agy",
      "version_pin": "1.4.0",
      "max_concurrency": 3
    }
  }
}
```

- `bin` *(string, optional)*: Executable name or absolute binary path. Defaults to the backend identifier.
- `version_pin` *(string, optional)*: Semantic or exact version string checked during `substrate doctor`.
- `max_concurrency` *(integer, optional)*: Maximum simultaneous child processes allowed for this backend.
- `extra` *(record, optional)*: Harness-specific configuration parameters.

### `roles`

Defines routes and configurations for foundational orchestration roles.

```json
{
  "roles": {
    "planner": {
      "backend": "claude",
      "model": "claude-sonnet-5-5",
      "effort": "medium"
    },
    "reviewer": {
      "enabled": true,
      "backend": "claude",
      "model": "claude-haiku-5-5"
    },
    "governor": {
      "enabled": true,
      "endpoint": "http://127.0.0.1:8080/v1",
      "model": "local-governor",
      "enable_thinking": false,
      "timeout_s": 30,
      "max_clarifying_turns": 3
    }
  }
}
```

- `planner` *(Route)*: Backend, model, and effort level used to generate task manifests and specifications.
- `reviewer` *(Route, optional)*: Optional independent validation role that verifies task diffs prior to acceptance.
- `governor` *(object, optional)*: Optional front-door triage role running against a local or remote OpenAI-compatible endpoint.

### `routing`

Maps task classifications to specific harness routes, or defines model escalation ladders.

```json
{
  "routing": {
    "feature": {
      "backend": "claude",
      "model": "claude-sonnet-5-5",
      "effort": "medium",
      "budget": { "max_usd": 1.0 }
    },
    "fix": {
      "backend": "claude",
      "model": "claude-haiku-5-5",
      "effort": "low"
    },
    "escalation": ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
  }
}
```

- Each named property corresponds to a `TaskClass` (e.g. `feature`, `fix`, `refactor`, `test`, `chore`, `docs`).
- `escalation` *(array of strings)*: Sequence of model names used when recovering from verification failures.

### `pricing`

Authoritative token pricing table used to track usage and calculate dollar expenditures.

```json
{
  "pricing": {
    "asOf": "2026-10-16",
    "sources": ["https://anthropic.com/pricing", "https://openai.com/pricing"],
    "models": {
      "claude-sonnet-5-5": {
        "input_per_mtok": 3.0,
        "output_per_mtok": 15.0,
        "cache_read_per_mtok": 0.3,
        "cache_write_per_mtok": 3.75
      },
      "claude-haiku-5-5": {
        "input_per_mtok": 0.8,
        "output_per_mtok": 4.0,
        "cache_read_per_mtok": 0.08,
        "cache_write_per_mtok": 1.0
      }
    }
  }
}
```

- `asOf` *(string)*: ISO date when pricing values were last refreshed.
- `sources` *(array of strings)*: Upstream URLs documenting the token rates.
- `models` *(record)*: Token pricing rates per million tokens in USD (`input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok`).

### `budgets`

Resource constraints and execution guardrails preventing accidental overruns.

```json
{
  "budgets": {
    "run": {
      "max_usd": 15.0,
      "max_tokens": 5000000,
      "max_wall_min": 60
    },
    "task": {
      "max_usd": 1.5,
      "max_tokens": 500000,
      "timeout_min": 15,
      "max_turns": 30
    },
    "l1_replans_per_task": 2,
    "l2_per_run": 2,
    "planner_format_retries": 2,
    "approval_threshold_usd": 5.0
  }
}
```

- `run`: Total spend limits for an entire multi-task execution run (`max_usd`, `max_tokens`, `max_wall_min`).
- `task`: Default limits applied to individual worker tasks (`max_usd`, `max_tokens`, `timeout_min`, `max_turns`).
- `l1_replans_per_task` *(integer)*: Maximum healing and retry attempts allowed for a single task before failing.
- `l2_per_run` *(integer)*: Maximum full-manifest re-planning cycles allowed for an entire run.
- `planner_format_retries` *(integer)*: Retries granted to the planner if it produces invalid JSON or schema errors.
- `approval_threshold_usd` *(number)*: Estimated cost threshold that triggers mandatory human approval before proceeding.

### `concurrency`

Controls execution parallelism.

```json
{
  "concurrency": {
    "workers": 3
  }
}
```

- `workers` *(integer)*: Maximum number of worker tasks allowed to execute simultaneously across all worktrees.

### `permissions`

Declarative tool-calling permissions enforced across worker sessions.

```json
{
  "permissions": {
    "allow": ["Bash", "Read", "Write", "Glob"],
    "deny": [
      "Agent",
      "Agent(*)",
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git checkout*)",
      "Bash(git reset*)",
      "Bash(git rebase*)",
      "Bash(git clean*)",
      "Bash(git stash*)",
      "Bash(git merge*)",
      "WebFetch",
      "WebFetch(*)"
    ],
    "ask": ["Bash(curl*)"]
  }
}
```

- `allow` *(array of strings)*: Whitelist of allowed tool names or glob patterns.
- `deny` *(array of strings)*: Prohibited tool patterns. Substrate automatically rejects these calls without prompting.
- `ask` *(array of strings, optional)*: Tool patterns requiring explicit interactive approval.

### `sandbox`

Operating system sandbox isolation for worker task execution.

```json
{
  "sandbox": {
    "enabled": true,
    "network": "deny"
  }
}
```

- `enabled` *(boolean)*: When true on Linux hosts, runs worker processes inside a Bubblewrap (`bwrap`) container.
- `network` *(string: `"deny"` \| `"allow"`)*: Controls network namespace access inside the sandbox container.

### `git`

Git repository integration and worktree management policies.

```json
{
  "git": {
    "on_scope_violation": "revert",
    "branch_prefix": "substrate/",
    "auto_merge": false
  }
}
```

- `on_scope_violation` *(string: `"revert"` \| `"fail"`)*: Action taken when a worker modifies files outside its task spec write/create allowances.
- `branch_prefix` *(string)*: Prefix applied to temporary Git branches created for execution runs.
- `auto_merge` *(boolean)*: When true, automatically fast-forwards or merges completed run branches into the working branch if all verifications pass.

### `instructions`

Controls how project-level instruction files are injected into worker prompts.

```json
{
  "instructions": {
    "workers": "project"
  }
}
```

- `workers` *(string: `"none"` \| `"project"`)*: When `"none"`, workers receive only task spec frontmatter and rules. When `"project"`, workers also ingest repository instructions (e.g. `CLAUDE.md`, `AGENTS.md`).

### `execution`

Execution dispatcher strategy.

```json
{
  "execution": {
    "strategy": "direct"
  }
}
```

- `strategy` *(string: `"direct"` \| `"dispatcher"`)*: `"direct"` spawns individual external harness processes for each worker task via the process supervisor. `"dispatcher"` reserves future support for orchestrating subagents through a single parent harness.

### `hooks`

Lifecycle shell hooks triggered before and after orchestration phases.

```json
{
  "hooks": {
    "pre-plan": [
      { "command": "npm run lint:precheck", "timeout_s": 30 }
    ],
    "post-task": [
      { "command": "git diff --stat", "timeout_s": 10 }
    ],
    "pre-merge": [
      { "command": "npm run check:boundaries", "timeout_s": 60 }
    ]
  }
}
```

- Supported hook phases: `pre-plan`, `post-plan`, `pre-task`, `post-task`, `pre-merge`, `post-merge`.
- Each hook entry defines a `command` string and an optional `timeout_s` execution limit.

### `usage`

Global usage mirror configuration.

```json
{
  "usage": {
    "global": true
  }
}
```

- `global` *(boolean, default `true`)*: When `true`, usage records are mirrored to the global user state ledger file (`$XDG_STATE_HOME/substrate/usage.jsonl` or `~/.local/state/substrate/usage.jsonl`). When `false`, usage is only written to the project ledger (`.substrate/ledger/usage.jsonl`).

