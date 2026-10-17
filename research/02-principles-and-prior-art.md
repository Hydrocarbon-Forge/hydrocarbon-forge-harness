# Planner digest (read this instead of the rest)

Reddit thread: NOT RECOVERED (3 searches, no text, fetch blocked). Its principles are UNKNOWN here. Ask the user to paste the text.
Web budget spent: 12 of 12. Only 3 prior-art tools checked against primary sources.

## Top 12 principles (ranked)
1. Engine owns retry counters, cost caps and loop caps; never the worker or an LLM | DOCS-OPINION (eval loop needs external clear criteria) | unbounded loops, runaway spend.
2. Set an explicit model per worker from a routing table; never rely on inherit | DOCS: Claude Code subagents inherit main model by default | silent expensive workers.
3. Task spec with required, validated fields (objective, owned files, output shape, acceptance commands) | DOCS-OPINION (Anthropic multi-agent) | duplicated work, gaps.
4. Parallel only on disjoint owned-file sets, one worktree per task | DOCS-OPINION (coding has few parallelizable subtasks) | merge conflicts.
5. Context budget per task (files and bytes), atomic tasks | DOCS-OPINION (context rot; no rot figures given) | missed constraints.
6. Workers return a capped, structured packet; planner sees the packet, not the transcript | DOCS-OPINION (condensed 1-2k token summaries) | context blowup or lost detail.
7. Architect/editor split with a deterministic apply step | MEASURED (Aider, 2024 models): pass rate up about 3 to 10 points on listed pairs (e.g. o1-mini+DeepSeek 61.1 to 71.4; GPT-4o pair 71.4 to 75.2); no cost data | pair below solo baseline if the editor misformats edits.
8. Route by planner-set task-class label to fixed model (mechanical/search/boilerplate cheap; ambiguous/review top) | DOCS-OPINION (Anthropic routing) + UNVERIFIED heuristics | cheap model on ambiguous task, retry churn.
9. Budget multi-agent cost before fan-out (about 4x chat tokens for agents, about 15x for multi-agent) | MEASURED by Anthropic (their usage) | cost blowup.
10. Lead plus cheap workers beat a single top model on an internal research eval (+90.2%) | MEASURED, internal, research not coding | do not transfer the number to coding; measure on Substrate tasks.
11. Simplest path first: allow single-task runs with no orchestration | DOCS-OPINION (Anthropic) | orchestration overhead on trivial work.
12. Deterministic gate (tests, lint, typecheck, contract checks) as evaluator | DOCS-OPINION (evaluator-optimizer) | self-graded success.

## Prior-art comparison
| Tool | Dispatch | Isolation | Verification | Notes |
|---|---|---|---|---|
| Claude Code subagents | LLM (model calls Agent tool) | own context window; shared tree unless configured | UNKNOWN | per-subagent model; inherits by default |
| Roo Code Orchestrator | LLM (`new_task`) | own history; only summary returns | per-subtask approval (auto-approvable) | no documented cost, loop or depth limits |
| Aider architect | two models in one turn, no dispatcher | none described | benchmark only | measured pass-rate gains; no cost data |
| OpenHands, claude-squad, ccmanager, vibe-kanban, Conductor, oh-my-opencode, Gas Town, spec-kit | UNKNOWN | UNKNOWN | UNKNOWN | not researched (budget spent) |

