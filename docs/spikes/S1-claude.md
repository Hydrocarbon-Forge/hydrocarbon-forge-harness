# S1: Claude Code headless contract (spike, Tier H)

## Planner digest

- Versions: claude 2.1.301; subscription Pro (claude.ai); no CLAUDE.md on disk; user
  settings pin `model: sonnet` + effort levels (override per-run). [LOCAL]
- (a) Minimal context without `--bare` (needs API key, never OAuth): empty cwd (no
  CLAUDE.md in ancestors) + `--setting-sources project,local` + `--tools ""` + `--effort low`
  + `--model haiku`. NOTE: agent `omitClaudeMd` is IGNORED for `--agent` main sessions
  [DOCS https://code.claude.com/docs/en/sub-agents.md]; it only trims subagent context.
- (b) `--session-id <uuid>` creates (id echoed on init+result); `--resume <id>` + new `-p`
  prompt continues with memory. Same cwd used. [LOCAL]
- (c) `dontAsk` + `--permission-prompts none`: safe cmds (echo) still auto-run; would-prompt
  cmds (touch) denied: `system/permission_denied` event + `is_error` tool_result +
  `result.permission_denials[{tool_name,tool_use_id,tool_input}]`; run continues, exit 0. [LOCAL]
- (d) Invalid flag exit 1 (stderr `error: unknown option`). Budget exceeded exit 1,
  `result.subtype error_max_budget_usd`, `is_error true`. Max-turns: NO CLI flag; agent
  `maxTurns` is subagent-scoped (stops partial, no exit code documented) -> exit UNKNOWN. [LOCAL/DOCS]
- OVERHEAD (trivial `OK`, minimal config): input 2 + cache_creation 580 = 582 tokens, $0.0001182. [LOCAL]
- Fixtures in `test/fixtures/backends/claude/`: success, tool-call, session-resume,
  denial, budget-exceeded (.ndjson stream-json). [LOCAL]
- Spend: 6/6 live haiku calls, 1/8 web fetches.

## (a) Minimal context under subscription auth

- `--bare` unusable: requires `ANTHROPIC_API_KEY`/apiKeyHelper, never OAuth/keychain. [LOCAL --help]
- Verified levers (`--setting-sources user,project,local` subset; `--tools ""` disables all;
  `--agents` JSON/file + `--agent`; `--effort low`; `--model haiku`): call 1 accepted all. [LOCAL]
- `init` (minimal run): `tools: []`, `permissionMode: default`, `agents` = built-ins + `min`
  (`--agents` ADDS, never replaces); keys incl. `cwd`, `model`, `mcp_servers`,
  `slash_commands`, `output_style`. No token counts on `init`. [LOCAL]
- `result` (trivial OK): `success`, `is_error false`, 1 turn, `end_turn`,
  `input_tokens 2`, `cache_creation 580`, `cache_read 0`, `output 4`,
  `total_cost_usd 0.0001182`, `permission_denials: []` (key present even on success), 746 ms. [LOCAL]
- Local state: `~/.claude/settings.json` has no hooks/plugins; no CLAUDE.md in `~`, repo,
  or run dir, so 582-token overhead is the no-CLAUDE.md floor. With tools (`Bash` only) the
  same-shape run cost 5798 cache tokens (call 2) — tools dominate context. [LOCAL]
- CORRECTION from docs: `omitClaudeMd: true` is ignored when the agent runs as the main
  session agent via `--agent` (v2.1.271+); it only strips CLAUDE.md from delegated
  subagents. For main-session workers, CLAUDE.md avoidance = clean cwd ancestry. [DOCS sub-agents.md]

## (b) Session create / resume

- Create: `--session-id 64001678-...` (valid UUID); init+result `session_id` echo the
  requested id; tool run (`echo hello-tool-ok` via allow-rule `Bash(echo *)` +
  `--permission-mode acceptEdits`) needed no prompt, exit 0, 2 turns, $0.00125669. [LOCAL]
- Resume: `--resume <id>` + new prompt `What exact text did the echo command print?` ->
  same `session_id`, correct recall (`hello-tool-ok`), 1 turn, no new tool call, exit 0. [LOCAL]
- Event shape for tools: `assistant/tool_use{Bash}` -> `user/tool_result{content,is_error false}`
  -> `assistant/text` -> `result`; plus `system/thinking_tokens` and `rate_limit_event`. [LOCAL]

## (c) Permission modes (`dontAsk` + `--permission-prompts none`)

- Safe read-only-ish Bash (`echo ...`) AUTO-RUNS even under dontAsk+none (no denial). [LOCAL call 4]
- Would-prompt Bash (`touch ...`) DENIED: `system {subtype: permission_denied, tool_name,
  tool_use_id, decision_reason_type: "mode", message, uuid, session_id}`; tool_result
  `is_error true` with don't-ask text; model complied without workaround; file absent;
  run continued, `result.subtype success`, exit 0. [LOCAL call 5]
- Denial ledger: `result.permission_denials: [{tool_name, tool_use_id, tool_input}]`
  (absent/empty on success). [LOCAL]

## (d) Exit codes

- Invalid flag (`--no-such-flag-xyz`): stderr `error: unknown option ...`, exit 1. [LOCAL]
- Budget exceeded (`--max-budget-usd 0.001`, 5-echo run, spend $0.00134567): all tools ran,
  answer composed, then `result {subtype: error_max_budget_usd, is_error: true, num_turns: 6}`,
  empty stderr, exit 1. [LOCAL]
- Max-turns: UNKNOWN. No `--max-turns` CLI flag exists; agent `maxTurns` caps subagent
  turns (output marked partial, resumable; no exit code documented) — untested live,
  6-call budget exhausted. [LOCAL --help; DOCS sub-agents.md]

## (e) Fixtures (`test/fixtures/backends/claude/*.ndjson`, raw stream-json)

- `success.ndjson` (4 events: system/assistant/rate_limit/result, trivial OK, 582 in-tokens).
- `tool-call.ndjson` (9 events incl. tool_use + tool_result, session-id create).
- `session-resume.ndjson` (4 events, recall across `--resume`).
- `denial.ndjson` (10 events incl. `permission_denied` + `permission_denials[1]`).
- `budget-exceeded.ndjson` (20 events, `error_max_budget_usd`, exit-1 run).

## Calls / fetches used

- 6 live model calls (haiku, caps <=0.05 except budget run): minimal-OK, tool-session-create,
  resume, safe-cmd-dontAsk, denied-touch, budget-5-echo. Total ≈ $0.005.
- 1 web fetch (sub-agents.md: omitClaudeMd/maxTurns correction). No bypass flags.
