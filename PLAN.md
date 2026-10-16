# System Architecture & Implementation Plan: Multi-Harness Agentic Orchestrator

## 1. System Vision & Core Operating Principles

This document specifies the architecture for a custom, developer-controlled orchestration harness. The system couples high-reasoning frontier models for planning with cost-effective, high-speed execution runtimes, bypassing the token-bloat and "supervision tax" common in naive agentic loops.

### The Invariants
1. **Deterministic Logic Over Probabilistic Loops:** Orchestration state, process lifecycles, concurrency locks, file system mutations, and git state transitions are managed strictly by code (e.g., Python/TypeScript), not by LLM conversational turns.
2. **Context Window Isolation:** Subagents and dispatchers run in fresh, isolated context windows. Context amnesia and token degradation are prevented by restricting context to the minimal set of files and contracts required for the atomic task.
3. **Contract-First Planning:** The high-intelligence Planner is strictly forbidden from writing line-by-line implementation code. It produces architectural boundaries, type contracts, behavioral invariants, and verification criteria.
4. **Harness-Native Micro-Dispatching:** The system does not attempt to shoehorn local models into proprietary harnesses where tool-calling is fragile. Instead, it leverages each target harness's native micro-tier model (e.g., Haiku in Claude Code, Flash in Google Antigravity, local/DeepSeek in OpenCode) configured purely as a mechanical dispatcher.
5. **Two-Tier Escalation Gate:** Subagents self-heal local syntax/compiler errors once. Second-order failures break out of the execution loop immediately into a structured failure packet sent to the Planner for surgical re-planning.

---

## 2. Tiered System Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│ LAYER 1: OUTER HARNESS & LOCAL GOVERNOR (Host Machine)                 │
│ - Local Model (Qwen 2.5 / Llama 3 via Ollama/vLLM) + Core Engine       │
│ - Duties: Triage/Routing, Plan Validation, Git Worktree Management,    │
│   Process Lifecycle, and Escalation Routing                            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ CLI invocation & manifest handoff
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ LAYER 2: THE PLANNER (Frontier Model: Opus / Sonnet / Gemini Pro)      │
│ - Executes inside selected harness (Claude Code, Antigravity, OpenCode) │
│ - Ingests: Repo map, AGENTS.md / CLAUDE.md, User Request               │
│ - Emits: Task Manifest (DAG) + Individual Atomic Task Specs            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Machine-readable files on disk
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ LAYER 3: INNER HARNESS DISPATCHER (Native Fast/Cheap Model)            │
│ - Claude Code (Haiku) | Antigravity (Flash) | OpenCode (Local/DeepSeek)│
│ - Permissions: Tool calls to `subagent` only (Write/Edit/Bash DENIED)  │
│ - Duties: Reads manifest, launches parallel/sequential subagents      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Native child session tool calls
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ LAYER 4: ISOLATED WORKER SUBAGENTS                                     │
│ - Spawns in fresh context with parameterized `thinking_effort`         │
│ - Reads assigned task spec file, writes code, runs local test suite    │
│ - Reports 1-line success or packages deterministic Failure Packet      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Component Specifications

### Component A: The Outer Harness & Local Governor

The Outer Harness is a CLI/daemon written in Python or TypeScript. It controls the master state machine and interfaces with a local LLM via an OpenAI-compatible endpoint.

#### Responsibilities:
1. **Triage & Harness Selection:**
   * Receives user input.
   * If the user does not specify tools/models, the Local Model inspects the request complexity, language ecosystem, and repository structure.
   * Emits a routing directive containing:
     * `planner_harness`: (`claude-code` | `antigravity` | `opencode`)
     * `planner_model`: (e.g., `claude-3-7-sonnet`, `gemini-2.5-pro`)
     * `execution_harness`: Selected runtime for building
