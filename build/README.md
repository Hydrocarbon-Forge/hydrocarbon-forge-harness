# build/ (legacy bootstrap kit)

This directory was used to build the first version of Substrate with an orchestrator agent and subagents. **The R-series work (`docs/plan/`) does not use it.** Do not run `build/tools/*`, do not create specs here, and do not edit anything here.

What is kept and why:
- `specs/P*.md`, `specs/B2-*.md`: the specs of the 24 merged original work packages. Useful as examples of the spec format and as history. `docs/plan/wp/*.md` use the same format.
- `tools/`: the bootstrap tools (`state.mjs`, `wt.mjs`, `merge.mjs`, `scope.mjs`, ...). Some of their tests (`*.test.mjs`) are not run by `npm test`.

What was retired to `docs/archive/bootstrap/`: the orchestrator agent definitions for Claude Code and OpenCode, the launch scripts, the orchestrator prompt, and the incident notes. To restore them, `git mv` them back; nothing else depends on them.
