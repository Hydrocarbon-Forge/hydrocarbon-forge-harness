> Archived: research for a TUI that was removed (work package R0.7). Not part of the product.

# S5: Interactive UX Conventions (Claude Code, OpenCode v2, Antigravity) and Substrate TUI Synthesis

## Planner Digest & Resolution of Unknown U9

- **Status**: Unknown U9 is **RESOLVED**.
- **AsOf**: `2026-10-17` (Version 1).
- **Scope**: Complete cataloging of interactive UX conventions across Claude Code, OpenCode v2, and Antigravity (slash commands, keybindings, and status line conventions), culminating in the normative synthesis for Substrate's interactive TUI (P5.3).
- **Harness Findings Summary**:
  - **Claude Code**: Prompt-interception slash command registry with `.claude/commands/*.md` expansion; `Shift+Tab` cycling permission modes; `Esc` and double `Ctrl+C` interrupt/exit flows; `Ctrl+O` verbose feed toggle; status line emphasizing model/tier, execution state, and live token/cost metering with column-responsive collapsing.
  - **OpenCode v2**: Space-delimited command arguments (`provider/model#variant`); leader-key architecture (`Ctrl+X`); global command palette (`Ctrl+P`); `@` file attachment and `!` shell passthrough; terminal footer displaying model variant, agent profile, token usage ratio, and cost.
  - **Antigravity (`agy`)**: Native slash commands alongside auto-discovered skills (`SKILL.md`); instant approval hotkey (`Ctrl+K`); double `Esc` prompt clearing; armed double `Ctrl+C` process termination; status line displaying model slug, spinner state, OS sandbox isolation tag, turn count, and token tallies.
- **Substrate TUI (P5.3) Synthesis**:
  - **19 Canonical Slash Commands** (§4.7): `/help`, `/mode`, `/plan`, `/run`, `/status`, `/tasks`, `/cost`, `/models`, `/agents`, `/permissions`, `/config`, `/resume`, `/sessions`, `/undo`, `/doctor`, `/init`, `/clear`, `/exit`, `/hooks`.
  - **Canonical Keymap**: `Enter` (submit), `Esc` (graceful interrupt / pause / dismiss), `Shift+Tab` (permission mode cycle), `Ctrl+C` x 2 (debounced exit with code 130), `Ctrl+T` (task board toggle), `Ctrl+O` (verbose event feed toggle), `@` (file mention autocompletion), `!` (shell passthrough).
  - **Responsive 4-Tier Status Line**: Width >= 100 cols (full layout), 60–99 cols (compact, drops model/tier), 40–59 cols (minimal, state and progress only), < 40 cols (extreme collapsed state indicator).

---

## Interface Specifications

authoritative types imported from `src/contracts/**`:

```ts
import type {
  RunId, TaskId, SessionId, BackendName,
  Effort, PermissionMode, PauseReason
} from "../../src/contracts/index.js";
```

Slash command definition schema:

```ts
export interface SlashCommandDef {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  category: "core" | "state" | "config" | "control";
}
```

Keybinding specification schema:

```ts
export interface KeybindingDef {
  key: string;
  action: string;
  description: string;
  context: "prompt" | "running" | "dialog" | "global";
}
```

Status line segment and layout schema:

```ts
export interface StatusLineSegment {
  id: "model" | "state" | "tasks" | "cost" | "budget";
  label: string;
  priority: number;
  minTerminalWidth: number;
}
```

Harness UX comparison schema:

```ts
export interface HarnessUxComparison {
  harness: BackendName | "claude_code";
  slashCommands: string[];
  keybindings: Record<string, string>;
  statusLineLayout: string;
}
```

Unified UX Spike Report schema:

```ts
export interface UxSpikeReport {
  version: 1;
  asOf: string;
  answersU9: boolean;
  harnesses: Record<string, HarnessUxComparison>;
  unifiedSlashCommands: SlashCommandDef[];
  unifiedKeymap: KeybindingDef[];
  unifiedStatusLine: StatusLineSegment[];
}
```

---

## 1. Claude Code UX Analysis

### 1.1 Slash Commands
Claude Code intercepts input lines beginning with `/` in the interactive REPL before prompt tokenization.

