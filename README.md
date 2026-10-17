# Substrate

Substrate is a deterministic orchestration engine that drives external peer agent harnesses (Claude Code, OpenCode, Antigravity) without privileged backends. It provides structured task planning, isolated git worktrees, automated verification gates, append-only event logging, and cost accounting, while delegating code generation and reasoning to external command-line agent harnesses running as unprivileged peers.

---

## Architecture Overview

Substrate treats all AI coding agents as symmetric, interchangeable peers. Substrate does not include an embedded language model runtime or proprietary cloud backend. Instead, it supervises external CLI harnesses through standardized process adapters.

```text
┌──────────────────────────────────────────────────────────────┐
│                    Substrate Engine Core                     │
│                                                              │
│  ┌────────────────┐   ┌────────────────┐   ┌──────────────┐  │
│  │   State Core   │   │ Git Workspace  │   │ Usage Ledger │  │
│  │ JSONL Event Log│   │ Task Worktrees │   │  Cost & USD  │  │
│  │ DAG Scheduler  │   │ Scope Checker  │   │  Token Caps  │  │
│  │ Ladder Reducer │   │   Merge Gate   │   │ Pricing Table│  │
│  └────────────────┘   └────────────────┘   └──────────────┘  │
└───────────────────────────────┬──────────────────────────────┘
                                │ Process Supervisor
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│ Claude Code  │        │   OpenCode   │        │ Antigravity  │
│  Adapter     │        │   Adapter    │        │  Adapter     │
│ (`claude`)   │        │ (`opencode`) │        │   (`agy`)    │
└──────────────┘        └──────────────┘        └──────────────┘
```

### Core Subsystems

1. **State Core**:
   - **JSONL Event Log**: Append-only event store recording every engine decision, tool invocation, and backend event.
   - **DAG Scheduler**: Computes dependency graphs and dispatches independent worker tasks concurrently.
   - **Ladder Reducer**: Manages escalating model attempts across L1 task replanning and L2 run re-architecting.
   - **Ledger**: Tracks exact token usage (input, output, cache read/write, reasoning) and USD costs per role, task, and model.

2. **Git Workspace**:
   - **Task Worktrees**: Spawns isolated Git worktrees per task to eliminate workspace collisions between parallel workers.
   - **Scope Checker**: Strictly enforces the declarative write and create file allowances specified in task specs.
   - **Merge Gate**: Validates all task acceptance verify commands before merging task branches into the run branch.

3. **Backends & Adapters**:
   - **Process Supervisor**: Spawns and monitors external harness processes with timeout, cancellation, and signal forwarding.
   - **Normalizers**: Translates disparate NDJSON and stdout streams into unified typed `BackendEvent` streams.
   - **Adapters**: Concrete implementations for Claude Code (`claude`), OpenCode (`opencode`), Antigravity (`agy`), and deterministic simulation (`fake`).

4. **Roles**:
   - **Governor**: Optional local triage front door that clarifies ambiguous goals and routes tasks.
   - **Planner**: Deconstructs goals into typed DAG manifests and declarative task specifications.
   - **Worker**: Executes implementation tasks inside isolated worktrees under strict tool permissions.
   - **Reviewer / Test-Writer**: Independent roles validating work products before acceptance.

5. **Surface**:
   - **Headless CLI**: Scriptable command-line interface with text, JSON, and NDJSON streaming outputs.
   - **Interactive TUI**: Terminal user interface for live run monitoring, task inspection, and steering.

---

## Prerequisites

