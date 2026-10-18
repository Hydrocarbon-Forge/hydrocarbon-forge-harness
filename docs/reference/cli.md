# CLI Reference

Substrate provides a comprehensive command-line interface for running autonomous execution workflows, inspecting state, analyzing costs, and managing Git worktrees.

```text
Usage: substrate [command] [options] [arguments...]
```

---

## Global and Governance Flags

These flags can be applied to `substrate run`, `substrate plan`, and other execution subcommands:

| Flag | Type | Description |
|---|---|---|
| `-p`, `--print` | Boolean | Run headlessly and print the result to stdout. |
| `--output-format <format>` | String | Selects output format: `text` (human-readable), `json` (single structured payload), or `stream-json` (NDJSON stream). |
| `--model <model>` | String | Overrides the primary model used for planning, manifest generation, or solo mode. |
| `--worker-model <model>` | String | Overrides the worker model across all task routing classes. |
| `--effort <level>` | String | Reasoning effort level: `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--session-id <id>` | String | Explicit session identifier to bind or create. |
| `--resume <target>` | String | Resume an interrupted run or prior session from the JSONL event log by RunId or SessionId. |
| `-c`, `--continue` | Boolean | Automatically continue the most recently active session. |
| `--fork-session` | Boolean | Branch the state of an existing session into a new independent session. |
| `--mode <mode>` | String | Execution mode: `auto` (default DAG decomposition), `solo` (single-agent execution), or `plan` (planning only). |
| `--no-governor` | Boolean | Bypass local governor front-door triage and proceed directly to planning. |
| `--permission-mode <mode>` | String | Permission mode: `default`, `plan`, `acceptEdits`, `dontAsk`, or `bypassPermissions`. |
| `--max-budget-usd <amount>` | Number | Maximum cumulative spend limit in USD for the run before pausing. |
| `--timeout <seconds>` | Number | Overall wall-clock timeout limit in seconds. |
| `--sandbox` | Boolean | Enforce Bubblewrap OS-level sandbox isolation on worker commands. |
| `--settings <file>` | String | Path to custom JSONC configuration file. |
| `--allowed-tools <tools...>` | String[] | Explicit whitelist of allowed tool calls (repeatable or comma-separated). |
| `--disallowed-tools <tools...>` | String[] | Explicit blacklist of prohibited tool calls (repeatable or comma-separated). |

---

## Standard Exit Codes

Substrate adheres to deterministic process exit codes across headless and scripted environments:

| Exit Code | Classification | Meaning |
|---|---|---|
| `0` | **Success** | All planned tasks executed, passed acceptance verification, and merged. |
| `1` | **Run Failure** | A task verification failed, worker process crashed, spec invalid, or unrecoverable error. |
| `2` | **Usage / Config Error** | Invalid flags, unknown subcommand, syntax error, or settings validation error. |
| `3` | **Needs Human** | Execution paused requiring human approval (permission prompt, gate confirmation, budget escalation). |
| `4` | **Budget Exhausted** | Configured budget threshold reached (max USD, max tokens, or max wall-clock time). |
| `130` | **SIGINT Interruption** | Process interrupted by user keyboard signal (`Ctrl+C`). |
| `143` | **SIGTERM Termination** | Clean termination after receiving external operating system kill signal. |

---

## Subcommands

Substrate includes 20 specialized subcommands:

### run

Executes a goal prompt through deterministic DAG planning, isolated worker dispatch, and verification.

```bash
substrate run [options] "<prompt>"
```

- **Arguments**: Goal prompt describing the desired code change. If omitted in non-interactive mode, reads from standard input (`stdin`).
- **Options**: Accepts all Global and Governance flags.
- **Behavior**: If `--no-governor` is not specified, routes through the local triage governor. Then invokes the planner, creates isolated worktrees per task, executes worker sessions, gates merges on verification, and summarizes usage.

```bash
# Headless run with maximum budget cap
substrate run --max-budget-usd 5.0 -p "Add request rate limiter to server"
```

### plan

Generates a decomposed task manifest and runs specification linter without dispatching workers.

```bash
substrate plan [options] "<prompt>"
```

- **Arguments**: Goal prompt describing the feature or refactor.
- **Options**: `--model`, `--effort`, `--output-format`.
- **Behavior**: Calls the configured planner route, generates `.substrate-task/` specs, checks DAG acyclicity, runs spec linting rules, and computes pre-flight cost estimates.

```bash
substrate plan "Refactor database connection pooling"
```

### resume

Resumes an interrupted or paused run from its JSONL event log.

```bash
substrate resume [options] [run-id]
```

- **Arguments**: Optional `run-id` (e.g., `r_7ABCD234EF56`). If omitted, resumes the latest run in `.substrate/runs/`.
- **Behavior**: Reconstructs state from the append-only event log, validates existing task worktrees, escalates failed tasks according to the model ladder, and resumes uncompleted DAG nodes.

```bash
substrate resume r_ABC123DEF456
```

### status

Displays current execution status, task graph breakdown, and failure counts.

```bash
substrate status [options] [run-id]
```

- **Options**: `--output-format text|json`.
- **Behavior**: Replays events to show overall run state (`running`, `paused`, `finished`, `failed`), individual task states (`pending`, `running`, `passed`, `failed`), and pause reason.

```bash
substrate status
```

### tasks

Provides detailed inspection of individual tasks and isolated worktrees.

```bash
substrate tasks [options] [run-id]
```

- **Options**: `--task <task-id>`, `--output-format text|json`.
- **Behavior**: Prints task specification details, write allowances, dependency status, worktree path, attempt count, and verification outputs.

```bash
substrate tasks --task T1
```