| Slash Command | Argument Syntax | Aliases | Description |
|:---|:---|:---|:---|
| `/help` | `[command]` | `?`, `/h` | Displays interactive command help and usage guidelines. |
| `/clear` | — | `/c` | Clears conversation context and resets working memory. |
| `/compact` | `[focus]` | — | Summarizes active conversation history to reclaim context window. |
| `/context` | — | — | Displays visual breakdown of context window token allocation. |
| `/cost` | — | — | Shows token consumption and cumulative USD cost for current session. |
| `/config` | `[key] [val]` | — | Interactive settings manager and configuration inspector. |
| `/doctor` | — | — | Runs environment diagnostics, checking auth, API, and git health. |
| `/model` | `[model_id]` | `/m` | Displays or switches the active model (e.g., Sonnet 3.7, Haiku 3.5). |
| `/effort` | `low\|med\|high` | — | Sets reasoning/thinking budget tier for supported models. |
| `/permissions` | — | `/p` | Manages tool permission rules and auto-approval policies. |
| `/init` | — | — | Analyzes workspace and generates initial `CLAUDE.md` guidelines. |
| `/tasks` | — | — | Displays list and statuses of background agent/subagent tasks. |
| `/plan` | `[prompt]` | — | Enters read-only Plan Mode to design architecture without edits. |
| `/keybindings` | — | — | Opens interactive keybindings editor (`~/.claude/keybindings.json`). |
| `/mcp` | `[subcmd]` | — | Manages connected Model Context Protocol (MCP) servers and tools. |
| `/btw` | `<question>` | — | Asks side question without injecting turn into session context. |
| `/review` | `[target]` | — | Requests automated code review on staged changes or commits. |
| `/pr` | `[title]` | — | Creates GitHub pull request from current branch commits. |
| `/bug` | `[desc]` | `/feedback` | Reports an issue or product feedback directly to Anthropic. |

- **Argument Parsing Conventions**: Space-separated positional arguments follow command name. Multi-word arguments can be double-quoted.
- **Aliases**: Single-character aliases (`/c`, `/m`, `/p`, `?`) resolve to full canonical commands.
- **Expansion Semantics**:
  - Built-in commands execute internal handlers directly without LLM invocation.
  - Custom markdown commands stored in `.claude/commands/<name>.md` are expanded by replacing `$ARGUMENTS` or positional placeholders (`$1`, `$2`), then fed to the agent as prompt text.

### 1.2 Keybindings
Claude Code organizes hotkeys across prompt composition, active streaming, and modal states.

| Shortcut | Context | Action / Behavior |
|:---|:---|:---|
| `Enter` | `prompt` | Submits prompt buffer to agent. |
| `Shift+Enter` | `prompt` | Inserts newline without submitting (also `Ctrl+J` or `\Enter`). |
| `Shift+Tab` | `prompt` | Cycles permission modes (`default` -> `plan` -> `acceptEdits` -> `dontAsk` -> `bypassPermissions`). |
| `@` | `prompt` | Triggers interactive fuzzy file/path mention dropdown. |
| `!` | `prompt` | Prefixes shell passthrough command executed in local cwd. |
| `Up` / `Down` | `prompt` | Navigates backward and forward through prompt history. |
| `Ctrl+C` | `prompt` | Clears current input buffer; if empty, prompts exit confirmation. |
| `Ctrl+C` x 2 | `global` | Terminates process immediately (second press within 500ms). |
| `Ctrl+D` | `prompt` | Exits Claude Code if input buffer is completely empty. |
| `Esc` | `running` | Interrupts active model generation or tool execution gracefully. |
| `Ctrl+O` | `running` | Toggles verbose tool transcript view and internal steps. |
| `Ctrl+G` | `prompt` | Opens external `$EDITOR` to draft complex multi-line prompts. |
| `Tab` | `dialog` | Moves focus between interactive controls or form fields. |
| `Enter` | `dialog` | Confirms modal selection or approves proposed action. |
| `Esc` | `dialog` | Dismisses modal dialog without executing action. |

### 1.3 Status Line Conventions
Claude Code renders an adaptive footer row reflecting runtime context:
- **Segments**:
  1. `Model / Effort`: Active model name and thinking tier (e.g. `claude-3-7-sonnet [high]`).
  2. `Run State`: Dynamic state label with spinner (e.g. `idle`, `thinking...`, `running Bash`).
  3. `Context / Progress`: Context window fill ratio and token count.
  4. `Cost / Spend`: Cumulative session spend (e.g. `$0.0412`).