## ACP answer
- Registry (fetched): Claude = "Claude Agent"; OpenCode listed; Gemini CLI listed; Antigravity listed as "Google Antigravity" (so "agy" is UNVERIFIED as the same product). [DOCS https://agentclientprotocol.com/registry/index]
- Claude Code itself is not listed under that name; the wrapper is. [UNVERIFIED on exact wrapper package]
- Adapters via ACP instead of per-CLI flags: plausible for the core path. Open questions: per-session model pinning, token/cost reporting, clean kill. Spike one task per tool before committing. Keep a thin fallback. [UNKNOWN for usage reporting]

## 5 pitfalls
1. Inherit-by-default model config silently puts the top model on every worker (P2).
2. Parallel dispatch without owned-file disjointness causes merge conflicts (P4).
3. A re-plan loop with no hard cap; none of Roo, Aider or Anthropic documents a cap in code (P1).
4. Worker self-verification treated as the verdict (P12 / Part 4-5).
5. Summary-only returns that drop facts the planner needs; set a schema for returns, not free text (P6).

## Part 4 verdicts
1. LLM mechanical dispatcher between engine and workers: CHALLENGED. Roo's LLM dispatch has no documented limits; keep dispatch in code.
2. Worker-enforced two-strike retry: CHALLENGED as worded. Engine must own the counter; worker only receives it. SUPPORTED if so.
3. Small local LLM for plan linting and routing: UNKNOWN. Deterministic checks cover the listed needs; add a model only where code cannot.
4. Planner never writes code (only contracts): SUPPORTED, with the caveat that the planner must still give exact interfaces/signatures.
5. Worker runs its own verification: CHALLENGED. Engine runs acceptance commands and owns the verdict; the worker may self-correct.

Detail: Part 1 (Reddit, not recovered), Part 2 (principles table, 6 sources), Part 3 (prior art, ACP, runaway control), Part 4 (verdicts) below.

# Part 1: Reference Reddit thread

Status: NOT RECOVERED.
- Search 1 (exact title + thread id): no Reddit result; returned generic third-party model-config guides (eesel.ai, feedbagel, skool, etc.). [UNVERIFIED secondary blogs]
- Search 2 (r/ClaudeCode + planner/worker phrasing): one Reddit hit, an unrelated self-promoted tool post (cc-fleet, running subagents on DeepSeek/GLM/Kimi). It is NOT the target thread and its content is not used. [UNVERIFIED]
- Search 3 (bare thread id "1vgfqbb"): no relevant match (returned unrelated pages).
- The fetch tool is policy-blocked for reddit.com; no proxies or mirrors were used.
- Consequence: the principles the user attributes to the thread are UNKNOWN. Nothing below is attributed to it. Ask the user to paste the thread text if they want those principles checked.

# Part 2: Principles for pairing top-tier and cheap models

Sources used (6 primary): Anthropic "Building effective agents"; Anthropic "How we built our multi-agent research system"; Claude Code model-config docs; Aider architect-mode post; Anthropic "Effective context engineering for AI agents"; Roo Code Boomerang/Orchestrator docs (redirected; see note under Part 3).

## 2.1 Principles table

Evidence key: MEASURED = reported numbers from an experiment; DOCS-OPINION = vendor engineering guidance, no controlled numbers; OPINION = practitioner heuristic.

P1. Give each delegated worker a specific brief: objective, output format, tools/sources, and task boundaries. [DOCS https://www.anthropic.com/engineering/multi-agent-research-system]
- Evidence: DOCS-OPINION (Anthropic lessons learned; vague instructions caused duplicated searches and coverage gaps).
- Failure when violated: duplicated work, gaps, workers redoing each other's job.
- Substrate, deterministic: task-spec schema with required fields (objective, owned files, forbidden files, output packet shape, acceptance commands). The engine rejects specs with missing fields before any spawn. Validation is code, not a prompt.

P2. Multi-agent systems are expensive: agents use about 4x chat tokens, multi-agent about 15x. Token use alone explained about 80% of performance variance on BrowseComp. [DOCS https://www.anthropic.com/engineering/multi-agent-research-system]
- Evidence: MEASURED by Anthropic on their own system (usage figures, not a controlled cost study).
- Failure when violated: unbounded fan-out and retry loops burn budget.
- Substrate: hard per-task and per-run token and cost caps. The engine reads usage from each CLI's output and kills the worker at the cap. The cap is a config value, not a model decision.

P3. Parallel sub-agents only pay off on parallelizable work. Coding tasks usually have fewer parallel subtasks than research; domains needing shared context or many inter-agent dependencies fit poorly. [DOCS multi-agent-research-system]
- Evidence: DOCS-OPINION.
- Failure when violated: workers collide on the same files and produce merge conflicts or inconsistent edits.
- Substrate: the planner emits a DAG with an explicit owned-file set per task. The engine dispatches in parallel only when owned-file sets are disjoint, with one git worktree per task.

P4. Context isolation: sub-agents explore in their own clean context and return a condensed summary (described as 1,000-2,000 tokens) while exploration may use tens of thousands. [DOCS https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents]
- Evidence: DOCS-OPINION; the token figures are Anthropic's description, not a controlled measurement.
- Failure when violated: the lead's context fills with raw search output and synthesis degrades.
- Substrate: worker returns a structured packet with a byte/token cap. The engine rejects or truncates oversize returns. Workers receive only the contract plus listed files, never the whole repo.

P5. Context rot: recall accuracy falls as the window fills; context is a "finite resource with diminishing marginal returns"; aim for the "smallest set of high-signal tokens." [DOCS effective-context-engineering]
- Evidence: DOCS-OPINION. The post gives no benchmark figures for rot.
- Failure when violated: missed constraints and stale instructions in long worker sessions.
- Substrate: engine computes a context budget per task from the file list (file count and bytes) and refuses specs that exceed it, forcing the planner to split the task. This is the atomic-task rule made enforceable.

P6. Routing: send easy or common inputs to cheap models and harder ones to capable models. The post's example is Haiku for easy and Sonnet for harder. [DOCS https://www.anthropic.com/engineering/building-effective-agents]
- Evidence: DOCS-OPINION (design guidance; no routing benchmark in the post).
- Failure when violated: a cheap model gets an ambiguous task and loops through self-heal retries.
- Substrate: a static routing table keyed by task-class labels that the planner writes into the spec (for example mechanical, boilerplate, search, ambiguous-debug, review). The engine maps label to model deterministically. No LLM classifier is needed to route.

P7. Architect/editor split: a reasoning model proposes the solution, a second model converts it into concrete file edits. [DOCS https://aider.chat/2024/09/26/architect.html]
- Evidence: MEASURED (Aider benchmark pass rates, 2024-era models, run by Aider). Selected results (pass rate, paired vs solo baseline):
  - o1-preview + DeepSeek (whole format): 85.0% (solo o1-preview 79.7%)
  - o1-preview + Claude 3.5 Sonnet (diff format): 82.7%
  - Claude 3.5 Sonnet pair: 80.5% (solo 77.4%)
  - GPT-4o pair: 75.2% (solo 71.4%)
  - o1-mini + DeepSeek (whole): 71.4% (solo 61.1%)
  - GPT-4o-mini pair: 60.2% (solo 55.6%)
- Caveats from the post: the best whole-format pairings are slow and "probably not practical for interactive use"; the post reports no cost figures; the feature is marked experimental.
- Failure when violated: the editor misformats edits and the pair ends up below the solo baseline. The gain is in pass rate, not guaranteed in cost.
- Substrate: the planner's output is structured edit instructions (or a contract with target symbols), and the worker applies them through a deterministic apply step. The engine verifies the applied diff against the contract, not the worker's prose.

P8. The evaluator-optimizer loop fits only when there are clear evaluation criteria and iteration adds measurable value. [DOCS building-effective-agents]
- Evidence: DOCS-OPINION.
- Failure when violated: unbounded refine loops with no measurable improvement.
- Substrate: the evaluator is a deterministic gate (tests, lint, typecheck, contract checks). The iteration count is a hard engine counter. This is the two-strike rule.

P9. Simplest solution first; agents trade latency and cost for performance and compound errors. [DOCS building-effective-agents]
- Evidence: DOCS-OPINION.
- Failure when violated: orchestration overhead on trivial tasks.
- Substrate: the planner may mark a task as single-step. The engine runs it without the planning ceremony. Orchestration is opt-in per plan.

P10. Subagent model selection is explicit configuration. Claude Code documents a per-subagent `model` field, a `CLAUDE_CODE_SUBAGENT_MODEL` env var, and an `opusplan` alias (Opus in plan mode, Sonnet for execution). By default subagents inherit the main conversation's model. [DOCS https://code.claude.com/docs/en/model-config]
- Evidence: documented behavior (config reference, not a measurement).
- Failure when violated: silent inheritance of the expensive model into every worker.
- Substrate: the engine always passes an explicit model per worker from the routing table and never relies on inherit. Accepted values for the frontmatter field were not visible in the fetched excerpt: UNKNOWN (check the full page before relying on it).

P11. Lead-plus-cheap-workers beats a single top model on research tasks (measured internally): an Opus 4 lead with Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on an internal research eval. [DOCS multi-agent-research-system]
- Evidence: MEASURED, internal eval, research domain, not coding. Do not transfer the magnitude to coding.
- Failure when violated: none shown; the caveat is domain transfer.
- Substrate: keep the pattern, measure it on Substrate's own tasks before claiming a benefit.

P12. Delegation heuristics (what to send to cheap models vs keep on the top model). Practitioner opinion, not measured here; [UNVERIFIED] unless noted.
- Delegate to cheap models: codebase search and exploration (Anthropic's docs list cheap models for routing exploration [DOCS multi-agent-research-system, opinion]); boilerplate; test writing from a fixed spec; mechanical refactors (rename, move, signature changes) that a deterministic check can verify; formatting and lint fixes.
- Keep on the top model: decomposition and the planner's contracts; architecture; ambiguous debugging with no reproduction; review and judgment calls; anything whose correct output the deterministic gate cannot check.
- Substrate: encode these as the routing-table labels in P6, set by the planner, not chosen per run by an LLM.

## 2.2 Concept check on the user's intuition

- The user's core split (expensive planner writes contracts, cheap workers implement in isolation) matches Anthropic's orchestrator-workers guidance [DOCS building-effective-agents] and the Aider architect/editor data [MEASURED]. Both support the pattern.
- Neither source measures the planner-writes-no-code rule. That is design opinion for Substrate and is treated as such in Part 4.

# Part 3: Prior art

Web budget was exhausted by Part 1 and Part 2 (12 of 12). Only 3 prior-art tools were checked against primary sources. Everything else is UNKNOWN for this session.

## 3.1 Tool comparison (only the three checked against primary sources)

- **Claude Code subagents / agent teams** [DOCS https://code.claude.com/docs/en/sub-agents, seen in search results, not fetched]
  - Dispatch: LLM dispatcher. The model invokes the Agent tool [DOCS model-config].
  - Isolation: subagents inherit the main conversation's model by default; per-subagent `model` field and `CLAUDE_CODE_SUBAGENT_MODEL` exist [DOCS model-config].
  - Verification and merge: UNKNOWN (not checked).
  - Known failure modes: UNKNOWN from this session.
- **Roo Code Orchestrator (Boomerang tasks)** [DOCS https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks, fetched after redirect from docs.roocode.com]
  - Dispatch: LLM dispatcher via the `new_task` tool (`mode`, `message` parameters).
  - Isolation: each subtask has its own conversation history; information goes down only through the instructions and comes back only through the `attempt_completion` summary.
  - Verification and gating: each subtask creation needs approval by default; can be auto-approved.
  - Cost controls: the page states NO limits on cost, loop count or nesting depth.
  - Merge handling: UNKNOWN.
- **Aider architect mode** [DOCS https://aider.chat/2024/09/26/architect.html]
  - Dispatch: no dispatcher. Two models in one turn (architect proposes, editor applies).
  - Isolation: none described. Edits apply to the working tree.
  - Verification: the benchmark only (pass rates, see P7). No runtime gate described in the post.
  - Cost: no cost figures in the post. The best whole-format pairs are slow.
- **OpenHands, claude-squad, ccmanager, vibe-kanban, Conductor, oh-my-opencode, Gas Town, GitHub spec-kit**: UNKNOWN. Not researched this session because the web budget was spent. Do not rely on any claim about them from this file.

## 3.2 Agent Client Protocol (ACP) answer

- What it is: an open standard (created by Zed Industries) for connecting coding agents to clients, using JSON-RPC 2.0 over stdin/stdout [UNVERIFIED search snippet; the registry is DOCS below].
- Registry status [DOCS https://agentclientprotocol.com/registry/index, fetched]:
  - **Claude**: listed as "Claude Agent" (ACP wrapper for Anthropic's Claude). A "Claude Code" entry was not seen under that name. The VS Code ACP extension defaults to `@agentclientprotocol/claude-agent-acp` [UNVERIFIED, from third-party extension page].
  - **OpenCode**: listed. Launch command seen in a third-party extension: `npx opencode-ai@latest acp` [UNVERIFIED].
  - **Gemini CLI**: listed.
  - **Antigravity (agy)**: listed as "Google Antigravity." The registry does not use the abbreviation "agy." Treat "agy = Google Antigravity" as UNVERIFIED.
- Could Substrate adapters use ACP instead of per-CLI flags? Likely yes for the core path, with caveats:
  - ACP is designed for editor-to-agent use, so Substrate would act as the ACP client and must handle permission requests and file-operation callbacks itself.
  - Whether ACP exposes per-session model selection, token/cost usage reporting and clean headless termination for all three tools: UNKNOWN. These are the features the engine needs for P2 and P10.
  - Recommendation: a one-day spike that runs one task per tool through ACP and checks usage reporting, model pinning and kill behavior. Keep a thin per-CLI fallback until the spike passes.

## 3.3 How others stop runaway cost and re-plan loops

- Roo Code: no documented cost, loop or depth limit; the only control is per-subtask approval [DOCS, fetched].
- Aider: no loop control described in the architect post [DOCS, fetched].
- Anthropic multi-agent post: names token cost and compounding errors as costs but describes no stop mechanism [DOCS, fetched].
- Claude Code, OpenHands and the others: UNKNOWN.
- Practical reading: none of the three documented tools enforces a hard budget or re-plan cap in code. Substrate's engine-owned counters would be ahead of the documented examples; that is an absence of evidence, not proof no tool has them.

# Part 4: Verdicts on the user's plan

1. **LLM "mechanical dispatcher" between engine and workers: CHALLENGED.** Roo's LLM dispatcher has no documented cost or loop limits [DOCS, fetched], and Anthropic's guidance frames orchestrator LLMs as a choice for ambiguous decomposition, not for mechanical dispatch [DOCS building-effective-agents]. A model in the dispatch path adds cost and nondeterminism with no measured benefit found. Keep dispatch in code.
2. **Worker-enforced two-strike retry: CHALLENGED as worded.** The evaluator-optimizer pattern needs external, clear criteria [DOCS building-effective-agents]. If the worker counts its own strikes, the count is not reliable. SUPPORTED if the engine owns the counter and the gate, and the worker only receives the strike count.
3. **Small local LLM for plan linting and routing: UNKNOWN.** No evidence gathered. The checks Substrate needs (schema, owned-file disjointness, context budget, routing label to model) are deterministic (P1, P3, P5, P6). Default to code; add a local model only if a specific check cannot be written deterministically.
4. **Planner never writes code (only contracts): SUPPORTED, with a caveat.** Aider's split (architect describes the change, editor applies it) is measured to help pass rates [MEASURED, Aider]. The caveat: the planner still has to give precise interfaces and signatures. Otherwise the worker's ambiguity recreates the failure. The "never writes code" rule itself is design opinion.
5. **Verification run by the worker itself: CHALLENGED.** Anthropic's evaluator-optimizer depends on a separate evaluation step with clear criteria [DOCS building-effective-agents]. The worker may run acceptance commands to self-correct. The pass/fail verdict must come from the engine running the commands itself, or the gate is self-reported.

<!-- END-PART-2 -->
