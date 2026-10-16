# S3: Antigravity (agy) headless contract (spike, Tier H)

## Planner digest

- Versions: agy 1.4.0 [LOCAL `agy --version`]; models at probe time: gemini-3.8-flash-low/med/high,
  claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium [LOCAL `agy models`].
  Docs now list gemini-4-argon-* (not in local `agy models`) [DOCS https://antigravity.google/docs/cli/headless].
- (a) `agy -p ... --output-format stream-json`: NDJSON `init` -> `step_update`* -> `result`;
  event key is `event` (not `type`); id field is `conversation_id` (top-level on init,
  nested under payload on step_update/result) [LOCAL + DOCS headless].
- (b) Soft-deny is EXACT and VERIFIED: exit 0, `result.status SUCCESS` + `denied_actions`,
  tool step ACTIVE->DONE with no output, stderr `jetski: no output produced ...` [LOCAL].
  Resume via `--conversation <id>` verified (same id, step_index continues, `num_turns`
  cumulative, recall correct); `-c/--continue` untested live, docs claim "most recent" [LOCAL/DOCS].
- (c) `--sandbox` (default off) is OS isolation (Linux namespaces), NOT a permission grant:
  sandboxed touch-probe still soft-denied, file absent, exit 0 [LOCAL + DOCS https://antigravity.google/docs/sandbox/].
  Sandbox allowlist derives from `permissions` config; `toolPermission: proceed-in-sandbox`
  lets sandboxed cmds auto-run; `unsandboxed(...)` escape hatch [DOCS sandbox].
- (d) CONFLICT CONFIRMED: docs say `--effort low|medium|high` [DOCS headless flag table]
  but 1.4.0 `--help` accepts `low|medium|high|xhigh|max` [LOCAL]. `--effort max` +
  `gemini-3.8-flash-low` rejected: exit 1, `result.status ERROR`,
  `error: invalid model selection ... conflicts with --effort=max` [LOCAL].
  Effort is model-constrained (slugs embed tier); xhigh untested -> UNKNOWN if any model accepts it.
- (e) Agents: `.agents/agents/<n>.md` or `<n>/agent.md` (workspace), `~/.gemini/config/agents/`
  (global); frontmatter name/description required, tools/model/skills optional; nesting depth cap 10
  [DOCS https://antigravity.google/docs/subagents/]. `agy agents` returns NOTHING locally [LOCAL].
  Skills: `<root>/.agents/skills/`, `~/.gemini/antigravity-cli/skills/`, plugin skills;
  `SKILL.md` + name/description frontmatter [DOCS https://antigravity.google/docs/skills/].
  `~/.agents/skills/` exists locally but is NOT in CLI docs -> load path UNVERIFIED for CLI.
  Instruction file (GEMINI.md/AGENTS.md): UNKNOWN (no such file in ~, repo, or run dirs; not in docs fetched).
- OVERHEAD (trivial `OK`, minimal config): input_tokens **11,827** (no cache reads; tokens only, no cost field) [LOCAL].
- Fixtures in `test/fixtures/backends/agy/`: success, denial (+stderr), sandbox,
  effort-error (+stderr), session-create, session-resume (.ndjson raw stream-json) [LOCAL].
- Spend: 6/6 live calls (flash-low), 4/8 web fetches. No bypass flags (`--dangerously-skip-permissions` never used).

## (a) Minimal context + stream-json shape

- Minimal-context levers available on 1.4.0 [LOCAL `--help`]: `--effort low`, `--model <slug>`,
  `--disable-slash-commands`, `--mode plan|accept-edits|auto`. There is NO `--tools`/`--bare`
  equivalent, so the ~60-tool `init.tools` list cannot be stripped.
- Measured floor (empty cwd `/tmp/opencode/agy-min`, no GEMINI/AGENTS.md anywhere in ancestry,
  flash-low, effort low, mode plan + disable-slash-commands): `usage.input_tokens 11827`,
  output 13, thinking 12, cache_read 0 [LOCAL call 1]. NOTE: stderr warned
  `--mode plan has no effect while slash command expansion is disabled`, so effective
  permission_mode stayed `request-review`. Same-shape run without those flags: 11835 in-tokens
  [LOCAL call 5]. Floor is therefore ~11.8k regardless; tools/system prompt dominate.
- Stream shape (trivial OK, 5 events) [LOCAL fixture success.ndjson]:
  `init` (conversation_id top-level; init{model, cwd, tools[~60], permission_mode}) ->
  `step_update` user_input DONE -> `step_update` agent_response ACTIVE text_delta "OK" ->
  agent_response DONE (+usage, duration) -> `result` {conversation_id, SUCCESS, response "OK\n",
  duration_seconds, num_turns 1, usage}. No cost field anywhere; adapter must compute cost.
- `permission_mode` in init: `request-review` default; `always-proceed` under
  `--dangerously-skip-permissions` [DOCS headless]. `init` omits `model`/`agent` unless overridden.

## (b) Soft-deny text + resume

- Deny probe (touch file, default policy, no allow-rules) [LOCAL call 2, fixtures denial.ndjson/.stderr.txt]:
  - Stream: `... tool ACTIVE run_command{CommandLine: touch ...}` -> `tool DONE` (no output/error keys)
    -> `result {status SUCCESS, response "", num_turns 1, denied_actions: [{action: "command",
    display_name: "RunCommand"}]}`. Run continues, **exit 0**, file absent.
  - stderr EXACT: `jetski: no output produced — a tool required the "command" permission that
    headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under
    permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with
    --dangerously-skip-permissions to auto-approve all tools.`
  - Rule (matches docs: workspace reads/writes auto-allowed, shell defaults Ask)
    [DOCS headless]: adapter must parse `denied_actions` + this stderr note; exit code alone
    hides the denial. `response` may be EMPTY (model got no tool output and said nothing).
- Conversation capture/resume [LOCAL calls 5-6, fixtures session-create/session-resume.ndjson]:
  - Create run returns `conversation_id 57faeed3-...` on init AND result; resume with
    `agy --conversation 57faeed3-... -p "..."` in a NEW process: init echoes the SAME id,
    step_index continues (2,3,4 incl. a `system_message` step), `num_turns 2`,
    `usage` CUMULATIVE (input 23884 = 11835 + 12049), recall correct (`BRAVO-42`), exit 0, empty stderr.
  - `-c/--continue` (most recent) NOT tested live (budget exhausted); docs claim it continues
    the latest conversation [DOCS headless]. Multi-turn single-process via
    `--input-format stream-json` stdin NDJSON NOT tested [DOCS headless].
  - Local conversation store: `~/.gemini/antigravity-cli/conversations/*.db` + `annotations/*.pbtxt`
    (our conv ids present) [LOCAL].

## (c) Sandbox semantics

- Flag: `--sandbox` boolean, default false [LOCAL `--help`; DOCS headless flag table:
  "Run with terminal sandbox restrictions enabled"].
- Mechanism: OS-level isolation (Linux: kernel namespaces for fs/process/net; macOS: sandbox-exec/Seatbelt);
  no VMs/images, no startup delay. Sandboxed cmds can write workspace/tmp/build caches, read
  /usr//etc; `~/.ssh`, `.env` blocked; unmounted paths invisible; net limited to approved domains
  [DOCS https://antigravity.google/docs/sandbox/].
- CLI config: `{"enableTerminalSandbox": true, "toolPermission": "proceed-in-sandbox"}`
  in `~/.gemini/antigravity-cli/settings.json`; `--sandbox` overrides settings for the session
  [DOCS sandbox]. Local settings.json currently has NO sandbox/permissions keys [LOCAL].
- Permissions integration: sandbox mounts derive from `permissions` rules (write_file -> rw,
  read_file -> ro, read_url -> net allowlist); `unsandboxed(<cmd>)` rules run outside sandbox;
  agent sandbox-bypass requests always prompt (N/A headless: soft-deny instead) [DOCS sandbox].
- LIVE: `--sandbox` + touch probe behaved IDENTICALLY to no-sandbox: soft-denied, file absent,
  exit 0, same stderr, `denied_actions[command/RunCommand]` [LOCAL call 3, fixture sandbox.ndjson].
  Sandbox input_tokens were 12630 vs 11857 (sandbox adds ~800 tokens of context).
  CONCLUSION: `--sandbox` adds terminal restrictions but grants NO permission; a Substrate adapter
  still needs `permissions.allow command(...)` rules or the run silently does nothing.

## (d) Effort values (docs vs --help conflict)

- Docs (headless flag reference): `--effort`: `low`, `medium`, or `high` [DOCS headless].
  1.4.0 `--help`: `--effort (low|medium|high|xhigh|max)` [LOCAL]. CONFLICT stands as documented.
- LIVE: `--effort max` + `--model gemini-3.8-flash-low` -> exit 1; single `result` event
  `{status ERROR, conversation_id "", error: "invalid model selection (--model
  \"gemini-3.8-flash-low\" --effort \"max\"): --model gemini-3.8-flash-low conflicts with
  --effort=max", usage all zeros}`; stderr `error: invalid model selection ...` [LOCAL call 4,
  fixtures effort-error.ndjson/.stderr.txt]. Same envelope shape as unknown-model error [DOCS headless].
- Interpretation: flag parser accepts xhigh/max but the model<->effort mapping rejects them per
  slug (model names embed their tier: flash-low/med/high). `agy models` lists NO xhigh/max slug
  [LOCAL]. `--effort xhigh` untested (live budget exhausted) -> UNKNOWN whether any slug accepts it.
  Adapter: pin `--effort low|medium|high` matching the model slug tier; treat xhigh/max as unsupported
  on 1.4.0 until proven otherwise.
- Related conflict (noted, not live-tested): `--print-timeout` default is `5m` per docs
  [DOCS headless] vs `0s` (wait until turn completes) per `--help` [LOCAL]. Timeout behavior UNKNOWN.

## (e) Agent / instruction / skill file names

- Agents [DOCS https://antigravity.google/docs/subagents/]: Markdown + YAML frontmatter, body = system
  prompt. Locations: `.agents/agents/<name>.md` or `.agents/agents/<name>/agent.md` (workspace);
  `~/.gemini/config/agents/<name>.md` (global); `plugins/<p>/agents/` (bundled).
  Frontmatter: name*, description*, tools (e.g. view_file, run_command), mainAgent (default true),
  subagent (default true), model (inherit|flash|pro), commandExecutionPolicy (off|auto|eager|sandbox),
  mcpServers, skills/plugins. Built-ins: research, browser, self. Nesting depth cap: 10.
  Headless spawn appears via `subagent_info` in tool steps [DOCS headless]; headless
  spawn/limits NOT verified live. Locally `agy agents` prints NOTHING and
  `~/.gemini/config/agents/` does not exist [LOCAL] -> definition format UNVERIFIED on disk for CLI.
- Skills [DOCS https://antigravity.google/docs/skills/]: `<skill>/SKILL.md` + frontmatter
  (description required, name defaults to folder). CLI loads `<root>/.agents/skills/`,
  `~/.gemini/antigravity-cli/skills/`, plugin skills; each skill auto-becomes `/<name>` slash cmd.
  None of these dirs exist locally [LOCAL]. `~/.agents/skills/reverse-engineer-anything/SKILL.md`
  EXISTS on disk [LOCAL] but is absent from CLI docs -> whether agy CLI loads it: UNVERIFIED.
- Instruction file: UNKNOWN. No GEMINI.md/AGENTS.md in ~ (depth 2), repo root, or run dirs [LOCAL];
  no mention in the 4 docs pages fetched. (Rules page not fetched; budget remains.)
- Slash commands exist (`/agents`, `/permissions`, `/config`, `/model`, `/effort`, `/resume`, ...);
  file locations UNKNOWN. `--disable-slash-commands` disables expansion in -p [LOCAL].

## Overhead

- Fixed per-session input-token overhead of a trivial `OK` prompt under the most minimal-context
  configuration found (empty cwd, flash-low, effort low, disable-slash-commands; no strip-tools
  flag exists): **input_tokens 11,827** (output 13, thinking 12, cache_read 0, total 11840)
  [LOCAL call 1]. No cost field (tokens only). run-to-run jitter ~8 tokens (11827 vs 11835).
  With `--sandbox`: 12,630 (+~800). Resumed-turn marginal cost ~12k input (full history re-fed,
  cumulative usage counters).

## Calls / fetches used

- 6/6 live model calls (all gemini-3.8-flash-low, trivial prompts, no bypass flags):
  minimal-OK, soft-deny touch, sandbox touch, effort-max (ERROR exit 1), session-create (BRAVO-42),
  session-resume --conversation (recall OK).
- 4/8 web fetches: headless, subagents, sandbox, skills docs pages.
- UNVERIFIED live (budget exhausted): `-c/--continue`, `--input-format stream-json` multi-turn,
  `--effort xhigh`, `--print-timeout` default/behavior, `permissions.allow` grant flow,
  `--dangerously-skip-permissions`, `--json-schema`, subagent spawn in -p.
