<p align="center"><b>A cheap, reliable coding CLI: one strong planner model, cheaper worker models.</b></p>

<p align="center">
<a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

---

# Substrate

Substrate is a command-line tool that gets coding work done cheaply and reliably. A caller (an AI agent or a person) gives it a coding request. One strong **planner** model turns the request into a plan. Cheaper **worker** models carry out the plan's tasks, one headless process of an existing harness per task, each in its own git worktree. The engine (ordinary code, not an AI) runs real verify commands on every task and merges only the tasks that pass. Substrate also reports which models exist, and the tokens and cost each model used.

Substrate drives three existing harnesses: Claude Code (`claude`), OpenCode (`opencode`) and Antigravity (`agy`).

## Requirements

- Node.js 22 or newer
- git 2.30 or newer, and a git repository to work in
- At least one of the harness CLIs. `substrate doctor` says which ones are missing.
- bubblewrap (`bwrap`) only if you turn the sandbox on. It is off by default.

## Install and build

The package is private and is not published. Run it from the repository:

```bash
npm install          # its prepare script runs "npm run bundle", which writes dist/substrate.mjs
node bin/substrate.mjs --help
```

`bin/substrate.mjs` loads `dist/substrate.mjs`. Rebuild with `npm run bundle` after a source change.

## Quickstart

In the examples below, `substrate` stands for `node bin/substrate.mjs`. Run them inside a git repository.

```bash
substrate init                                              # creates .substrate/ and its .gitignore
substrate doctor                                            # checks Node, git, harness versions and pins
substrate models                                            # lists the models of each installed provider
substrate init --provider claude --plan opus:high --work sonnet:medium   # choose the planner and worker models
substrate run --plan claude:opus --work claude:sonnet "Add a request rate limiter to the server"    # runs a real plan and spends tokens
```

`init` with no slot flags writes nothing but the runtime directories, the `.gitignore` and the charter stub. `doctor` exits 1 when a check fails, and each failed check prints a `fix:` line.

## Commands

| Command | What it does |
|---|---|
| `run` | Plan, run workers, verify and merge a goal. Also takes a JSON request file. |
| `plan` | Run the planner only and stop before any worker starts. |
| `resume` | Continue a paused or interrupted run, or answer its questions with `--answers`. |
| `status`, `tasks`, `report` | Inspect a run: its state, its tasks, a diagnostic report. |
| `watch`, `runs` | Follow a run from another terminal, at any time; list the runs in this project and their status. |
| `verify` | Re-run one task's verify commands in its worktree. |
| `merge`, `undo`, `discard` | Merge a finished run, revert the last merged batch, or remove a run. |
| `models` | List models per provider, with prices and profile slots. `--stats` shows per-model results. |
| `usage` (alias `cost`) | Tokens and cost from the usage ledger, grouped by model, provider, role, run, task, class or day. |
| `agents`, `backends`, `sessions` | List agent prompts, harness versions and capabilities, and recorded sessions. |
| `config` | Read or set a value in the project's settings. |
| `doctor`, `init` | Check the environment. Create the `.substrate/` workspace and profiles. |
| `charter`, `history`, `archive`, `gc` | Project charter and versions. Archive finished runs and clean up their raw data. |
| `bench` | Run the benchmark tasks in `bench/`. See the limits described in the CLI reference. |

Every command, option and exit code is in [docs/reference/cli.md](docs/reference/cli.md).

## Configuration

Settings come from several layers. The layers, their order and every settings key are in [docs/reference/config.md](docs/reference/config.md). Harness adapters and their version pins are in [docs/reference/adapters.md](docs/reference/adapters.md), and the local model route is in [docs/reference/local-model.md](docs/reference/local-model.md).

## For AI agent callers

If you are an agent that calls Substrate, read [docs/reference/caller-guide.md](docs/reference/caller-guide.md) first. It shows how to check readiness, choose models, send a request, answer questions from a paused run, read usage, and what each exit code means.

Hermes and other agents that manage Substrate projects on a user's behalf should also read [docs/reference/hermes-guide.md](docs/reference/hermes-guide.md).

## Contributing

Contributors start at [START-HERE.md](START-HERE.md). Binding design decisions are in [docs/plan/DECISIONS.md](docs/plan/DECISIONS.md).