### cost

Analyzes usage ledger and cost breakdown across roles, models, and tasks.

```bash
substrate cost [options] [run-id]
```

- **Options**: `--by role|model|task`, `--output-format text|json`.
- **Behavior**: Aggregates token usage (input, output, cache read/write) and USD costs, comparing reported amounts against the configured pricing table.

```bash
substrate cost --by model
```

### report

Generates a comprehensive execution summary report.

```bash
substrate report [options] [run-id]
```

- **Options**: `--output-format text|json`, `--file <path>`.
- **Behavior**: Exports summary of run metadata, duration, cost, task attempts, files modified, and verify command outcomes.

```bash
substrate report --output-format json
```

### verify

Re-runs acceptance verify commands inside a task's worktree.

```bash
substrate verify <task-id> [options]
```

- **Arguments**: `task-id` corresponding to a task spec.
- **Options**: `--run <id>`, `--timeout <seconds>`.
- **Behavior**: Executes all verify commands specified in the task frontmatter within the worktree environment, returning detailed exit codes and truncated tails.

```bash
substrate verify T1
```

### merge

Applies a completed run branch into the active working branch.

```bash
substrate merge [options] [run-id]
```

- **Options**: `--dry-run`, `--abort-on-conflict`.
- **Behavior**: Validates that all tasks passed integration verify, checks for scope violations, and fast-forwards or merges the run branch.

```bash
substrate merge
```

### undo

Reverts the most recently merged run batch.

```bash
substrate undo [options]
```

- **Options**: `--hard`.
- **Behavior**: Locates the merge commit produced by the previous `substrate merge` and safely reverts the changes while preserving unstaged working tree edits.

```bash
substrate undo
```

### discard

Cancels a run, cleans up working branches, and deletes task worktrees.

```bash
substrate discard [options] [run-id]
```

- **Options**: `--force`.
- **Behavior**: Kills any active child harness processes, marks the run cancelled in the event log, and removes worktree directories under `.substrate/worktrees/`.

```bash
substrate discard --force
```

### models

Lists configured models, pricing rates, and routing mappings.

```bash
substrate models [options]
```

- **Options**: `--output-format text|json`.
- **Behavior**: Dumps the effective pricing table and routing ladder configured in settings.

```bash
substrate models
```

### agents

Lists registered agent definitions and specialized role configurations.

```bash
substrate agents [options]
```

- **Behavior**: Scans project `.substrate/agents/` and global definitions, showing allowed tools, system prompts, and model bindings.

```bash
substrate agents
```

### backends

Displays adapter capabilities, version pins, and local CLI status.

```bash
substrate backends [options]
```

- **Behavior**: Queries each registered backend adapter (`claude`, `opencode`, `agy`, `fake`), runs `validateEnvironment()`, and displays version pin matches and capability flags.

```bash
substrate backends
```

### sessions

Lists interactive and headless agent sessions recorded in the session store.

```bash
substrate sessions [options]
```

- **Options**: `--limit <n>`, `--output-format text|json`.
- **Behavior**: Queries `.substrate/sessions/` and prints session IDs, timestamps, goals, total tokens, and exit statuses.

```bash
substrate sessions --limit 10
```

### config

Inspects or modifies settings key-value pairs.

```bash
substrate config <get|set|list> [key] [value]
```

- **Commands**:
  - `config list`: Prints the fully merged configuration object.
  - `config get <key>`: Prints a specific dotted key path (e.g. `budgets.run.max_usd`).
  - `config set <key> <value>`: Updates a configuration key in `.substrate/settings.json`.

```bash
substrate config get budgets.run.max_usd
substrate config set concurrency.workers 4
```

### doctor

Verifies system environment health, CLI harness versions, and sandboxing prerequisites.

```bash
substrate doctor
```

- **Behavior**: Checks Node.js version (>= 22), Git version (>= 2.30), Bubblewrap availability (`bwrap`), presence of peer CLI harnesses, and version pin drift. Exits 0 if all checks pass.

```bash
substrate doctor
```

### init

Scaffolds a new `.substrate/` configuration directory and template settings.

```bash
substrate init [options]
```

- **Options**: `--force` to overwrite existing configuration.
- **Behavior**: Creates `.substrate/settings.json` and `.substrate/settings.local.json`, populating them with sensible defaults and detecting available CLI harnesses.

```bash
substrate init
```

### bench

Runs benchmark evaluation harness across architectural comparison Arms A through D.

```bash
substrate bench [options]
```

- **Options**:
  - `--arms <A,B,C,D>`: Comma-separated list of arms to evaluate.
  - `--tasks <task...>`: Specific benchmark task IDs to run.
  - `--repetitions <n>`: Number of repetitions per arm/task combination (default: 3).
  - `--max-budget <usd>`: Cumulative budget limit for the benchmark suite.
  - `--format <text|json|markdown>`: Format of output evaluation report.
  - `--output <file>`: Write formatted benchmark report to specified file path.
  - `--dry-run`: Validate setup and tasks without invoking LLM harnesses.

```bash
substrate bench --arms A,C,D --repetitions 3 --output build/bench-report.md
```

### agents-import

Imports foreign agent definitions from Claude Code or OpenCode format into Substrate.

```bash
substrate agents-import [options]
# Alias: substrate agents:import
```

- **Options**:
  - `--from <claude|opencode>`: Source harness format to import from.
  - `--path <dir>`: Path to foreign agent definitions directory.
  - `--overwrite`: Overwrite existing agent files in `.substrate/agents/`.
- **Behavior**: Translates tool permissions, prompt templates, and model parameters into standardized Substrate agent manifests.

```bash
substrate agents-import --from claude
```
