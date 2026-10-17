#!/usr/bin/env bash
# Start the Substrate Build Orchestrator in OpenCode (interactive). First run only: git init on main + initial commit.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ ! -d "$REPO/.git" ]]; then
  git -C "$REPO" init -q -b main
  [[ -f "$REPO/.gitignore" ]] || printf 'node_modules/\n.worktrees/\n.substrate-task/\nbuild/state/\nbuild/reports/\nbuild/packets/\n.substrate/runs/\n.substrate/worktrees/\n' > "$REPO/.gitignore"
  git -C "$REPO" add -A
  git -C "$REPO" -c user.name=substrate-build -c user.email=build@substrate.local commit -qm "chore: plan, research and bootstrap kit"
  echo "launch: initialized a git repository on main (nothing is pushed anywhere)" >&2
fi
cd "$REPO" && exec opencode --standalone --auto --prompt "Begin: read ORCHESTRATOR-PROMPT.md and start at Step 0." "$@"
