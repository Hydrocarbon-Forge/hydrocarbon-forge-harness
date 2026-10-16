# OpenCode v2.0.21 agent loading: findings

## Root cause (confirmed)

1. **YAML parse failure.** Four agent files had an unquoted `description:` plain scalar containing `: `:
   `substrate-architect`, `substrate-reviewer`, `substrate-spec-writer`, `substrate-test-writer`.
   YAML rejects this (`mapping values are not allowed here`). OpenCode then loads the agent with defaults:
   `mode=primary`, `steps=None`, `model=null`. That is exactly the broken set in the report.
   - Evidence: `python3 -I` with PyYAML fails on exactly these four files.
   - Evidence: a fresh copy of the same unquoted files in a scratch git repo, run through `opencode debug agents`, shows exactly those four as `primary None None`. A copy with the descriptions double-quoted loads all nine correctly.

2. **The user's edits were reverted on disk.** The live orchestrator session (run `ea0a9694`, PID 582948) logged
   `git checkout -- ORCHESTRATOR-PROMPT.md SUBSTRATE-PLAN.md .claude/agents/ .opencode/agents/` at 2026-10-16 17:33:17.851Z.
   Afterwards the working tree matched HEAD (steps 30/60/100/30/15, unquoted descriptions). All nine agent files carry the same mtime, 17:33:17.85. Any uncommitted edits to those paths, including `SUBSTRATE-PLAN.md` and `ORCHESTRATOR-PROMPT.md`, were discarded by that command.

## Hypotheses tested

- **H1 (background service caches definitions): not supported.** After a file edit, `opencode debug agents` at the repo root reflected the new steps (40/100/200/60/25) within the same minute.
- **H2 (worktree copies override): not supported.** The repo listing has 16 entries with one of each substrate id. The `.worktrees/SMOKE` copies are not loaded.
- **H3 (frontmatter/YAML): confirmed** (see above).
- **H4 (other caches): not needed.**

## Caveats

- `opencode api --standalone agent.list --param "location[directory]=<dir>"` returns `data: []` every time, so it is not a usable oracle here. `opencode debug agents` is the working view. It appears to go through the background service, so I could not confirm it is independent of the service.
- The first `debug agents` call in a newly created scratch directory returned 0 agents once; repeated calls returned the full list.
- `opencode run --standalone --agent <id>` accepted `substrate-reviewer` and `substrate-researcher`. Its header label is the same for both, so it does not show the configured model.

## Fix applied

- Double-quoted the `description` value in all nine `.opencode/agents/substrate-*.md` files.
- Restored the step values the user reported: worker-s 40, worker-m 100, worker-l 200, test-writer 60, spec-writer 25.
- `.opencode/opencode.jsonc` was not changed.

## Verification

- PyYAML parses all nine files; modes and steps are as intended.
- `opencode debug agents` at the repo root lists all nine substrate agents with the intended mode, steps and model (`opencode/muse-spark-1.3-contributor-free#xhigh`).

## Running sessions

- Background service (PID 323062) and live session (PID 582948 with private server PID 582964, listening on 127.0.0.1:37505, password-protected) were not touched.
- The live session loaded its agent set at startup (about 17:14Z) and may hold the pre-fix definitions. Restart it, or start a new session, after committing the fix and making sure the orchestrator is idle. The orchestrator can run `git checkout` on these paths again, so commit the agent files first.