- **Responsive Adaptations**:
  - *Wide (>= 100 cols)*: `[claude-3-7-sonnet high] [running Bash] [42.1k / 200k (21%)] [$0.0412]`
  - *Medium (60–99 cols)*: Drops model details: `[running Bash] [42.1k / 200k] [$0.0412]`
  - *Narrow (< 60 cols)*: Collapses to minimal state indicator: `[Bash] [42k]`

---

## 2. OpenCode v2 UX Analysis

### 2.1 Slash Commands
OpenCode v2 provides an interactive terminal command palette and slash commands.

| Slash Command | Argument Syntax | Aliases | Description |
|:---|:---|:---|:---|
| `/help` | — | — | Displays list of commands, shortcuts, and active configuration. |
| `/new` | — | `/clear` | Starts a fresh session while archiving current session to history. |
| `/sessions` | `[id]` | `/resume`, `/s` | Lists previous sessions or switches directly to specified session. |
| `/compact` | — | `/summarize` | Compacts session context into summary to free up tokens. |
| `/share` | — | — | Generates public web transcript URL for current conversation. |
| `/unshare` | — | — | Revokes public link for previously shared session transcript. |
| `/models` | `[provider/model]`| `/m` | Opens model selector or switches active model using `#variant`. |
| `/connect` | `[provider]` | — | Configures API credentials and base URLs for model providers. |
| `/mcp` | `[action]` | — | Lists, adds, or tests Model Context Protocol servers. |
| `/agents` | `[name]` | `/a` | Switches active agent worker profile (e.g., `build`, `plan`). |
| `/undo` | — | — | Reverts last turn and rolls back file changes made by tool actions. |
| `/redo` | — | — | Restores previously undone turn and reapplies file modifications. |
| `/editor` | — | — | Opens external editor (`$EDITOR`) to compose prompt content. |
| `/export` | `[path]` | — | Exports conversation history to Markdown transcript. |
| `/status` | — | — | Displays provider connectivity, agent mode, and session metadata. |
| `/details` | — | — | Toggles inline rendering of detailed tool execution payloads. |
| `/thinking` | — | — | Toggles visibility of model reasoning / thought blocks. |
| `/themes` | `[theme_name]` | — | Opens interactive terminal theme selector. |
| `/btw` | `<question>` | — | Submits one-shot side question without mutating session transcript. |
| `/exit` | — | `/quit`, `/q` | Terminates OpenCode session cleanly. |

- **Argument Parsing Conventions**: Arguments follow space delimiters. Models follow the syntax `provider/model#variant` where `#variant` specifies the reasoning/thinking preset (e.g. `#low`, `#high`, `#xhigh`).
- **Expansion Semantics**: Commands in `.opencode/commands/*.md` or `.opencode/agents/*.md` replace `${args}` and `${file}` before runner dispatch.

### 2.2 Keybindings
OpenCode utilizes a **Leader Key** architecture (default `<leader>` is `Ctrl+X`):

| Shortcut | Context | Action / Behavior |
|:---|:---|:---|
| `Enter` | `prompt` | Submits prompt to agent. |
| `Shift+Enter` | `prompt` | Inserts newline in prompt box (also `Ctrl+Enter`, `Ctrl+J`). |
| `Ctrl+P` | `global` | Opens fuzzy command palette for all actions and slash commands. |
| `<leader> c` | `global` | Compacts / summarizes current session history. |
| `<leader> e` | `global` | Opens external text editor (`$EDITOR`) to draft prompt. |
| `<leader> q` | `global` | Quits OpenCode session (`/exit`). |
| `<leader> n` | `global` | Starts a new session (`/new`). |
| `<leader> l` | `global` | Lists and switches between sessions (`/sessions`). |
| `@` | `prompt` | Opens file and directory mention selector. |
| `!` | `prompt` | Runs shell command directly in working directory. |
| `Esc` | `running` | Cancels active generation or running tool step. |
| `Ctrl+C` | `running` | Interrupts current agent turn. |
| `j` / `k` / Arrows | `dialog` | Navigates through list items and picker menus. |
| `Enter` | `dialog` | Selects highlighted item in picker. |
| `Esc` / `q` | `dialog` | Closes dialog or picker overlay. |

