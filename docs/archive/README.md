# Archive

Frozen history. **Do not implement from anything here.** Files are kept so the reasoning is recoverable.

- `PLAN-v1-valence.md`: the first plan draft (local model as outer governor); superseded.
- `REMEDIATION-PLAN-draft.md`: the first draft of the fix plan, replaced by `docs/plan/`.
- `security-review.md`: the P6.2 security review; security is out of scope (`docs/plan/DECISIONS.md` A6).
- `bootstrap/`: the retired build orchestrator: agent definitions for Claude Code (`claude-agents/`) and OpenCode (`opencode-dotdir/`, which is the old `.opencode/` directory including its `default_agent` setting), launch scripts (`orchestrator/`), the orchestrator prompt, the OpenCode agent-loading incident note, and the bootstrap smoke spec.

To restore any of it, `git mv` it back to its original location (listed in the `git log` of this commit).