- **Node.js**: Version 22.0.0 or higher.
- **Git**: Version 2.30.0 or higher.
- **Peer CLI Harness**: At least one of the following installed and authenticated in your `PATH`:
  - [Claude Code](https://github.com/anthropics/claude-code) (`claude`)
  - [OpenCode](https://github.com/opencode-ai/opencode) (`opencode`)
  - [Antigravity](https://github.com/google/antigravity) (`agy`)

---

## Quickstart

### 1. Install Substrate

```bash
git clone https://github.com/HydrocarbonForge/substrate.git
cd substrate
npm install
```

### 2. Initialize Project Configuration

Scaffold project settings in `.substrate/settings.json`:

```bash
bin/substrate.mjs init
```

### 3. Verify Environment Health

Run the diagnostic suite to confirm installed CLI tools, version pins, and sandbox readiness:

```bash
bin/substrate.mjs doctor
```

### 4. Execute Your First Run

Execute a goal prompt in headless mode:

```bash
bin/substrate.mjs run "Add health check endpoint to HTTP server"
```

Or start the interactive terminal interface:

```bash
bin/substrate.mjs "Refactor authentication middleware"
```

---

## CLI Usage Guide

Substrate provides both headless automation and interactive modes.

### Headless Execution

Use the `run` command or the `-p` / `--print` flag for headless execution in CI or automation pipelines:

```bash
# Execute with default settings
bin/substrate.mjs run "Implement user login endpoint"

# Headless run with stream-json output
bin/substrate.mjs run --output-format stream-json "Fix database migration typo"
```

### Planning Without Execution

To generate a task manifest and lint specifications without dispatching worker tasks:

```bash
bin/substrate.mjs plan "Refactor payment processing module"
```

### Common Execution Flags

- `-p`, `--print`: Execute headlessly and write output to stdout/stderr.
- `--output-format <format>`: Format output as `text`, `json`, or `stream-json`.
- `--model <model>`: Specify primary model for planning or solo mode.
- `--worker-model <model>`: Override model used by worker tasks.
- `--effort <level>`: Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`).
- `-w`, `--worktree`: Enforce isolated git worktrees for tasks.
- `--sandbox`: Enforce bubblewrap sandbox isolation.
- `--max-budget-usd <amount>`: Set maximum USD spend limit for the run.
- `--permission-mode <mode>`: Configure tool permission policy (`default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`).
- `--no-governor`: Bypass local governor triage and proceed directly to planning.

### Session Continuation and Resumption

```bash
# Continue the most recent session
bin/substrate.mjs run --continue

# Resume a specific session or run ID from event log
bin/substrate.mjs resume --session-id s_1234567890

# Fork an existing session into a new branch
bin/substrate.mjs run --resume r_ABCDEF123456 --fork-session
```

For complete documentation of all 20 subcommands and options, see the [CLI Reference](docs/reference/cli.md).

---

## Configuration Summary

Substrate resolves configuration using a strict 7-layer precedence hierarchy:

1. **Embedded Defaults**: Internal fallback settings (`DEFAULT_SETTINGS`).
2. **User Global Settings**: `~/.config/substrate/settings.json`.
3. **Project Settings**: `.substrate/settings.json`.
4. **Project Local Overrides**: `.substrate/settings.local.json` (git-ignored).
5. **CLI Settings File**: Specified via `--settings <file>`.
6. **Environment Variables**: Overrides prefixed with `SUBSTRATE_*`.
7. **CLI Flags**: Command-line arguments (e.g., `--model`, `--max-budget-usd`).

### Example Configuration (`.substrate/settings.json`)

```json
{
  "backends": {
    "claude": {
      "bin": "claude",
      "version_pin": "2.1.301",
      "max_concurrency": 4
    }
  },
  "roles": {
    "planner": {
      "backend": "claude",
      "model": "claude-sonnet-5-5",
      "effort": "medium"
    }
  },
  "routing": {
    "feature": {
      "backend": "claude",
      "model": "claude-sonnet-5-5",
      "effort": "medium"
    },
    "escalation": ["haiku", "sonnet", "opus"]
  },
  "budgets": {
    "run": { "max_usd": 10.0 },
    "task": { "max_usd": 1.5 },
    "l1_replans_per_task": 2,
    "l2_per_run": 2,
    "planner_format_retries": 2,
    "approval_threshold_usd": 5.0
  },
  "concurrency": {
    "workers": 3
  },
  "permissions": {
    "allow": ["Bash", "Read", "Write"],
    "deny": ["Agent", "Bash(git push*)"]
  },
  "sandbox": {
    "enabled": true,
    "network": "deny"
  },
  "git": {
    "on_scope_violation": "revert",
    "branch_prefix": "substrate/",
    "auto_merge": false
  },
  "instructions": {
    "workers": "project"
  },
  "execution": {
    "strategy": "direct"
  }
}
```

For full schema details, merging rules, and environment variable references, see the [Configuration Reference](docs/reference/config.md).

---

## Benchmark Summary

Substrate includes an evaluation harness comparing four architectural paradigms across reproducible software engineering tasks:

- **Arm A (Unconstrained Baseline)**: A single unconstrained agent working directly in the project root with full git and tool access.
- **Arm B (Spec-Guided Solo)**: A single agent operating sequentially under declarative task specifications.
- **Arm C (Substrate Decomposed Workers)**: Substrate DAG orchestration executing isolated tasks with automated verify gates using a single model.
- **Arm D (Substrate Heterogeneous Routing)**: Full Substrate system with frontier planner decomposition and cost-optimized worker routing.

### Running Benchmarks

```bash
# Run benchmark suite across all arms
bin/substrate.mjs bench --arms A,B,C,D --repetitions 3

# Run benchmark in dry-run mode
bin/substrate.mjs bench --dry-run
```

---

## Detailed References

- [Configuration Reference](docs/reference/config.md): Complete schema documentation for `settings.json`, environment variables, and merge semantics.
- [CLI Reference](docs/reference/cli.md): Reference covering all 20 CLI commands, flags, and exit codes.
- [Adapter Guide](docs/reference/adapters.md): Harness adapter architecture, protocol obligations, and test conformance.
