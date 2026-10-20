# 01 Harness conventions: Claude Code, OpenCode, Antigravity (agy)

Evidence tags: [LOCAL] observed in this sandbox; [DOCS url] from fetched docs; [UNVERIFIED] not checked; UNKNOWN = not found.
Versions: claude 2.1.301; opencode 2.0.21 (v2 binary); agy 1.4.0.

## PLANNER DIGEST (read this instead of the rest)

### Key findings
1. Subagents in headless mode: Claude YES (parallel, background, 20 concurrent by default, nesting depth 3, env-tunable) [DOCS]. OpenCode: capability YES (`mode: subagent` via `subagent` tool), headless behaviour UNKNOWN. Antigravity: PARTIAL, stream has `subagent_info` and interactive `/agents`, headless spawning NOT documented. Implication: Substrate should fan out workers itself (one process per worktree) rather than rely on native subagents for portability.
2. Headless output: Claude = `--output-format json|stream-json` (`--verbose` needed for stream); OpenCode = `--format json` NDJSON (no stream-json); Antigravity = `--output-format json|stream-json`. Three event schemas: Claude uses `type`, OpenCode uses `type` + `sessionID`, Antigravity uses `event` + `conversation_id`. Substrate needs a normalizer.
3. Session id: Claude `session_id` (result event); OpenCode `sessionID` (every event); Antigravity `conversation_id`.
4. Usage/cost: Claude gives `total_cost_usd` + token usage; OpenCode gives tokens + cost per step (free model cost 0); Antigravity gives TOKENS ONLY, no cost. Substrate must compute cost itself for agy.
5. Budget cap: only Claude has `--max-budget-usd`. OpenCode and Antigravity have none. Substrate must enforce budget itself (kill process at token/cost threshold).
6. Permission semantics differ and are RISKY. Claude: deny > ask > allow, first match, bare tool name removes it from context. OpenCode: {action,resource,effect} last matching rule wins. Antigravity: in -p, unapproved tools are SOFT-DENIED, run continues, exit code stays 0. Substrate must detect denials (Claude `permission_denials` in result; agy stderr note) or it will silently under-deliver.
7. Exit codes: Claude 0 success, non-zero failure, 143 on SIGTERM; OpenCode 0 observed; Antigravity 0/1/2 documented. Non-zero Claude values UNKNOWN. Adapters must check the JSON status, not just the exit code.
8. Doc conflicts in agy: `--effort` (docs low..high vs help adds xhigh,max); `--print-timeout` default (docs 5m vs help 0s). Pin and test against 1.4.0.
9. OpenCode v2 schema drift: v2 agent fields dropped `permission`, `tools`, `prompt`, `temperature`, `maxSteps`. Old examples will not load. Pin 2.0.21.
10. Config/definition dirs: Claude `.claude/`, `~/.claude/`; OpenCode `.opencode/`, `~/.config/opencode/`; Antigravity `~/.gemini/antigravity-cli/`, `~/.agents/skills/`. Commands and skill loading paths for OpenCode and agy are UNKNOWN or unverified.
11. Instruction files: Claude CLAUDE.md (verified). OpenCode AGENTS.md likely, UNVERIFIED. Antigravity UNKNOWN (no GEMINI.md or AGENTS.md found locally).
12. Live calls cost ~$0.002 (claude haiku); opencode and agy used free or flash-low models. No bypass flags were used.

### Unified copy table (proposed Substrate names in last column)

