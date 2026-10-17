# Harness Adapter Architecture and Protocol Reference

Substrate coordinates external AI agent harnesses without privileged backends. Substrate does not maintain internal model weights or call LLM inference APIs directly. Instead, all reasoning and code generation tasks are delegated to external command-line agent tools—specifically **Claude Code** (`claude`), **OpenCode** (`opencode`), and **Antigravity** (`agy`).

---

## Symmetric Peer Philosophy

In Substrate, every external harness is treated as an interchangeable peer runner:

1. **Zero Privileged Runtimes**: No harness receives special internal API hooks or hidden capabilities. Every harness communicates via child process standard I/O streams (`stdin`, `stdout`, `stderr`).
2. **Standardized Process Supervision**: The Substrate process supervisor launches child CLI harnesses, applies environmental controls, injects permission constraints, and enforces timeout and budget kills.
3. **Normalized Event Streaming**: Disparate stream formats (such as Claude's NDJSON stream, OpenCode's JSON events, and Antigravity's stream events) are parsed by normalizers into unified, strongly typed `BackendEvent` sequences.

---

## Adapter Interface Contracts

Every harness adapter implements the `HarnessAdapter` interface defined in `src/contracts/index.ts`.

### `HarnessAdapter`

```ts
export interface HarnessAdapter {
  readonly capabilities: Capabilities;
  validateEnvironment(): Promise<EnvReport>;
  spawn(req: SpawnRequest): SessionHandle;
}
```

- `capabilities`: Static declaration of feature flags, version pins, and concurrency limits.
- `validateEnvironment()`: Probes the local operating system to verify binary presence, executable permissions, and version alignment.
- `spawn(req)`: Launches a child harness session conforming to the requested parameters and returns a handle.

### `Capabilities`

Defines the feature matrix supported by a given backend harness:

```ts
export interface Capabilities {
  name: "claude" | "opencode" | "agy" | "fake";
  version_pin: string;
  effort: boolean;
  structured_output: boolean;
  budget_flag: boolean;
  cost_reported: boolean;
  resume: boolean;
  permission_denial_signal: "event" | "stderr" | "none";
  sandbox_flag: boolean;
  native_subagents_headless: boolean;
  max_concurrency?: number;
}
```

- `version_pin`: Authoritative version tested against (e.g. `claude: 2.1.301`, `opencode: 2.0.21`, `agy: 1.4.0`).
- `effort`: Whether the harness supports native reasoning effort flags (`--effort`).
- `cost_reported`: Whether the harness returns explicit dollar costs or requires token pricing computation.
- `permission_denial_signal`: How tool denials are communicated (`"event"` in structured stream, `"stderr"` scan, or `"none"`).

### `SpawnRequest`

Parameters provided to an adapter to launch a worker or planner session:

```ts
export interface SpawnRequest {
  role: "governor" | "planner" | "worker" | "test-writer" | "reviewer";
  cwd: string;
  prompt: string;
  system_append?: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permission: {
    allow: string[];
    deny: string[];
  };
  json_schema?: Record<string, unknown>;
  budget: {
    max_usd?: number;
    max_tokens?: number;
    timeout_min?: number;
    max_turns?: number;
    timeout_ms: number;
  };
  env?: Record<string, string>;
  add_dirs?: string[];
  session?: {
    id?: string;
    resume?: string;
    fork?: boolean;
  };
}
```

### `SessionHandle` and `SessionResult`

The active process handle and final result contract:

```ts
export interface SessionHandle {
  pid: number;
  events: AsyncIterable<BackendEvent>;
  result(): Promise<SessionResult>;
  kill(reason: "budget" | "timeout" | "cancel"): Promise<void>;
}

export interface SessionResult {
  ok: boolean;
  session_id: string;
  final_text: string;
  usage: UsageRecord;
  exit_code: number | null;
  denials: Array<{ tool: string; reason?: string }>;
  killed_for?: "budget" | "timeout" | "cancel";
}
```

### `BackendEvent`

Unified discriminated union emitted asynchronously during session execution:

| Event Type | Fields | Description |
|---|---|---|
| `session.started` | `session_id` | Emitted when harness session initializes. |
| `assistant.text` | `text` | Streamed text output from the assistant model. |
| `tool.call` | `id`, `name`, `input_summary` | Assistant invoked a tool (e.g. `Bash`, `Write`). |
| `tool.result` | `id`, `ok`, `output_summary` | Execution result returned from tool call. |
| `permission.denied` | `tool`, `reason` | A tool call was blocked by permission policy. |
| `usage` | `record`, `cumulative` | Token usage and cost record. |
| `subagent` | `parent_id`, `raw` | Harness spawned internal child subagent. |
| `error` | `kind`, `message` | Typed error (`rate_limit`, `auth`, `crash`, `timeout`, `protocol`). |
| `session.result` | `ok`, `stop_reason`, `final_text`, `usage`, `exit_code` | Session terminal event. |

---

## Mandatory Adapter Obligations (§11.1)

All Substrate harness adapters must strictly fulfill 11 core obligations:

1. **Explicit Model and Effort Passing**:  
   Always pass `--model` explicitly (and `--effort` where supported). Never allow the external harness to default to unspecified or changing upstream models.
2. **Structured Result Parsing**:  
   Never treat child process exit code alone as success. An external harness may exit with code 0 despite a soft tool denial or partial execution failure. Always read and validate the structured result payload.
3. **Raw Stream Persistence**:  
   Persist all raw, unparsed NDJSON and stdout streams to `.substrate/runs/<run_id>/raw/` before or alongside normalization. This guarantees an audit trail for debugging and replay.
4. **Normalized Denial Reporting**:  
   Detect and emit typed `permission.denied` events. For Claude, inspect `permission_denials` in the structured result. For Antigravity, scan stderr for soft-deny patterns.
5. **Computed Cost Fallbacks**:  
   When a harness reports token counts without dollar figures (e.g. Antigravity or local servers), compute USD spend using the authoritative `PricingTable` in settings.
6. **Session Resume Support**:  
   Implement session continuation (`session.resume`) allowing the engine to resume existing harness sessions across heal and replan cycles.
7. **Worktree Isolation**:  
   Strictly enforce that the child process working directory (`cwd`) is pinned to the isolated Git worktree assigned to the task.
8. **Scrubbed Environment**:  
   Sanitize the child process environment. Forward only allowlisted system variables and redact secrets, API keys, and sensitive tokens from logs and packets.
9. **Version Pin Verification**:  
   In `validateEnvironment()`, invoke the installed CLI with `--version` and compare against `version_pin`. Report version drift in `substrate doctor`.
10. **Concurrency Caps**:  
    Enforce per-backend concurrency limits (`max_concurrency`) to avoid triggering provider rate limits or system thrashing.
11. **Typed Error Classification**:  
    Categorize unexpected harness behaviors into typed `error` events: `rate_limit`, `auth`, `crash`, `timeout`, or `protocol`.

---

## Conformance Testing

Substrate enforces behavioral consistency across backends using a shared test suite (`test/conformance/suite.ts`).

### Running Conformance Tests

The conformance runner validates adapter compliance against both real and simulated harnesses:

```ts
import { runAdapterConformanceSuite } from "./test/conformance/suite.js";
import { ClaudeAdapter } from "./src/backends/adapters/claude.js";

runAdapterConformanceSuite("ClaudeAdapter", () => new ClaudeAdapter(), {
  live: process.env.SUBSTRATE_LIVE === "1",
  timeoutMs: 30000,
  maxCostUsd: 1.0,
});
```

The conformance battery validates:
- Capabilities schema compliance.
- Environment validation (`validateEnvironment()`).
- Event streaming order and termination.
- Tool denial detection and `permission.denied` emission.
- Process supervisor kill mechanics on budget and timeout caps.
- Session resume fidelity.

---

## Reference Implementation: `FakeAdapter`

For deterministic unit and integration testing without network calls or external CLI tools, Substrate provides `FakeAdapter` in `test/conformance/fake-adapter.ts`.

`FakeAdapter` simulates harness behaviors through scripted scenarios:

```ts
import { FakeAdapter } from "./test/conformance/fake-adapter.js";

const adapter = new FakeAdapter();
const handle = adapter.spawn({
  role: "worker",
  cwd: "/tmp/worktree",
  prompt: "scenario:soft_deny",
  model: "fake-model",
  permission: { allow: ["Read"], deny: ["Bash"] },
  budget: { timeout_ms: 5000 },
});
```

### Supported Test Scenarios

- `scenario:success`: Emits assistant text, mock tool calls, usage records, and cleanly exits 0.
- `scenario:resume`: Simulates session resumption from a previous state.
- `scenario:soft_deny`: Simulates tool denial and emits `permission.denied`.
- `scenario:hang`: Simulates a hung child process, validating supervisor timeout kills.
- `scenario:crash`: Simulates an unexpected process exit with code 1.
- `scenario:budget_overshoot`: Simulates token spend exceeding requested budget limits.
- `scenario:rate_limit`: Simulates upstream API 429 rate limit responses.
