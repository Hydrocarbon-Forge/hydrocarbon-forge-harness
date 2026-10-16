# S2: OpenCode headless contract (spike, Tier H)

## Planner digest (≤60 lines)

- Versions: opencode 2.0.21 (v2 binary, pinned). Free models via `opencode/*-free`; all runs
  used `opencode/deepseek-v4.1-flash-free`, `--standalone --format json`, cost $0. [LOCAL]
- (a) Tool restriction: NO `--allowedTools`/`--disallowedTools`/`--tools` flags on `run`.
  Restriction goes through config: global `permission` map + per-agent `permission` (map, legacy
  alias) or `permissions` (v2 list of `{action, resource, effect}`). Last matching rule wins, so
  specific denies are appended AFTER the built-in `{*, *, allow}` default. `--agent <name>`
  selects the worker profile. [LOCAL --help + `debug agents`; DOCS https://opencode.ai/docs/agents/]
- v2 schema nuance (verified via `opencode debug agents`, no model call): legacy `permission:`
  map, `tools: {bash:false}`, `temperature:` (→`request.body`), `maxSteps:` (→`steps`) STILL LOAD
  in 2.0.21 — `bash` maps to the `shell` action; only `prompt:` is IGNORED (markdown body wins).
  Prefer new names (`permissions`, `steps`, `request`) for new files. [LOCAL]
- Denied tools are REMOVED FROM CONTEXT (model-visible absence, like Claude): with `shell`
  denied the model says "no shell/bash tool is available", the run continues, exit 0. [LOCAL]
- (b) `#variant` = reasoning-effort/thinking preset (`-m provider/model#variant`). Built-ins differ
  per family: OpenAI none/minimal/low/medium/high/xhigh; Anthropic high/max; Google low/high.
  Custom variants definable per model. [DOCS https://opencode.ai/docs/models/]
- (c) Resume: `-s <id>` continues or creates; `-c` continues last; `--fork` forks first.
  Verified: `-s <tool-session>` recalled `TOOL_OK_123` with no new tool call, same sessionID,
  exit 0. [LOCAL --help + live]
- Exit codes: 0 success/denial/resume; 1 bad flag (stderr `Unrecognized flag`) and 1 unknown
  model (`provider.no-route` error event on stdout, empty stderr — no model called). Other
  failure codes UNKNOWN. [LOCAL]
- (d) Custom OpenAI-compatible provider: `npm: @ai-sdk/openai-compatible` + `options.baseURL` +
  `models` map keyed by server model id (llama.cpp section documented). [DOCS providers]
  Site-local llama.cpp server: REACHABLE, `/v1/models` lists one gguf id with
  `capabilities: ["completion"]`; tool calling through it worked in a prior-attempt scratch run
  (shell `echo` completed, NOT re-run here). Endpoint address is user-local: withheld from
  committed files (belongs in `settings.local.json`). [LOCAL curl + prior scratch]
- NDJSON ADAPTER WARNING: trivial text-only turns under the restricted agent emitted
  `step_start` + `text` but NO `step_finish` on stdout (2/2 runs); usage recovered via
  `opencode session export <id> --standalone`. Tool-call turns always had `step_finish`.
  Normalizer must tolerate a missing `step_finish`. [LOCAL]
- OVERHEAD (trivial "OK", minimal config: one-line agent, edit/shell/webfetch/websearch denied,
  rea MCP off, empty cwd): input **6196** + cache read/write 0, output 2, cost 0 (from session
  export; stdout had no step_finish). Caveat: auto title-generation can add a second step. [LOCAL]
- Fixtures in `test/fixtures/backends/opencode/`: success, tool-call, denial, resume,
  error-badmodel (all raw `--format json` NDJSON, exit codes in §f table). [LOCAL]
- Spend: 5 live model calls (free tier, $0), 3/8 web fetches. Always `--standalone`. No bypass flags.

## (a) Restricting worker tools/permissions under the v2 schema

- `opencode run --help` shows no allow/deny/tools flags — only `--agent`, `--auto`, `-m`, `-s`,
  `-c`, `--fork`, `--format`, `-f`, `--title`, `--thinking`. [LOCAL]
- Worker profile = agent file (`.opencode/agents/<name>.md`, frontmatter + markdown body as system
  prompt) selected with `--agent <name>`; or `agent`/`agents` key in config. [DOCS agents]
- Evaluated form (from `opencode debug agents`) is always a `permissions` LIST of
  `{action, resource, effect}` with `effect allow|ask|deny`; defaults come first
  (`*|*|allow`, `external_directory|*|ask`, `.env` read rules, `browser|*|deny`), agent rules
  appended last. Last match wins (verified: appended `shell|*|deny` beats the earlier allow).
  [LOCAL + DOCS agents "last matching rule wins"]
- Legacy aliases still accepted by the 2.0.21 binary (verified, `debug agents`, no model call):
  `permission: {edit: deny}` → `{edit,*,deny}`; `tools: {bash: false}` → `{shell,*,deny}`
  (tool name `bash` maps to action `shell`); `temperature: 0.1` → `request.body.temperature`;
  `maxSteps: 5` → `steps: 5`; `prompt:` IGNORED (body "Old fields test." used, not the field).
  Docs mark `tools` and `maxSteps` deprecated in favour of `permission`/`steps`. [LOCAL + DOCS]
- Denial-equivalent (live, `--agent min` with `shell` denied, `--standalone`, exit 0): no
  `tool_use` event; model text: "I can't run shell commands — no shell/bash tool is available
  in this session." Denied tools vanish from the tool list the model sees. [LOCAL fixture denial]
- `--auto` auto-approves only permissions not explicitly denied (not exercised live; per --help
  text). [UNVERIFIED live]

## (b) Meaning of the `#variant` suffix in the model flag

- `-m/--model` format is `provider/model#variant` (per `run --help`). [LOCAL]
- `#variant` selects a reasoning-effort/thinking preset, NOT a different model. Built-ins:
  OpenAI none/minimal/low/medium/high/xhigh; Anthropic high (default)/max; Google low/high;
  other providers vary (list not comprehensive). Custom variants per model via
  `provider.<id>.models.<mid>.variants.<name>` (can also disable built-ins).
  [DOCS https://opencode.ai/docs/models/]
- No live variant run made (free-tier model used without suffix); effort-flag equivalent: NONE
  (`--thinking` only shows thinking blocks). [LOCAL --help]

## (c) Resume with the session flag; exit codes on failure

- `-s/--session <id>`: continue, or create if missing. `-c/--continue`: last session.
  `--fork`: fork before continuing. [LOCAL --help]
- Live resume: `opencode run --standalone --format json -s ses_eba23c36fffemkr0mz7FRxVlH6 "What
  exact text did the echo command print?"` → same `sessionID`, text "`TOOL_OK_123`", no new
  `tool_use`, exit 0. [LOCAL fixture resume]
- Exit codes (all [LOCAL]): bad flag `--no-such-flag-xyz` → 1, usage on stdout, stderr
  `ERROR Unrecognized flag: ...`; unknown model `opencode/no-such-model-xyz` → 1, single
  `{"type":"error",...,"error":{"type":"provider.no-route","message":"Model unavailable: ..."}}`
  on stdout, empty stderr; success / denial / resume → 0 with empty stderr.
- UNKNOWN: exit codes for mid-run provider failures (a prior-attempt scratch showed a
  `provider.auth` FreeTierError 403 `error` event on one resume attempt, but a retry on the same
  session succeeded — transient, exit code not recorded). Adapter must parse the `error` event,
  not just the exit code.

## (d) Custom provider for a local OpenAI-compatible server

- Documented pattern (`provider.<id>` with `npm: @ai-sdk/openai-compatible`, `options.baseURL`,
  `models` map; dedicated llama.cpp example with `limit: {context, output}`):
  [DOCS https://opencode.ai/docs/providers/]
- Live: site-local llama.cpp `/v1/models` reachable, one gguf model id, capabilities include
  `completion`. Tool calling through the local provider worked in a prior-attempt scratch run
  (`shell` tool `echo` completed). NOT re-run here (kept 0 local-model calls). [LOCAL + prior]
- The endpoint address is user-local: it MUST NOT appear in committed files; Substrate config
  belongs in `settings.local.json` (per plan §App.B). No address is recorded anywhere in this
  spike or the fixtures (verified clean via grep). [LOCAL]

## (e) Fixtures (`test/fixtures/backends/opencode/*.ndjson`, raw `--format json`)

- `success.ndjson` (step_start + text "OK"; NOTE: no step_finish on stdout — see adapter
  warning; usage recovered via session export).
- `tool-call.ndjson` (step_start, tool_use `shell` echo completed, step_finish reason
  `tool-calls` tokens in 3430 / cache-read 4096 / out 42, step_start, text with output).
- `denial.ndjson` (step_start + text refusal, shell denied via agent; no tool_use, no step_finish).
- `resume.ndjson` (`-s` recall of the tool-call session, same sessionID, no new tool_use).
- `error-badmodel.ndjson` (single `error` event, `provider.no-route`, exit-1 run, no model call).

## (f) Overhead + run ledger

- Minimal config: fresh empty cwd, `opencode.jsonc` with only `$schema` + `mcp.rea.enabled:false`,
  one agent (`mode: primary`, one-line body, edit/shell/webfetch/websearch denied, `steps: 5`),
  `-m opencode/deepseek-v4.1-flash-free`, prompt "Reply with the single word OK".
- Overhead (via `opencode session export <id> --standalone`): input **6196**, cache read 0,
  cache write 0, output 2, reasoning 0, cost 0. Same 6196 seen in a prior default-config OK run.
  Title-generation (hidden `title` agent) can append a second billable step to a session.
- Ledger (all `--standalone`, exit codes observed): trivial-OK x2 (0, no step_finish on stdout);
  tool-echo via `build` (0); denied-echo via `min` (0); `-s` resume recall (0); bad flag (1);
  bad model (1). Total 5 live free-tier calls + 2 no-model probes + 3 doc fetches.

## Calls / fetches used

- 5 live model calls (deepseek free tier, $0): success, success-retry, tool-call, denial, resume.
  2 no-model probes (bad flag, bad model). No bypass flags. No local-model calls.
- 3 web fetches: opencode.ai/docs/agents, /providers, /models.