| Feature | Claude Code 2.1.301 | OpenCode 2.0.21 | Antigravity agy 1.4.0 | Proposed Substrate |
|---|---|---|---|---|
| Headless flag | `claude -p "..."` | `opencode run "..."` (+`--standalone`) | `agy -p "..."` | `substrate run "..."` |
| Output formats | `--output-format text\|json\|stream-json` (+`--verbose`) | `--format default\|json` (NDJSON) | `--output-format text\|json\|stream-json` | `--output-format text\|json\|stream-json` |
| Model flag | `--model <alias\|id>` | `-m provider/model#variant` | `--model <slug>` | `--model` (provider/model#variant) |
| Effort flag | `--effort low..max` | none (UNKNOWN) | `--effort low..max` (doc conflict) | `--effort` |
| Session create | `--session-id <uuid>` | `-s <id>` (create or continue) | `--conversation <id>` (resume only) | `--session <id>` |
| Session resume | `--resume <id>`, `-c/--continue`, `--fork-session` | `-s <id>`, `-c/--continue`, `--fork` | `-c/--continue`, `--conversation <id>` | `--resume <id>`, `--continue`, `--fork` |
| Agent def path | `.claude/agents/<n>.md`, `~/.claude/agents/`, `--agents <json\|file>` | `.opencode/agents/<n>.md`, `~/.config/opencode/agents/`, or `agents` key in config | UNKNOWN (`agy agents` empty) | `.substrate/agents/<n>.md`, `~/.config/substrate/agents/` |
| Agent def format | Markdown + YAML frontmatter (body = system prompt) | Markdown + frontmatter, or JSONC | UNKNOWN | Markdown + YAML frontmatter (Claude-compatible) |
| Command path | `.claude/commands/*.md` | UNKNOWN | UNKNOWN (slash commands exist) | `.substrate/commands/*.md` |
| Skill path | `.claude/skills/<n>/SKILL.md` | UNKNOWN | `~/.agents/skills/<n>/SKILL.md` (on disk, UNVERIFIED for agy) | `.substrate/skills/<n>/SKILL.md` |
| Config file + precedence | `~/.claude/settings.json` < `.claude/settings.json` < `.claude/settings.local.json` (+ managed). `--settings`, `--setting-sources` | `~/.config/opencode/opencode.json`; project `opencode.jsonc` up to root, later overrides | `~/.gemini/antigravity-cli/settings.json`, `~/.gemini/config/` (precedence UNKNOWN) | `.substrate/settings.json` (project) over `~/.config/substrate/settings.json` (user); `.substrate/settings.local.json` above project |
| Permission modes | `--permission-mode default\|acceptEdits\|auto\|dontAsk\|plan\|bypassPermissions\|manual` | `--auto` only | `--mode accept-edits\|auto\|plan`; `--dangerously-skip-permissions` | `--permission-mode` (Claude set; map others) |
| Permission rules | `Tool(spec)`, `Bash(git *)`, `Read(./.env)`, `mcp__s__t`; deny>ask>allow | `{action,resource,effect}`, last match wins | `permissions.allow: command(git)` | Claude syntax, deny>ask>allow |
| Allow/deny flags | `--allowedTools`, `--disallowedTools`, `--tools` | none on run | none | `--allowed-tools`, `--disallowed-tools` |
| Worktree flag | `-w/--worktree`; agent `isolation: worktree` | none | none | `--worktree` / `-w` |
| Budget flag | `--max-budget-usd` (-p only) | none (UNKNOWN) | none (`--print-timeout` only) | `--max-budget-usd` (enforced by Substrate for all backends) |
| Timeout flag | none (bg wait ceiling env) | none | `--print-timeout` | `--timeout` |
| Sandbox flag | none on CLI (sandbox via settings, UNKNOWN flag) | none | `--sandbox` (default off, details UNKNOWN) | `--sandbox` |
| Instruction file | `CLAUDE.md` (verified) | AGENTS.md likely (UNVERIFIED) | UNKNOWN | `SUBSTRATE.md` (fallback: CLAUDE.md, AGENTS.md) |
| Subagent cap | 20 concurrent, depth 3 | UNKNOWN | UNKNOWN | Substrate-level worker cap |
| Exit codes | 0 ok; non-zero fail; 143 SIGTERM | 0 observed | 0 ok, 1 fail, 2 control msg | 0 ok, 1 fail, 2 usage, 143 SIGTERM |
| Session id field | `session_id` (result) | `sessionID` (each event) | `conversation_id` | `session_id` |
| Usage/cost field | `total_cost_usd`, `usage` | `step_finish.part.tokens`, `.cost` | `usage` tokens only | `usage` + computed cost |
| Stream event key | `type` | `type` | `event` | normalize to `type` |
| Interactive status line | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

### Risks (riskiest first)
1. Silent permission denials: agy soft-denies in -p with exit 0; Claude needs `--permission-prompts none` or a dontAsk mode to avoid hangs in unattended runs. Substrate must parse denials per backend.
2. No cost field for agy and no budget flag for OpenCode or agy. Budget caps are Substrate's job.
3. Native subagents are not portable: only Claude is confirmed in headless. Do not design around them.
4. Doc conflicts (agy effort, print-timeout) and OpenCode v2 schema drift. Pin versions in the adapters.
5. Claude `--bare` skips CLAUDE.md, hooks and plugins; Substrate should set this deliberately, not by accident.

### Open items (UNKNOWN, not resolved)
- agy agent definition format; agy command and instruction file names; agy and OpenCode sandbox behaviour.
- OpenCode commands and skills locations; OpenCode headless subagent concurrency; OpenCode exit codes beyond 0.
- Slash command lists and key bindings for all three interactive UIs (Claude partial: /config, /model, /effort, /fast, /color, /rename, /mcp, /output-style, /permissions).
- Claude full hook event list (only PreToolUse, PostToolUse-style names, SessionStart, SessionEnd, PermissionRequest, Elicitation, Setup were seen in docs).

### Calls and fetches used
- About 21 tool calls, 7 web fetches. Remaining gaps are listed above.

---

## DETAIL SECTIONS (per CLI)

---

## CLAUDE CODE (claude 2.1.301)

### 1. Headless contract
- Invocation: `claude -p "<prompt>"` (alias `--print`). Prompt may also come on stdin (piped, capped 10MB) [DOCS https://code.claude.com/docs/en/headless.md].
- Model: `--model <alias|id>` (aliases e.g. `haiku`, `sonnet`, `opus`, `fable`) [LOCAL].
- Effort: `--effort low|medium|high|xhigh|max` [LOCAL].
- Output: `--output-format text|json|stream-json` (only with -p). stream-json needs `--verbose` [LOCAL, DOCS]. `--input-format text|stream-json` [LOCAL].
- JSON schema: `--json-schema '<schema>'`; result appears in `structured_output` field [DOCS].
- Budget cap: `--max-budget-usd <amount>` (only with -p) [LOCAL].
- Timeout: no native flag seen [LOCAL]. Background wait cap env `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (default 10 min) [DOCS].
- cwd: run in the shell cwd; extra dirs `--add-dir <dirs...>` [LOCAL].
- Permission mode: `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan` [LOCAL]. Also `--permission-prompts none` (v2.1.259+) to deny prompts in unattended runs [DOCS].
- Tool allow/deny: `--allowedTools "Bash(git *) Edit"` and `--disallowedTools` (comma or space list); `--tools` sets the built-in tool set [LOCAL].
- Session create: `--session-id <uuid>`, `--no-session-persistence` (-p only) [LOCAL]. Resume: `--resume <id|transcript.jsonl>`, `-c/--continue` (most recent in cwd), `--fork-session` [LOCAL, DOCS].
- Background: `--bg/--background` (not with -p, rejected by -p per DOCS); `claude agents` lists background sessions [LOCAL].
- Bare/minimal: `--bare` skips hooks, LSP, plugins sync, CLAUDE.md auto-discovery, auto memory, keychain; needs ANTHROPIC_API_KEY or apiKeyHelper via --settings [LOCAL, DOCS].
- Exit codes: 0 on success; non-zero when the run fails (invalid flag errors go to stderr before the run). SIGTERM gives 143 [DOCS headless.md]. Exact non-zero values: UNKNOWN.

Live sample (haiku, 2026-10-16, prompt "Reply with the single word OK", --output-format stream-json --verbose --no-session-persistence --max-budget-usd 0.05) [LOCAL]:
- Event sequence: `{"type":"system","subtype":"init"}` -> `assistant` (x2) -> `rate_limit_event` -> `result`.
- Final event fields used: `type:"result"`, `subtype:"success"`, `is_error`, `num_turns`, `total_cost_usd`, `session_id`, `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens_details{thinking_tokens}, iterations[...]}`, `stop_reason`, `duration_ms`.
- Session id: `session_id` on init and result events. Usage/cost: on the `result` event. `--output-format json` returns one object with `result`, `session_id`, `total_cost_usd`, `usage`, `structured_output` (when schema).
- Subagent events carry `parent_tool_use_id` (null for main conversation) [DOCS].

### 2. Definition formats
- Locations and precedence (highest first) for subagents [DOCS sub-agents.md]: managed settings > `--agents <json|file>` (session only; with -p a file path) > `.claude/agents/` (project) > `~/.claude/agents/` (user) > plugin `agents/`.
- Other dirs [LOCAL]: `.claude/` and `~/.claude/` hold agents, commands, skills. CLAUDE.md is the instruction file.
- Agent definition = Markdown file with YAML frontmatter; the body is the system prompt [DOCS]. Frontmatter fields (exhaustive, DOCS sub-agents.md):
  - name (required; max 256 chars, no `:`)
  - description (required; when to delegate)
  - tools (allowlist), disallowedTools (denylist)
  - model (sonnet|opus|haiku|fable|full id|inherit)
  - permissionMode (default|acceptEdits|auto|dontAsk|bypassPermissions|plan)
  - maxTurns
  - autoCompactWindow (100000..1000000)
  - skills (preloaded)
  - mcpServers
  - hooks
  - memory (user|project|local)
  - background (bool)
  - omitClaudeMd (bool)
  - effort
  - isolation (`worktree`)
  - color
  - initialPrompt (first turn when run via --agent)
  - experimental (e.g. cacheTtl)
- Example:
  ```
  ---
  name: fast-worker
  description: Implements a small, scoped code change.
  tools: Read, Edit, Bash
  model: haiku
  permissionMode: acceptEdits
  isolation: worktree
  ---
  You implement exactly the task given. Report changed files.
  ```
- Commands: `.claude/commands/*.md` (custom slash commands) [LOCAL dirs; DOCS headless.md says user-invoked skills and custom commands expand via `/name` in -p prompt].
- Skills: `.claude/skills/<name>/SKILL.md` [LOCAL dir; DOCS skills#...]. Skills can run in a subagent (forked).
- Settings files: `~/.claude/settings.json` (user), `.claude/settings.json` (project, shared), `.claude/settings.local.json` (local, git-ignored; "Yes, don't ask again" saves here), managed settings. Precedence: managed > local > project > user (standard; not separately verified) [DOCS permissions.md for file names].
- Setting sources flag: `--setting-sources user,project,local`; `--settings <file|json>` adds one [LOCAL].
- Plugin/hook mechanism: `--plugin-dir <path|zip>`, `--plugin-url`; hooks in settings. Event names seen in DOCS: SessionStart, Setup, SessionEnd, PreToolUse, PostToolUse, PermissionRequest, Elicitation, SubagentStop-style hooks [DOCS headless.md, sub-agents.md]. Full list: UNKNOWN (not fetched).
- Permission rule syntax [DOCS permissions.md]:
  - `Tool` or `Tool(*)` = whole tool (as deny: removed from context).
  - `Bash(npm run build)` exact; `Bash(npm run *)` prefix (space before trailing `*` required); `Bash(ls:*)` same as `Bash(ls *)`.
  - `Read(./.env)`, `Edit(/src/**)` (project-relative), `Read(//abs/**)`, `Read(~/x)`; `WebFetch(domain:example.com)`; MCP: `mcp__server__tool`, `mcp__server__*`, `mcp__*` (deny/ask only for globs).
  - Evaluation order: deny, then ask, then allow; first match wins. A deny cannot be carved out by allow.
  - Compound Bash commands (&&, ||, ;, |, &, newline) are split; each part must match an allow rule.
- Instruction file: CLAUDE.md (project and user; `--bare` disables auto-discovery, pass via --add-dir/--append-system-prompt) [LOCAL, DOCS].

### 3. Subagents in headless mode: YES (resolved) [DOCS headless.md, sub-agents.md]
- A `claude -p` run can spawn subagents (Agent tool) and they appear in stream-json with `parent_tool_use_id`.
- Parallel: yes. Concurrency cap: 20 running subagents by default, env `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. No total cap per session.
- Background: in -p mode, fork mode off, so subagents run in background unless the result is needed before continuing. Run stays open until background subagents finish (waits for them; up to the 10-min background ceiling unless set).
- Depth: subagents can spawn subagents up to 3 layers below main by default; env `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (1 disables nesting).
- Agent-spawns-agent visible via `--forward-subagent-text` (v2.1.211+) for text blocks.
- Subagent can be pinned to `isolation: worktree` and `permissionMode`, `tools`, `model` per definition.

### 4. Sandbox and permissions
- `--permission-mode` modes [LOCAL, DOCS permission-modes]: default (ask), acceptEdits (auto file edits and mkdir/touch/mv/cp in working dirs), auto (classifier reviews actions), dontAsk (deny anything that would prompt; allows rule-matched actions), bypassPermissions (no checks; avoid), plan (read-only planning), manual (ask everything).
- `--allowedTools` / `--disallowedTools` apply rules above, enforced by the permission layer, not an OS sandbox.
- `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`: bypass; do not use.
  Owner decision 2026-10-19: Substrate launches all three harnesses with permissions bypassed (see docs/plan/BLOCKED.md, R5.2).
- `--tools` restricts the built-in tool set; with `--bare` tools limited to Bash, Read, Edit as listed.
- Filesystem/network sandbox: separate feature (DOCS sandboxing.md). CLI flag for sandbox: UNKNOWN (not checked).
- Worktree flag: `-w/--worktree` [LOCAL].
- Budget: `--max-budget-usd` (-p only) [LOCAL].

### 5. Interactive UX
- Slash commands seen in DOCS: /config, /model, /effort, /fast, /color, /rename, /mcp, /output-style, /permissions, /sandbox (names only; full list UNKNOWN).
- Key bindings: UNKNOWN (not fetched; see keybindings-help skill for ~/.claude/keybindings.json).
- Session picker: `--resume` with no id, `--continue`; `--from-pr [value]` opens picker [LOCAL].
- Plan mode: `--permission-mode plan` or `--permission-mode` interactive toggle [LOCAL].
- Status line: UNKNOWN (statusline-setup agent exists).
- Background sessions manager: `claude agents`, `claude attach|logs|stop|rm` [LOCAL].
- CORRECTION: `/sandbox` and `SubagentStop` were NOT verified; treat as UNKNOWN.

---

## OPENCODE (opencode 2.0.21, v2 binary)

### 1. Headless contract
- Invocation: `opencode run [flags] [message...]` [LOCAL]. Attach files: `-f/--file`. Session title: `--title`.
- Model: `-m/--model provider/model#variant` [LOCAL]. Cheap models seen locally: opencode/deepseek-v4.1-flash-free, opencode/glm-5.3-flash-free, opencode/mimo-v2.6-flash-free (all free tier) [LOCAL].
- Agent: `--agent <name>` [LOCAL].
- Effort / thinking: no effort flag; `--thinking` shows thinking blocks [LOCAL]. Effort flag: UNKNOWN.
- Output: `--format default|json` [LOCAL]. No stream-json; json output is NDJSON events.
- JSON schema: no flag [LOCAL]. UNKNOWN.
- Budget cap: no flag [LOCAL]. UNKNOWN.
- Timeout: no flag [LOCAL]. UNKNOWN.
- cwd: UNKNOWN for `run`; `opencode [directory]` sets start dir for TUI [LOCAL].
- Permission mode: `--auto` auto-approves permissions not explicitly denied [LOCAL]. No plan/accept-edits mode flag [LOCAL].
- Tool allow/deny flags: none on `run` [LOCAL]; use config `permission` rules [DOCS].
- Session create/resume: `-s/--session <id>` (continue or create if missing), `-c/--continue` (last), `--fork` (fork before continuing) [LOCAL].
- Backend: default is background service; `--standalone` runs a private server; `--server <url>` attaches [LOCAL]. Relevant to adapter design (startup cost).
- Exit codes: 0 observed on success [LOCAL]. Others: UNKNOWN.

Live sample (opencode/deepseek-v4.1-flash-free, `--standalone --format json`, prompt "Reply with the single word OK") [LOCAL]:
- Event types: `step_start`, `text` (part.text = "OK"), `step_finish` (part.reason = "stop", part.cost, part.tokens{input, output, reasoning, cache{read, write}}).
- Session id: `sessionID` on every event (ses_...). Usage/cost: `step_finish.part.tokens` and `part.cost` (cost 0 for free model).
- No final `result` event; the last `step_finish` is the end marker [LOCAL].

### 2. Definition formats
- Agent locations [DOCS agents]: `~/.config/opencode/agents/<name>.md` (global) and `.opencode/agents/<name>.md` (project). Nested folders become IDs (`team/reviewer`). Alternatively JSONC under `agents` key in any config file.
- Agent format: Markdown frontmatter; body = system prompt. Fields (v2, exhaustive per DOCS): description, mode (primary|subagent|all), model (provider/model#variant), system, permissions (list of {action, resource, effect}), steps, hidden, color (hex), disabled, request.
- Removed/not for new v2 config: temperature, top_p, prompt, permission, tools, disable, maxSteps [DOCS]. RISK: v1-era docs use `permission`/`tools`/`prompt`; the v2 binary rejects or ignores them.
- Example:
  ```
  ---
  description: Reviews changes
  mode: subagent
  ---
  Review changes and list findings by severity.
  ```
- Commands: UNKNOWN (not fetched).
- Skills: UNKNOWN for opencode. Local agy skills live in ~/.agents/skills/ [LOCAL].
- Config files [LOCAL]: `~/.config/opencode/opencode.json` (key seen: `mcp`), `~/.config/opencode/service.json`. Project: `opencode.jsonc` (DOCS examples, `$schema` opencode.ai/config.json). Precedence: project `.opencode` dirs discovered from cwd up to project root; later config overrides earlier; scalars replace, request maps merge by key, permission rules append; global permissions apply before agent rules [DOCS]. Full precedence list: UNKNOWN.
- Permission rule syntax [DOCS agents page]: each rule = {action, resource, effect}. effect = allow|ask|deny. Last matching rule wins (opposite of Claude's deny-first). action = shell, edit, subagent, read, glob, grep, webfetch, websearch, skill, external_directory; resource and action accept wildcards.
- Instruction file: UNKNOWN (AGENTS.md likely; not verified).
- Plugin/hook mechanism: `opencode plugin` subcommand exists [LOCAL]; hook event names UNKNOWN.

### 3. Subagents in headless mode
- Capability: YES [DOCS agents]. A `mode: subagent` agent is launched through the `subagent` tool, in foreground or background child sessions with fresh context. The parent's `subagent` permission rules control which agents it can launch. The built-in `general` agent cannot launch further subagents.
- Headless-specific behaviour (in `opencode run`, parallelism, background wait, depth limit): UNKNOWN. Not in run --help or docs fetched. Concurrency cap: UNKNOWN.

### 4. Sandbox and permissions
- `--auto` only auto-approves permissions not denied by rules [LOCAL]. Denies come from `permission` rules (action/resource/effect).
- Sandbox: not mentioned in docs [DOCS]. Treat as NONE.

### 5. Interactive UX
- CLI subcommands seen [LOCAL]: upgrade|update, uninstall, acp, api, debug, auth, mcp, plugin, models, stats, mini, run, session, agent (help only), --standalone.
- `opencode mini` = minimal interactive interface [LOCAL].
- Slash commands, key bindings, plan mode, status line: UNKNOWN (TUI not inspected; no command list fetched).
- Session picker: `opencode session` subcommand, `-c`, `-s` [LOCAL].

---

## ANTIGRAVITY CLI (agy 1.4.0)

### 1. Headless contract
- Invocation: `agy -p "<prompt>"` (aliases `--print`, `--prompt`). Response to stdout, diagnostics to stderr [DOCS https://antigravity.google/docs/cli/headless, LOCAL].
- Model: `--model <slug>` (see `agy models`); unknown model FAILS (no fallback) [DOCS]. Cheap model used: gemini-3.8-flash-low [LOCAL].
- Effort: `--effort`. Docs say low|medium|high; --help says low|medium|high|xhigh|max. CONFLICT, treat as UNKNOWN for xhigh/max [LOCAL vs DOCS].
- Agent: `--agent <name>` [LOCAL, DOCS].
- Output: `--output-format text|json|stream-json` (default text). stream-json requires --output-format stream-json for --input-format stream-json [LOCAL].
- JSON schema: `--json-schema <string|file|primitive>`; parsed output in `structured_output` [DOCS].
- Timeout: `--print-timeout <dur>`. CONFLICT: docs say default 5m; --help says default 0s (wait until turn completes). Treat as UNKNOWN default [LOCAL vs DOCS].
- Resume: `-c/--continue` (latest), `--conversation <id>`; each starts a new process [DOCS]. Multi-turn: `--input-format stream-json` with stdin NDJSON `{"event":"user","message":{...}}`; closing stdin ends session [DOCS].
- cwd: no flag; reported in `init` event [DOCS]. `--add-dir` adds workspace dirs [LOCAL].
- Permission mode: `--mode accept-edits|auto|plan` [LOCAL]; `--dangerously-skip-permissions` approves everything [LOCAL, DOCS].
- Tool allow/deny: via `permissions.allow` in ~/.gemini/antigravity-cli/settings.json, e.g. `command(git)` [DOCS]. Deny rules: not documented [DOCS].
- Exit codes [DOCS]: 0 success (includes runs where tools were soft-denied); 1 failed run or malformed stream input; 2 control_request/control_response or slash command sent on stream input. Other statuses (ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING) have unspecified codes.

Live sample (gemini-3.8-flash-low, `--output-format stream-json`, prompt "Reply with the single word OK") [LOCAL]:
- Event types (key is `event`, NOT `type`): `init` (once) -> `step_update` (x3; state ACTIVE then DONE; step_type agent_response; text_delta; on DONE: duration_seconds, usage) -> `result`.
- `init` fields: conversation_id, init{model, cwd, tools[...] (long list of browser_*, ask_* tools), ...}.
- `result` fields: conversation_id, status "SUCCESS", response "OK\n", duration_seconds, num_turns 1, usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}.
- Session id: `conversation_id` (top-level in every event). Usage: `usage` on result (tokens only). NO cost field documented or observed [DOCS, LOCAL]. Input tokens for "OK" were ~11.9k (large system/tool prompt).

### 2. Definition formats
- Agents: `agy agent`/`agy agents` lists agents; locally returns NOTHING [LOCAL]. Definition file path and format: UNKNOWN (docs page "Custom subagents" linked but not retrieved; 404 for guessed URLs).
- Skills: `~/.agents/skills/<name>/SKILL.md` exists on this machine [LOCAL]. agy's skill-loading path not verified as its own; treat as a shared location, UNVERIFIED for agy.
- Commands: slash commands exist (`/agents`, `/permissions`, ...) [DOCS getting-started]; file locations UNKNOWN.
- Plugins: `agy plugin install|uninstall|enable|disable|list|validate|import [gemini|claude]|link`. `import` pulls plugins from Gemini or Claude installs [LOCAL]. Hook event names: UNKNOWN.
- Config files [LOCAL]: `~/.gemini/antigravity-cli/settings.json` (keys: model, trustedWorkspaces; no permissions key currently), `~/.gemini/config/mcp_config.json`, `~/.gemini/config/projects/`. Precedence: UNKNOWN.
- Permission rule syntax [DOCS headless]: `command(git)` in permissions.allow. Other rule forms: UNKNOWN.
- Instruction file: UNKNOWN (GEMINI.md / AGENTS.md not confirmed by any doc or local file).

### 3. Subagents in headless mode
- Stream events may include `subagent_info` in step_update [DOCS headless].
- Interactive: `/agents` switches between active background subagents; multiple background subagents can be active [DOCS getting-started]. So subagents exist and run in background in the interactive product.
- Headless: docs do not describe spawning, parallelism, background wait, or limits [DOCS headless]. Verdict: PARTIAL/UNKNOWN. Headless spawn is suggested by `subagent_info` in the event schema, but not confirmed. Depth/concurrency: UNKNOWN.

### 4. Sandbox and permissions
- `--sandbox`: "Run in a sandbox with terminal restrictions enabled", default false [LOCAL]. No behaviour details in docs [DOCS]. Treat as UNKNOWN in scope.
- Default policy [DOCS]: workspace reads/writes auto-allowed; shell commands default to Ask. In -p, unapproved tools are SOFT-DENIED: the run continues and stderr notes it. Exit code stays 0. RISK for Substrate: silent denials.
- Modes: accept-edits, auto, plan [LOCAL]. `--dangerously-skip-permissions` [LOCAL].

### 5. Interactive UX
- Slash commands seen [DOCS getting-started]: /agents, /permissions, plus others (full list UNKNOWN).
- Key bindings, plan mode key, session picker, status line: UNKNOWN.
- `agy --prompt-interactive` (-i) runs an initial prompt then continues the session [LOCAL].
- `--remote-control` and `agy remote-control` daemon exist [LOCAL].