### 2.3 Status Line Conventions
OpenCode renders a persistent terminal footer with agent and provider status:
- **Segments**:
  1. `Model & Variant`: e.g. `deepseek-v4.1#xhigh` or `anthropic/sonnet#high`.
  2. `Agent Profile`: Active worker persona (e.g. `[primary]`, `[build]`).
  3. `Context Ratio`: Tokens used vs capacity (e.g. `12.4k / 128k (9%)`).
  4. `Cost`: Cumulative USD session spend (or `$0.00` for free tiers).
- **Responsive Adaptations**:
  - *Wide (>= 80 cols)*: `[deepseek-v4.1#xhigh] [build] [12.4k / 128k (9%)] [$0.00]`
  - *Medium (60–79 cols)*: Drops agent profile: `[deepseek-v4.1#xhigh] [12.4k/128k] [$0.00]`
  - *Narrow (< 60 cols)*: Strips provider and percentage: `[deepseek] [12k]`

---

## 3. Antigravity (agy) UX Analysis

### 3.1 Slash Commands
Antigravity CLI provides native slash commands and dynamic skill binding.

| Slash Command | Argument Syntax | Aliases | Description |
|:---|:---|:---|:---|
| `/help` | `[cmd]` | `?` | Displays help guide and lists active commands and skills. |
| `/plan` | `[objective]` | — | Conducts discovery interview and outputs structured plan artifact. |
| `/goal` | `<target>` | — | Runs autonomous execution loop until specified goal is verified. |
| `/fast` | `<task>` | — | Executes quick task bypassing heavy planning ceremonies. |
| `/grill-me` | — | — | Runs interactive interview to uncover requirements and edge cases. |
| `/boost` | — | — | Activates hierarchical multi-agent reasoning for complex tasks. |
| `/teamwork-preview` | — | — | Launches multi-agent team for large-scale codebase migrations. |
| `/clear` | — | `/new` | Resets conversation context and prompt state. |
| `/resume` | `[conv_id]` | `/switch` | Resumes conversation by ID or opens conversation selector. |
| `/fork` | `[point]` | — | Branches current conversation into an isolated workspace thread. |
| `/add-dir` | `<path>` | — | Binds external directory into active workspace context. |
| `/undo` | — | `/rewind` | Reverts last turn and associated filesystem modifications. |
| `/config` | `[key] [val]` | `/settings`| Opens interactive configuration editor (`settings.json`). |
| `/keybindings` | — | — | Opens interactive keybindings configuration interface. |
| `/learn` | — | — | Extracts session learnings and stores persistent skill or rule. |
| `/skills` | — | — | Lists loaded custom skills from `.agents/skills/`. |
| `/mcp` | `[cmd]` | — | Manages registered MCP server integrations. |
| `/permissions` | — | — | Inspects allowed tool actions and reviews soft-denial rules. |
| `/agents` | — | — | Monitors and manages parallel subagent workers. |
| `/tasks` | — | — | Inspects and terminates active background tasks. |
| `/browser` | `[url]` | — | Launches sandboxed headless browser worker for DOM inspection. |
| `/status` | — | — | Shows conversation ID, sandbox state, turn count, and token usage. |
| `/doctor` | — | — | Verifies local sandbox environment, tool paths, and backend health. |
| `/exit` | — | — | Gracefully terminates Antigravity session. |

- **Argument Parsing Conventions**: Accepts positional tokens, `key=value` parameters, and `--flag` options.
- **Expansion Semantics**:
  - Custom skills in `<root>/.agents/skills/<name>/SKILL.md` or `~/.gemini/antigravity-cli/skills/` are dynamically mapped to `/<name>` commands.
  - `--disable-slash-commands` flag bypasses all local slash expansions.

### 3.2 Keybindings
Antigravity prioritizes rapid keyboard execution and approval workflows:

| Shortcut | Context | Action / Behavior |
|:---|:---|:---|
| `Enter` | `prompt` | Submits prompt buffer to agent. |
| `Esc Esc` | `prompt` | Double escape clears prompt buffer when idle. |
| `Ctrl+K` | `running` | Instantly approves proposed tool execution or permission prompt. |
| `Shift+Tab` | `prompt` | Toggles input modes or cycles focus. |
| `@` | `prompt` | Triggers workspace file autocompletion. |
| `!` | `prompt` | Executes shell command in local working directory. |
| `?` | `prompt` | When typed as first character, displays quick help overlay. |
| `Ctrl+C` | `running` | Interrupts current agent turn or tool step. |
| `Ctrl+C` x 2 | `global` | Double press within 500ms cleanly exits process. |
| `Esc` | `running` | Gracefully cancels current subagent or tool execution. |
| `Arrows` | `dialog` | Navigates options in agent or model selectors. |
| `Enter` | `dialog` | Confirms modal selection. |
| `Esc` | `dialog` | Closes dialog overlay. |