2. **Plan Validation (Syntactic & Structural Linter):**
   * Before execution begins, the Local Model verifies the Planner's output against structural criteria:
     * Are all target file paths valid or explicitly marked `CREATE`?
     * Are contracts, interfaces, and function headers fully declared without `// TODO`?
     * Is there an explicit verification command (test/lint) for every task?
     * Are tasks partitioned into clean dependency batches?
3. **Workspace Concurrency Management:**
   * For tasks flagged to run in parallel, the harness creates isolated **Git Worktrees** (`git worktree add .worktrees/task_id`) to prevent simultaneous file-access collisions.
   * Merges worktrees into the working branch upon task verification.

---

### Component B: The Planner Engine (Prompt & Output Standard)

The Planner is executed headlessly or interactively in the selected planning harness. 

#### System Persona & Hard Invariants:
* **Role:** Principal Software Architect.
* **Negative Constraint:** NEVER write interior function implementations or full code replacements. Writing code logic inside the plan burns expensive tokens and will fail the outer harness's validation gate.
* **Output Artifacts:**
  1. **A Master Manifest File:** Contains global dependencies, shared types, and an ordered DAG of batches containing task IDs, parallelization flags, target files, model tiers, and `thinking_effort` directives (`none` | `low` | `medium` | `high`).
  2. **Atomic Task Specification Files:** The Planner writes individual markdown files into a temporary directory (e.g., `.tasks/task_XX.md`). Each file contains:
     * Exported signatures / interfaces.
     * Behavioral logic as bulleted decision trees and invariants.
     * Guardrails (forbidden packages, reusable internal utilities).
     * Deterministic verification command (e.g., `npm test tests/foo.test.ts`).

---

### Component C: The Inner Harness Runtime & Mechanical Dispatcher

To use native subagent capabilities (like OpenCode's background subagents or Claude Code's `Agent` tool) without the expensive "supervision tax":

1. **Dispatcher Role Configuration:**
   * The Primary Agent inside the selected execution harness is configured using that harness's **native cheapest model**:
     * Claude Code $\to$ Claude 3.5 Haiku
     * Google Antigravity $\to$ Gemini 2.5 Flash
     * OpenCode $\to$ Local Qwen 2.5 Coder or DeepSeek-V3
   * **Restricted Tooling:** File-writing, code editing, and raw terminal tools are **revoked**. The Dispatcher only has access to:
     * Read the Master Manifest.
     * Spawn Subagents (`subagent` / `Agent` tool).
     * Write final execution status.
2. **Execution Protocol:**
   * The Dispatcher reads the current batch from the manifest.
   * If `parallel: true`, it invokes the subagent tool with `background: true` for every task in the batch.
   * The prompt passed to each subagent contains **only the file path to its individual task specification** (e.g., `"Execute .tasks/task_01.md"`), keeping the Dispatcher's context window nearly empty.
   * The Dispatcher waits at the batch barrier for all subagents in the batch to conclude.

---

### Component D: Worker Subagents & The Two-Tier Escalation Circuit Breaker

Subagents execute inside isolated child sessions initialized by the harness.

#### Worker Behavior:
1. **Execution:** Reads assigned task spec file, modifies the code, and runs the designated verification command.
2. **Tier-1 Local Retry (Syntax/Linter loop):**
   * If the verification command fails, the subagent captures `stderr`.
   * The subagent is permitted **one (1)** self-correction attempt focused purely on resolving compiler/test errors.
3. **Tier-2 Escalation Breakout (Architectural failure):**
   * If the task fails verification a second time, the subagent **aborts immediately**.
   * It builds a **Failure Packet** detailing:
     * Spec file path
     * Files modified & raw `git diff`
     * Exact `stderr` compiler/test output
     * Summary of attempted fixes
   * It writes this to a structured failure record and exits with an error status.
4. **Dispatcher Reaction:**
   * When a subagent exits with failure, the Dispatcher halts the entire batch.
   * The Dispatcher records an `ESCALATION_REQUIRED` state and exits.

---

### Component E: The Surgical Re-Planning Loop

