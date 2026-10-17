#!/usr/bin/env bash
# Launch the Substrate Build Orchestrator.
# First run only: git init on main, a .gitignore and an initial commit (Step B1; nothing is pushed anywhere).
# The session must run in --permission-mode default: with acceptEdits/auto/bypassPermissions Claude Code ignores
# the subagents' permissionMode.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ ! -d "$REPO/.git" ]]; then
  git -C "$REPO" init -q -b main
  [[ -f "$REPO/.gitignore" ]] || printf 'node_modules/\n.worktrees/\n.substrate-task/\nbuild/state/\nbuild/reports/\nbuild/packets/\n.substrate/runs/\n.substrate/worktrees/\n' > "$REPO/.gitignore"
  git -C "$REPO" add -A
  git -C "$REPO" -c user.name=substrate-build -c user.email=build@substrate.local commit -qm "chore: plan, research and bootstrap kit"
  echo "launch: initialized a git repository on main (nothing is pushed anywhere)" >&2
fi
CLAUDE_ARGS=(--model sonnet --effort medium --permission-mode default --settings "$REPO/build/orchestrator/settings.json")
cd "$REPO" && exec claude "${CLAUDE_ARGS[@]}" "$@"