### 3.3 Status Line Conventions
Antigravity displays session identity and sandbox status:
- **Segments**:
  1. `Model`: Model tier slug (e.g. `gemini-3.8-flash-low`).
  2. `State / Spinner`: State indicator (e.g. `thinking`, `running tool`, `review`).
  3. `Sandbox Tag`: Security isolation state (`[sandboxed]` vs `[unsandboxed]`).
  4. `Conversation & Turn`: Unique conversation ID prefix and turn counter (e.g. `57faeed3... #3`).
  5. `Token Usage`: Input, output, and reasoning token totals.
- **Responsive Adaptations**:
  - *Wide (>= 100 cols)*: `[flash-low] [running tool] [sandboxed] [57faeed3... #3] [11.8k tok]`
  - *Medium (60–99 cols)*: Truncates conversation ID and hides sandbox tag: `[flash-low] [running tool] [#3] [11.8k]`
  - *Narrow (< 60 cols)*: Minimal status: `[flash] [tool] [#3]`

---

## 4. Cross-Harness Comparative Matrix

### 4.1 Slash Command Comparison

| Capability | Claude Code | OpenCode v2 | Antigravity (`agy`) |
|:---|:---|:---|:---|
| Help & Docs | `/help`, `?` | `/help` | `/help`, `?` |
| Clear / Reset | `/clear` | `/new`, `/clear` | `/clear`, `/new` |
| Session Resume | CLI `--resume <id>` | `/sessions`, `/resume` | `/resume`, `/switch` |
| Context Compaction | `/compact`, `/context` | `/compact` | `/context` |
| Model Switching | `/model`, `/effort` | `/models` (`#variant`) | `/model`, `/effort` |
| Permissions / Security | `/permissions` | Global/Agent config | `/permissions` |
| Configuration | `/config`, `/keybindings` | Config file / settings | `/config`, `/keybindings` |
| Diagnostics | `/doctor` | `opencode debug agents` | `/doctor` |
| Agent Profiles | `--agent <name>` | `/agents` | `/agents` |
| Tasks / Subagents | `/tasks` | Background service | `/tasks` |
| History Revert | — | `/undo`, `/redo` | `/undo`, `/rewind` |
| Project Scaffold | `/init` | — | `/learn` |
| Side Question | `/btw` | `/btw` | `/btw` |
| Custom Extension | `.claude/commands/*.md` | `.opencode/commands/*.md` | `.agents/skills/*/SKILL.md` |

### 4.2 Keybinding Comparison

| Action | Claude Code | OpenCode v2 | Antigravity (`agy`) |
|:---|:---|:---|:---|
| Submit Prompt | `Enter` | `Enter` | `Enter` |
| Multiline Newline | `Shift+Enter`, `\Enter` | `Shift+Enter`, `Ctrl+J` | `Shift+Enter` |
| Graceful Interrupt | `Esc` | `Esc` | `Esc` |
| Hard Turn Abort | `Ctrl+C` | `Ctrl+C` | `Ctrl+C` |
| Process Exit | `Ctrl+C` x 2 (500ms) | `<leader> q` / `/exit` | `Ctrl+C` x 2 (500ms) |
| Mode / Gate Cycle | `Shift+Tab` | — | `Shift+Tab` |
| Verbose Feed Toggle | `Ctrl+O` | `/details` | — |
| Instant Tool Approval | — | — | `Ctrl+K` |
| File Mentions | `@` | `@` | `@` |
| Shell Passthrough | `!` | `!` | `!` |
| External Editor | `Ctrl+G` | `<leader> e` | `/editor` |

### 4.3 Status Line Comparison