When the Outer Harness detects an escalation exit:
1. The Outer Engine isolates the failed task. (Successful parallel tasks from the same batch are preserved or committed).
2. The Outer Harness spins up a targeted session with the **Planner Model**.
3. **Context fed to the Planner is surgical:**
   * The original `.tasks/task_XX.md`.
   * The `git diff` of what broke.
   * The compiler/test `stderr`.
4. **Prompt Directive to Planner:**
   > *"The implementation of task XX failed two verification attempts due to a contract or architectural mismatch. Do not write full code. Rewrite `.tasks/task_XX.md` with corrected interfaces, invariants, or revised edge-case logic."*
5. The revised spec is saved, and the Outer Harness re-triggers the execution batch.

---

## 4. Harness Abstraction Layer (HAL) Interface

The Outer Harness communicates with all three underlying runtimes via an abstract driver interface. This ensures that the core orchestration engine is decoupled from harness-specific CLI quirks.

```typescript
interface HarnessAdapter {
  name: "claude-code" | "antigravity" | "opencode";
  
  // Checks CLI installation, auth tokens, and local daemon status
  validateEnvironment(): Promise<boolean>;

  // Spawns the planner to produce the manifest and task files
  executePlanning(params: {
    request: string;
    model: string;
    contextFiles: string[];
    outputDir: string;
  }): Promise<{ manifestPath: string; taskDir: string }>;

  // Spawns the mechanical dispatcher inside the harness runtime
  executeBatchRun(params: {
    manifestPath: string;
    taskDir: string;
    dispatcherModel: string;
  }): Promise<BatchRunResult>;
}

interface BatchRunResult {
  status: "SUCCESS" | "ESCALATION_REQUIRED";
  completedTasks: string[];
  failedTask?: {
    taskId: string;
    specFile: string;
    gitDiff: string;
    stderr: string;
  };
}
```

---

## 5. Implementation Roadmap for the Building Agent

The implementing agent should construct the system in the following sequential phases:

### Phase 1: Storage, State Machine & Workspace Core
* Implement the core state machine (Init $\to$ Route $\to$ Plan $\to$ Validate $\to$ Dispatch $\to$ Verify $\to$ Escalate $\to$ Complete).
* Implement Git workspace management: directory sandboxing, worktree branching for parallel tasks, and programmatic diff/patch operations.
* Implement structured logging to capture raw agent executions, token consumption, and stderr streams.

### Phase 2: Local Governor & Routing Engine
* Implement the Local LLM client (using OpenAI-compatible endpoints for Ollama/vLLM/LM Studio).
* Construct the routing evaluation prompt (evaluates task difficulty and selects the planner harness/model).
* Build the structural Plan Linter to inspect generated manifests before executing any subagents.

### Phase 3: Harness Adapters (HAL)
* **OpenCode Adapter:**
  * Generate dynamic `opencode.jsonc` profiles configuring custom primary agents (dispatcher) and subagents (workers).
  * Wire CLI invocations (`opencode run`) with structured outputs.
* **Claude Code Adapter:**
  * Configure custom subagents via `.claude/agents/worker.md` and slash-commands for dispatching.
  * Wire headless non-interactive mode (`claude -p`).
* **Antigravity Adapter:**
  * Wrap CLI execution with Gemini Flash dispatching directives.

### Phase 4: The Dispatcher Configuration & Status Bridge
* Create the restricted system prompts and permission sets for the internal Dispatchers across all three runtimes.
* Implement the status protocol: ensure subagents emit concise machine-readable results, and implement the Failure Packet generation logic on double-faults.

### Phase 5: End-to-End Surgical Escalation Loop & Integration Tests
* Write automated integration tests simulating:
  1. A multi-task batch that passes on the first attempt.
  2. A subagent that fails on a syntax error, self-corrects once, and passes.
  3. A subagent that fails twice, triggering the circuit breaker, calling the Planner for a patch, and completing on the second cycle.
* Measure and verify token expenditure across each phase to prove the elimination of the supervision tax.