| Attribute | Claude Code | OpenCode v2 | Antigravity (`agy`) |
|:---|:---|:---|:---|
| Primary Segments | Model/Effort, State, Context %, Cost | Model#variant, Agent, Context %, Cost | Model, State, Sandbox, Turn, Tokens |
| Cost Metering | Real-time USD spend | USD or `$0.00` | Token counts only (no USD) |
| Security Display | Active permission mode | — | `[sandboxed]` / `[unsandboxed]` |
| Narrow Viewport | Drops model, keeps tokens/cost | Drops agent, trims model | Drops sandbox & ID, keeps turn/state |

---

## 5. Synthesis for Substrate TUI (P5.3)

### 5.1 Canonical Slash Command Registry
Substrate synthesizes the best patterns into **19 canonical slash commands** (§4.7):

| Command | Argument Hint | Category | Aliases | Description |
|:---|:---|:---|:---|:---|
| `/help` | `[command]` | `core` | `?` | Displays interactive command catalogue and operational help. |
| `/mode` | `[permission_mode]` | `config` | — | Views or switches active run gate permission mode. |
| `/plan` | `[prompt]` | `control` | — | Triggers planning phase to generate structured run manifest. |
| `/run` | `[run_id]` | `control` | — | Initiates execution of current plan or resumes specified run. |
| `/status` | — | `state` | — | Displays current run lifecycle state, active task, and engine health. |
| `/tasks` | — | `state` | — | Displays interactive task board across task state lifecycles. |
| `/cost` | — | `state` | — | Shows cumulative session and run cost breakdown against budget caps. |
| `/models` | `[role]` | `config` | — | Lists configured model routing rules and active models per role. |
| `/agents` | — | `config` | — | Lists active worker profiles and configured agent definitions. |
| `/permissions`| — | `config` | — | Inspects tool permission rules, soft-denials, and gate approvals. |
| `/config` | `[key] [val]` | `config` | — | Inspects or edits Substrate configuration keys and overrides. |
| `/resume` | `<id>` | `control` | `/continue` | Reopens an existing run or session by identifier. |
| `/sessions` | — | `state` | — | Lists recent sessions and launches interactive session picker. |
| `/undo` | — | `control` | — | Rolls back last integrated task git commit and reverts state. |
| `/doctor` | — | `core` | — | Verifies environment prerequisites, backend harnesses, and sandbox. |
| `/init` | — | `core` | — | Initializes `.substrate/` configuration and project scaffolding. |
| `/clear` | — | `core` | `/cls` | Clears terminal screen buffer and prompt history. |
| `/exit` | — | `core` | `/quit`, `/q`| Gracefully terminates interactive TUI session with clean cleanup. |
| `/hooks` | — | `config` | — | Lists registered lifecycle hooks and gate policies. |

Custom command template expansion:
- Built-in commands take strict precedence over custom commands.
- Custom commands located in `.substrate/commands/<name>.md` are discovered dynamically.
- Custom command templates support positional arguments (`$1`, `$2`) and `$ARGUMENTS` substitution, expanding into full prompts sent to the governor or planner.

### 5.2 Canonical Keymap Specification
The canonical Substrate TUI keymap harmonizes Claude Code and OpenCode conventions:

| Key | Context | Action | Description |
|:---|:---|:---|:---|
| `Enter` | `prompt` | `submit_prompt` | Submits prompt buffer to governor or deterministic run loop. |
| `Esc` | `global` | `interrupt_or_dismiss`| Graceful interrupt: pauses run with `PAUSED(user_cancel)`, dismisses dialog, or clears prompt. |
| `Shift+Tab`| `prompt` | `cycle_permission_mode`| Cycles `--permission-mode` (`default` -> `plan` -> `acceptEdits` -> `dontAsk` -> `bypassPermissions`). |
| `Ctrl+C` x 2| `global` | `exit_process` | Displays exit confirmation on first press; cleanly exits (code 130) if pressed within 500ms. |
| `Ctrl+T` | `global` | `toggle_task_board` | Toggles task board split pane between hidden and visible states. |
| `Ctrl+O` | `global` | `toggle_verbose_feed` | Toggles event feed verbosity between compact summary and expanded trace. |
| `@` | `prompt` | `mention_file` | Triggers file-mention autocompletion against workspace paths. |
| `!` | `prompt` | `shell_passthrough` | Prefixes trailing command to execute in local shell. |

### 5.3 Responsive Status Line Architecture
The Substrate status line renders at the terminal bottom, adapting dynamically to viewport width (`SIGWINCH`).

#### Segment Priorities and Thresholds

| Segment ID | Label | Priority | Min Width | Description |
|:---|:---|:---|:---|:---|
| `state` | `Run State` | 1 (Highest) | 0 cols | Lifecycle state (`PLANNING`, `EXECUTING`, `PAUSED`, etc.). |
| `tasks` | `Task Progress`| 2 | 40 cols | Progress counter: `[tasks done/total]` (e.g. `[3/7 tasks]`). |
| `cost` | `Cost / Cap` | 3 | 60 cols | USD spend vs budget cap: `[cost / cap]` (e.g. `$0.042 / $0.50`). |
| `model` | `Model / Tier` | 4 (Lowest) | 100 cols | Model and effort tier: `[model/tier]` (e.g. `[sonnet/hi]`). |

#### Breakpoint Layouts

Wide viewport (width >= 100 cols):
```text
[sonnet/hi] [EXECUTING] [3/7 tasks] [$0.042 / $0.50]
```

Medium viewport (60 <= width < 100 cols):
```text
[EXECUTING] [3/7 tasks] [$0.042 / $0.50]
```

Narrow viewport (40 <= width < 60 cols):
```text
[EXECUTING] [3/7]
```

Extremely narrow viewport (width < 40 cols):
```text
[E]
```

### 5.4 Input Processing & Dispatch Logic
When the user presses `Enter` at the TUI prompt:
1. **Empty / Whitespace Check**: If buffer consists solely of whitespace, ignore `Enter` (no-op).
2. **Slash Command Dispatch (`/`)**:
   - Check against 19 canonical built-in commands. If matched, route to built-in command handler.
   - Else, search `.substrate/commands/<name>.md`. If found, substitute parameters and feed expanded prompt to runner.
   - Else, render error: `Unknown command '/<name>'. Type /help for available commands.`
3. **Shell Passthrough (`!`)**:
   - Strip leading `!` and execute trailing string in local subshell (`bash -c "<cmd>"`), streaming stdout/stderr to feed.
4. **File Mention (`@`)**:
   - When `@` token is typed, trigger fuzzy file selector across repository git tree.
5. **Run Submission**:
   - Submit text prompt to governor or planner runner.

### 5.5 Interrupt Handling, Signals, & State Transitions
- **`Ctrl+C` Double-Tap State Machine**:
  - *First Press*: Display banner `"Press Ctrl+C again to exit"` and start 500ms monotonic timer.
  - *Second Press within 500ms*: Emit exit signal, terminate child workers, restore terminal modes, exit with code `130`.
  - *Timer Expiry (> 500ms)*: Clear banner and reset interrupt counter to 0.
- **`Esc` Interrupt Semantics**:
  - If a run is actively executing: signal engine to pause run at next safe boundary with `PAUSED(user_cancel)`.
  - If a modal dialog or task board overlay is open: dismiss overlay and return focus to prompt input buffer.
  - If prompt input buffer contains unsubmitted text: clear input buffer.
  - *Debouncing*: Multiple rapid `Esc` presses are debounced to prevent duplicate pause events.
- **`Shift+Tab` Permission Mode Cycling**:
  - Only active when cursor is in prompt input buffer.
  - State machine transitions monotonically: `default` -> `plan` -> `acceptEdits` -> `dontAsk` -> `bypassPermissions` -> `default`.
  - Updates prompt status tag immediately.

### 5.6 Edge Cases & Resiliency Matrix

| Edge Case | Condition / Trigger | Handled Behavior |
|:---|:---|:---|
| ASCII Fallback | No ANSI/UTF-8 box-drawing support | Fallback to ASCII characters (`-`, `\|`, `+`, `[ ]`, `[x]`) for status line and borders. |
| Terminal Resize | `SIGWINCH` signal during run | Recalculate segment layout priorities immediately without redrawing corrupting buffer. |
| Command Collision | Custom command shares built-in name | Built-in command takes strict precedence; emit warning about shadowed custom file. |
| Rapid Interrupts | Rapid successive `Esc` spam | Engine debounces pause signal; idempotently maintains single `PAUSED` state. |
| Empty Prompt Input | `Enter` pressed on empty string | Ignored without dispatching empty runner turns or corrupting history. |
| Micro Viewport | Terminal width < 40 columns | Collapse status line to single-character state indicator (`P`, `E`, `!`, `OK`). |
