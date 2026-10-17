---
version: 1
asOf: "2026-10-17T05:45:00Z"
targetRef: "2dfa7b210d567f996aea67971cae219ae10e21c3"
verdict: "pass_with_findings"
domains:
  sandbox_containment:
    status: "fail"
    findingsCount: 2
    summary: "Bubblewrap commands correctly enforce root immutability (--ro-bind / /), worktree binds, and network unsharing, but fail open when bubblewrap is missing and lack root squash and extraBinds path assertions."
  env_scrubbing:
    status: "fail"
    findingsCount: 2
    summary: "Claude and Agy adapters enforce system allowlists, but OpenCode and process supervisor inherit full unscrubbed parent process.env when options.env is omitted; custom task env variables lack sensitive key screening."
  redaction:
    status: "fail"
    findingsCount: 2
    summary: "Core redaction utility redacts AWS keys, GitHub tokens, and private keys, but omits email address sanitization; failure packets, event stores, and CLI output streams bypass secret filtering."
  path_traversal:
    status: "fail"
    findingsCount: 2
    summary: "isSafePath provides robust boundary and symlink checks, but spec parser and linter allow unsupported glob metacharacters and traversal prefixes, and revertOutOfScope lacks safe path assertions."
  credential_handling:
    status: "warn"
    findingsCount: 2
    summary: "Strict zero-credential storage and zero-prompting adherence verified across CLI, config, and sessions under .substrate/; however, raw adapter stream files are created without 0600 permission restrictions."
findings:
  - id: "SEC-001"
    domain: "sandbox_containment"
    severity: "high"
    title: "Silent sandbox bypass when bubblewrap binary is missing on Linux host"
    sourceFiles:
      - "src/verify/runner.ts:30"
    description: "In VerifyRunnerImpl.runVerify, useSandbox is evaluated as (options.sandbox === true && sandboxAvailable). When running on Linux without the bwrap binary installed, sandboxAvailable evaluates to false, causing the runner to silently fall back to executing commands in un-sandboxed /bin/bash directly on the host rather than failing closed with a fatal diagnostic."
    remediation: "In src/verify/runner.ts, check if options.sandbox is true on Linux; if sandboxAvailable is false, throw a fatal error or emit a blocking diagnostic requiring an explicit --no-sandbox override."
    proposedWpId: "P6.4.1"
  - id: "SEC-002"
    domain: "sandbox_containment"
    severity: "high"
    title: "Unvalidated extraBinds mount injection and missing user namespace root squash"
    sourceFiles:
      - "src/verify/sandbox.ts:74"
      - "src/verify/sandbox.ts:82"
    description: "BwrapSandboxImpl.wrapCommand iterates over options.extraBinds and appends --bind arguments without verifying paths using isSafePath against an allowlist, allowing arbitrary host filesystem mounts. Additionally, wrapCommand mounts host /tmp directly as read-write and omits --unshare-user with UID/GID squash mapping, risking container privilege escalation."
    remediation: "In src/verify/sandbox.ts, validate all extraBinds paths with assertSafePath against allowlisted directories, mount /tmp as a private tmpfs, and append --unshare-user with UID/GID squash mappings."
    proposedWpId: "P6.4.2"
  - id: "SEC-003"
    domain: "env_scrubbing"
    severity: "high"
    title: "Full parent environment inheritance in OpenCode adapter and process supervisor"
    sourceFiles:
      - "src/backends/process.ts:233"
      - "src/backends/adapters/opencode.ts:239"
      - "src/backends/adapters/opencode.ts:319"
    description: "spawnSupervisedProcess defaults options.env to raw process.env when options.env is undefined. OpenCodeAdapter.spawn passes env: req.env directly without filtering, causing worker sessions to inherit the full host environment when req.env is omitted. Furthermore, validateEnvironment in OpenCodeAdapter and AgyAdapter runs CLI --version checks with unscrubbed process.env."
    remediation: "In src/backends/process.ts, default options.env to an allowlist-scrubbed environment dictionary. In src/backends/adapters/opencode.ts, apply strict allowlist scrubbing before passing env to child processes."
    proposedWpId: "P6.4.3"
  - id: "SEC-004"
    domain: "env_scrubbing"
    severity: "medium"
    title: "Unverified custom environment variable injection without credential pattern screening"
    sourceFiles:
      - "src/verify/runner.ts:47"
      - "src/backends/adapters/claude.ts:106"
      - "src/backends/adapters/agy.ts:176"
    description: "Custom environment variables supplied via Command.env or SpawnRequest.env are merged directly into child process environments across VerifyRunnerImpl, ClaudeAdapter.scrubClaudeEnv, and AgyAdapter.spawn without screening keys against sensitive credential patterns (*KEY*, *TOKEN*, *SECRET*, *AUTH*, *PASSWD*, *CREDENTIAL*, ANTHROPIC_*, OPENAI_*, GITHUB_*, AWS_*)."
    remediation: "Implement a shared utility to screen all custom environment variable keys against sensitive credential patterns and reject or scrub matches prior to process spawning."
    proposedWpId: "P6.4.4"
  - id: "SEC-005"
    domain: "redaction"
    severity: "high"
    title: "Failure packets, event logs, and CLI output bypass secret redaction"
    sourceFiles:
      - "src/engine/packet.ts:58"
      - "src/engine/packet.ts:96"
      - "src/store/event-store.ts:46"
      - "src/cli/output.ts:58"
      - "src/cli/output.ts:86"
      - "src/cli/output.ts:117"
    description: "buildFailurePacket writes raw diff patches, worker summaries, and verify tails to disk (.patch and .json files) without running them through redactSecrets. EventStoreImpl.append writes unredacted event objects to events.jsonl, and CLI output formatters write unredacted error messages and stream events to stdout/stderr."
    remediation: "Pass diff patches, worker summaries, and verify tails through redactSecrets before writing failure packets; apply redactSecrets in EventStoreImpl.append and in CLI formatters."
    proposedWpId: "P6.4.5"
  - id: "SEC-006"
    domain: "redaction"
    severity: "medium"
    title: "Missing email address pattern in secret redaction utility"
    sourceFiles:
      - "src/util/index.ts:130"
    description: "SECRET_PATTERNS in src/util/index.ts contains regular expressions for AWS access keys, GitHub tokens, and private keys, but omits the email address redaction pattern ([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+) required by the specification and privacy guidelines."
    remediation: "Add /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+/g to SECRET_PATTERNS in src/util/index.ts."
    proposedWpId: "P6.4.6"
  - id: "SEC-007"
    domain: "path_traversal"
    severity: "high"
    title: "Spec parser and linter lack validation for glob metacharacters and escaping patterns"
    sourceFiles:
      - "src/spec/parser.ts:101"
      - "src/spec/rules.ts:376"
      - "src/util/index.ts:101"
    description: "parseTaskSpec and lint rule L006 do not reject glob expressions in read, write, create, or protected that contain unsupported glob special characters ([, {, }, (, ), !, +, @, \\, ], |) or relative directory traversal prefixes (../). picomatch evaluates these patterns without restriction, allowing worktree scope escapes."
    remediation: "Add frontmatter validation in src/spec/parser.ts and rule L006 rejecting unsupported glob characters and any path or glob attempting to traverse outside the worktree root."
    proposedWpId: "P6.4.7"
  - id: "SEC-008"
    domain: "path_traversal"
    severity: "medium"
    title: "Missing safe path verification during out-of-scope file reversion"
    sourceFiles:
      - "src/git/scope.ts:173"
      - "src/git/scope.ts:197"
    description: "ScopeEnforcerImpl.revertOutOfScope receives violation file paths and executes path.join(worktreePath, file) followed by rmSync(full, { recursive: true, force: true }) without verifying that file satisfies isSafePath(worktreePath, file), creating potential risk if violation strings contain traversal components."
    remediation: "In src/git/scope.ts, invoke assertSafePath(worktreePath, file) on each violation path prior to git checkout or rmSync deletion."
    proposedWpId: "P6.4.8"
  - id: "SEC-009"
    domain: "credential_handling"
    severity: "medium"
    title: "Insecure default file permissions on raw adapter NDJSON streams"
    sourceFiles:
      - "src/backends/adapters/claude.ts:196"
      - "src/backends/adapters/agy.ts:202"
    description: "ClaudeAdapter and AgyAdapter create raw stream files under .substrate/runs/<run_id>/raw/*.ndjson using createWriteStream and appendFileSync without specifying mode 0o600. The files are created with default umask permissions (0644 or 0664), exposing raw session traces to local users on shared filesystems."
    remediation: "Pass { mode: 0o600 } when opening raw write streams and appending raw chunks in ClaudeAdapter and AgyAdapter, and ensure the parent raw/ directory is created with mode 0o700."
    proposedWpId: "P6.4.9"
  - id: "SEC-010"
    domain: "credential_handling"
    severity: "info"
    title: "Invariant I12 zero-credential storage and zero CLI prompting verified"
    sourceFiles:
      - "src/store/sessions.ts:57"
      - "src/config/index.ts:146"
      - "src/cli/dispatcher.ts:204"
    description: "Systematic review of .substrate/ session, settings, and run stores confirms no credentials, tokens, or passwords are stored. CLI command parsers and options contain zero credential prompting, adhering fully to Invariant I12."
    remediation: "No remediation required. Maintained as a compliance baseline."
followUpWps:
  - wpId: "P6.4.1"
    findingId: "SEC-001"
    title: "Enforce fail-closed bubblewrap sandbox requirement in verify runner"
    writeSet:
      - "src/verify/runner.ts"
    requiresApproval: false
  - wpId: "P6.4.2"
    findingId: "SEC-002"
    title: "Harden bubblewrap argument construction with user namespace squash and extraBinds validation"
    writeSet:
      - "src/verify/sandbox.ts"
    requiresApproval: false
  - wpId: "P6.4.3"
    findingId: "SEC-003"
    title: "Strict environment allowlisting in process supervisor and OpenCode adapter"
    writeSet:
      - "src/backends/process.ts"
      - "src/backends/adapters/opencode.ts"
    requiresApproval: false
  - wpId: "P6.4.4"
    findingId: "SEC-004"
    title: "Screen custom environment variables against sensitive credential patterns"
    writeSet:
      - "src/verify/runner.ts"
      - "src/backends/adapters/claude.ts"
      - "src/backends/adapters/agy.ts"
    requiresApproval: true
  - wpId: "P6.4.5"
    findingId: "SEC-005"
    title: "Integrate secret redaction into failure packets, event stores, and CLI output formatters"
    writeSet:
      - "src/engine/packet.ts"
      - "src/store/event-store.ts"
      - "src/cli/output.ts"
    requiresApproval: true
  - wpId: "P6.4.6"
    findingId: "SEC-006"
    title: "Add email address redaction regex to core secret redaction utility"
    writeSet:
      - "src/util/index.ts"
    requiresApproval: true
  - wpId: "P6.4.7"
    findingId: "SEC-007"
    title: "Enforce strict glob pattern syntax validation and worktree boundary containment in spec parser and linter"
    writeSet:
      - "src/spec/parser.ts"
      - "src/spec/rules.ts"
    requiresApproval: true
  - wpId: "P6.4.8"
    findingId: "SEC-008"
    title: "Assert safe path containment in scope enforcer out-of-scope file reversion"
    writeSet:
      - "src/git/scope.ts"
    requiresApproval: true
  - wpId: "P6.4.9"
    findingId: "SEC-009"
    title: "Restrict raw backend stream files to mode 0600 user-only permissions"
    writeSet:
      - "src/backends/adapters/claude.ts"
      - "src/backends/adapters/agy.ts"
    requiresApproval: true
---

# Substrate Comprehensive Security Review

**As of:** 2026-10-17T05:45:00Z  
**Target Reference:** `2dfa7b210d567f996aea67971cae219ae10e21c3` (`build/P6.2-g1`)  
**Audit Verdict:** `pass_with_findings`  
**Standard Reference:** [SUBSTRATE-PLAN.md](../../SUBSTRATE-PLAN.md) §2 (Invariants), §10 (Budgets, Safety, Sandbox), Appendix A (Contracts), and Task Spec P6.2.

---

## 1. Executive Summary

This read-only security audit evaluated the Substrate orchestration engine across five critical security domains: **Sandbox Containment**, **Environment Scrubbing**, **Secret Redaction**, **Path Traversal & Glob Safety**, and **Credential Handling (Invariant I12)**.

The audit verified strong architectural boundaries in core areas:
- Full adherence to **Invariant I12**: zero credential storage, zero token copying, zero CLI password prompts, and complete reliance on user-authenticated external CLIs.
- Proper bubblewrap root filesystem immutability (`--ro-bind / /`), child process cleanup (`--die-with-parent`), and default network namespace isolation (`--unshare-net`).
- Robust base safe path verification (`isSafePath`) checking null bytes, segment escapes, and canonical ancestor symlink resolution.

However, several critical and high-severity security weaknesses were identified that require remediation:
1. **Silent Sandbox Bypass:** When bubblewrap is missing on Linux, `VerifyRunnerImpl` silently executes commands unconfined on the host.
2. **Environment Inheritance:** `OpenCodeAdapter` and `spawnSupervisedProcess` allow full parent `process.env` inheritance when `options.env` is omitted.
3. **Redaction Gaps:** `FailurePacket` generation, `EventStoreImpl` event logs, and CLI output formatters bypass `redactSecrets`, and `redactSecrets` lacks email address filtering.
4. **Glob Scope Escapes:** Spec frontmatter parser does not reject unsupported glob special characters or relative directory escapes.
5. **Raw Stream Permissions:** Raw NDJSON trace files are created with permissive default umask permissions rather than `0600`.

Nine follow-up work packages (`P6.4.1` through `P6.4.9`) are proposed. In accordance with the Task Spec governance rules, because total proposed remediation packages exceed 3, **explicit user approval is required prior to scheduling follow-up packages beyond P6.4.3**.

---

## 2. Domain Audit Summaries

| Domain | Status | Findings | Assessment Summary |
|---|:---:|:---:|---|
| **Sandbox Containment** | `fail` | 2 | Root immutability, worktree binding, and network isolation are implemented; however, the engine silently falls back to un-sandboxed host execution if `bwrap` is missing on Linux, and `wrapCommand` lacks root squash and `extraBinds` validation. |
| **Environment Scrubbing** | `fail` | 2 | Claude and Agy adapters scrub parent environment variables; however, the OpenCode adapter and process supervisor leak unscrubbed `process.env` when `options.env` is undefined, and custom task environment variables lack sensitive key screening. |
| **Secret Redaction** | `fail` | 2 | Core regexes redact AWS keys, GitHub tokens, and private keys, but omit email addresses; failure packet JSON/patches, event store logs, and CLI formatters omit secret filtering. |
| **Path Traversal & Globs** | `fail` | 2 | `isSafePath` effectively blocks traversal and out-of-root symlinks; however, spec declarations do not reject unsupported glob characters or traversal prefixes (`../`), and `revertOutOfScope` lacks safe path assertions. |
| **Credential Handling (I12)** | `warn` | 2 | Strict zero-credential storage and zero-prompting confirmed across CLI and `.substrate/`; however, raw adapter NDJSON streams are created with permissive default umask permissions rather than `0600`. |

---

## 3. Detailed Security Findings

### SEC-001: Silent sandbox bypass when bubblewrap binary is missing on Linux host
- **Domain:** `sandbox_containment`
- **Severity:** `high`
- **Source Files:** [`src/verify/runner.ts:30`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/verify/runner.ts#L30)
- **Description:** In `VerifyRunnerImpl.runVerify`, `useSandbox` is computed as `options.sandbox === true && sandboxAvailable`. If `bwrap` is not installed on a Linux host, `sandboxAvailable` evaluates to `false`. Instead of raising a fatal error or emitting a blocking diagnostic, the runner silently executes verification commands directly in `/bin/bash` without filesystem or network sandboxing.
- **Trigger Scenario:** A verification run configured with `sandbox: true` executing on a Linux container or runner lacking `/usr/bin/bwrap`. The test commands run with full unconfined access to the host filesystem and network.
- **Remediation:** When `options.sandbox === true` on Linux and `sandboxAvailable === false`, throw a fatal exception or emit a blocking diagnostic requiring an explicit `--no-sandbox` command override.
- **Proposed Follow-Up:** `P6.4.1`

### SEC-002: Unvalidated extraBinds mount injection and missing user namespace root squash
- **Domain:** `sandbox_containment`
- **Severity:** `high`
- **Source Files:** [`src/verify/sandbox.ts:74`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/verify/sandbox.ts#L74), [`src/verify/sandbox.ts:82-86`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/verify/sandbox.ts#L82-L86)
- **Description:** `BwrapSandboxImpl.wrapCommand` mounts `/tmp` directly from host `/tmp` (`--bind /tmp /tmp`) and iterates over caller-supplied `options.extraBinds` without asserting `isSafePath` against allowlisted directories. Furthermore, `wrapCommand` omits `--unshare-user` with root squash UID/GID mappings, allowing processes with root capabilities to potentially manipulate user namespaces on the host.
- **Trigger Scenario:** A task or runner configuration supplying `extraBinds: ["/etc", "/var/run"]` mounts host system directories read-write into the bubblewrap sandbox.
- **Remediation:** Validate all `extraBinds` entries using `assertSafePath` against allowlisted paths, mount `/tmp` as a private tmpfs (`--tmpfs /tmp`), and add `--unshare-user` with UID/GID squash mapping (`--uid 1000 --gid 1000`).
- **Proposed Follow-Up:** `P6.4.2`

### SEC-003: Full parent environment inheritance in OpenCode adapter and process supervisor
- **Domain:** `env_scrubbing`
- **Severity:** `high`
- **Source Files:** [`src/backends/process.ts:233-235`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/backends/process.ts#L233-L235), [`src/backends/adapters/opencode.ts:239-245`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/backends/adapters/opencode.ts#L239-L245), [`src/backends/adapters/opencode.ts:315-321`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/backends/adapters/opencode.ts#L315-L321)
- **Description:** In `spawnSupervisedProcess`, when `options.env` is undefined, `env` defaults to `process.env`. `OpenCodeAdapter.spawn` passes `env: req.env` directly; when `req.env` is omitted (as in standard worker runs in `src/roles/worker.ts`), the child process inherits the unscrubbed parent environment, including any host API tokens or secrets. In addition, `OpenCodeAdapter.validateEnvironment` and `AgyAdapter.validateEnvironment` run CLI version checks with unscrubbed `process.env`.
- **Trigger Scenario:** A worker spawned via `OpenCodeAdapter` with no custom `req.env` inherits all environment variables from the Substrate orchestrator process.
- **Remediation:** In `spawnSupervisedProcess`, default `options.env` to a strictly scrubbed environment dictionary. In `OpenCodeAdapter`, apply `scrubEnvironment` using the standard allowlist prior to spawning.
- **Proposed Follow-Up:** `P6.4.3`

### SEC-004: Unverified custom environment variable injection without credential pattern screening
- **Domain:** `env_scrubbing`
- **Severity:** `medium`
- **Source Files:** [`src/verify/runner.ts:47-49`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/verify/runner.ts#L47-L49), [`src/backends/adapters/claude.ts:106-112`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/backends/adapters/claude.ts#L106-L112), [`src/backends/adapters/agy.ts:176-180`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/backends/adapters/agy.ts#L176-L180)
- **Description:** Custom environment variables passed via `Command.env` or `SpawnRequest.env` are merged directly into child process environments without screening keys against sensitive credential patterns (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*AUTH*`, `*PASSWD*`, `*CREDENTIAL*`, `ANTHROPIC_*`, `OPENAI_*`, `GITHUB_*`, `AWS_*`).
- **Trigger Scenario:** A task spec frontmatter injecting `env: { AWS_SECRET_ACCESS_KEY: "..." }` into verify commands or worker sessions without validation.
- **Remediation:** Introduce a screening function that validates all custom environment keys against sensitive pattern regexes and throws or strips offending keys before merging into the child environment.
- **Proposed Follow-Up:** `P6.4.4`

### SEC-005: Failure packets, event logs, and CLI output bypass secret redaction
- **Domain:** `redaction`
- **Severity:** `high`
- **Source Files:** [`src/engine/packet.ts:58,96`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/engine/packet.ts#L58), [`src/store/event-store.ts:46`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/store/event-store.ts#L46), [`src/cli/output.ts:58,86,117`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/cli/output.ts#L58)
- **Description:** `buildFailurePacket` writes git diff patches (`diffResult.patch`), worker summaries, and verify tails to disk (`.patch` and `.json`) without calling `redactSecrets`. `EventStoreImpl.append` writes unredacted engine events to `.substrate/runs/<run_id>/events.jsonl`, and CLI output formatters write raw error messages and stream events to standard streams without filtering secrets.
- **Trigger Scenario:** A failed worker attempt whose git diff or verify stderr output contains an accidental token is persisted unredacted to disk and printed to the terminal.
- **Remediation:** Filter diff patches, summaries, and verification tails through `redactSecrets` before persisting failure packets; sanitize event payloads in `EventStoreImpl.append` and console outputs in `OutputFormatter`.
- **Proposed Follow-Up:** `P6.4.5`

### SEC-006: Missing email address pattern in secret redaction utility
- **Domain:** `redaction`
- **Severity:** `medium`
- **Source Files:** [`src/util/index.ts:130-134`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/util/index.ts#L130-L134)
- **Description:** `SECRET_PATTERNS` in `src/util/index.ts` contains patterns for AWS keys, GitHub tokens, and private keys, but omits the email address regex pattern (`[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+`) mandated by the task specification and subagent privacy rules.
- **Trigger Scenario:** Author email addresses in git patches or worker summaries remain unredacted in failure packets and event logs.
- **Remediation:** Append `/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g` to `SECRET_PATTERNS` in `src/util/index.ts`.
- **Proposed Follow-Up:** `P6.4.6`

### SEC-007: Spec parser and linter lack validation for glob metacharacters and escaping patterns
- **Domain:** `path_traversal`
- **Severity:** `high`
- **Source Files:** [`src/spec/parser.ts:101`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/spec/parser.ts#L101), [`src/spec/rules.ts:376-406`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/spec/rules.ts#L376-L406), [`src/util/index.ts:101`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/util/index.ts#L101)
- **Description:** `parseTaskSpec` and lint rule `L006` do not validate glob patterns declared in `read`, `write`, `create`, or `protected` against unsupported special characters (`[`, `{`, `}`, `(`, `)`, `!`, `+`, `@`, `\`, `]`, `|`) or relative directory escape prefixes (`../`). `matchGlob` delegates directly to `picomatch`, allowing complex patterns and scope escapes to pass frontmatter validation.
- **Trigger Scenario:** A task specification declaring `read: ["../**"]` or `write: ["!(test)/**"]` bypasses frontmatter validation and allows matching outside the worktree.
- **Remediation:** In `src/spec/parser.ts` and `src/spec/rules.ts`, reject glob patterns containing unsupported special characters or relative directory escape prefixes (`..`).
- **Proposed Follow-Up:** `P6.4.7`

### SEC-008: Missing safe path verification during out-of-scope file reversion
- **Domain:** `path_traversal`
- **Severity:** `medium`
- **Source Files:** [`src/git/scope.ts:173-201`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/git/scope.ts#L173-L201)
- **Description:** `ScopeEnforcerImpl.revertOutOfScope` accepts violation file paths and performs `join(worktreePath, file)` followed by `rmSync(full, { recursive: true, force: true })` without asserting `isSafePath(worktreePath, file)`.
- **Trigger Scenario:** An untracked path or malicious status output referencing path traversal segments could cause unintended file deletions outside the worktree root.
- **Remediation:** Call `assertSafePath(worktreePath, file)` on each violation entry prior to executing git checkout or `rmSync`.
- **Proposed Follow-Up:** `P6.4.8`

### SEC-009: Insecure default file permissions on raw adapter NDJSON streams
- **Domain:** `credential_handling`
- **Severity:** `medium`
- **Source Files:** [`src/backends/adapters/claude.ts:196`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/backends/adapters/claude.ts#L196), [`src/backends/adapters/agy.ts:202`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/backends/adapters/agy.ts#L202)
- **Description:** `ClaudeAdapter` and `AgyAdapter` create raw stream files in `.substrate/runs/<run_id>/raw/*.ndjson` using `createWriteStream` and `appendFileSync` without setting POSIX mode `0600`. The resulting files are subject to default umask permissions (`0644` or `0664`), exposing raw conversation logs and potential session data to other users on shared filesystems.
- **Trigger Scenario:** On a multi-user machine, another user on the system reads verbatim LLM request/response traces from `.substrate/runs/<run_id>/raw/`.
- **Remediation:** Specify `{ mode: 0o600 }` on write streams and file appends when creating raw NDJSON files, and ensure the parent `raw/` directory is created with mode `0o700`.
- **Proposed Follow-Up:** `P6.4.9`

### SEC-010: Invariant I12 zero-credential storage and zero CLI prompting verified
- **Domain:** `credential_handling`
- **Severity:** `info`
- **Source Files:** [`src/store/sessions.ts:57-70`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/store/sessions.ts#L57-L70), [`src/config/index.ts:146-193`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/config/index.ts#L146-L193), [`src/cli/dispatcher.ts:204-275`](file:///home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-harness/.worktrees/P6.2/src/cli/dispatcher.ts#L204-L275)
- **Description:** Comprehensive inspection of `.substrate/` persistent structures (`settings.json`, `events.jsonl`, `runs/**`, `sessions/**`), CLI command registration, and dispatcher argument parsing confirms complete compliance with Invariant I12. Substrate stores no auth tokens or passwords, prompts for no credentials, and delegates all authentication to logged-in user CLIs.
- **Remediation:** None required. Maintain regression tests in `test/config/` and `test/cli/`.
- **Proposed Follow-Up:** None (Baseline compliance verified).

---

## 4. Proposed Follow-Up Work Packages (P6.4.n)

> [!WARNING]
> **Governance Threshold Alert:** A total of 9 follow-up work packages are proposed, exceeding the standard threshold of 3. In accordance with Task Spec P6.2 Section 6 and Invariants, **explicit user approval is required before scheduling or spawning work packages beyond P6.4.3 (i.e. P6.4.4 through P6.4.9)**.

| WP ID | Finding ID | Title | Minimal Write Set | Approval Required |
|---|---|---|---|:---:|
| `P6.4.1` | `SEC-001` | Enforce fail-closed bubblewrap sandbox requirement in verify runner | `src/verify/runner.ts` | **No** (Within first 3) |
| `P6.4.2` | `SEC-002` | Harden bubblewrap argument construction with user namespace squash and extraBinds validation | `src/verify/sandbox.ts` | **No** (Within first 3) |
| `P6.4.3` | `SEC-003` | Strict environment allowlisting in process supervisor and OpenCode adapter | `src/backends/process.ts`<br>`src/backends/adapters/opencode.ts` | **No** (Within first 3) |
| `P6.4.4` | `SEC-004` | Screen custom environment variables against sensitive credential patterns | `src/verify/runner.ts`<br>`src/backends/adapters/claude.ts`<br>`src/backends/adapters/agy.ts` | **Yes** (Threshold exceeded) |
| `P6.4.5` | `SEC-005` | Integrate secret redaction into failure packets, event stores, and CLI output formatters | `src/engine/packet.ts`<br>`src/store/event-store.ts`<br>`src/cli/output.ts` | **Yes** (Threshold exceeded) |
| `P6.4.6` | `SEC-006` | Add email address redaction regex to core secret redaction utility | `src/util/index.ts` | **Yes** (Threshold exceeded) |
| `P6.4.7` | `SEC-007` | Enforce strict glob pattern syntax validation and worktree boundary containment in spec parser and linter | `src/spec/parser.ts`<br>`src/spec/rules.ts` | **Yes** (Threshold exceeded) |
| `P6.4.8` | `SEC-008` | Assert safe path containment in scope enforcer out-of-scope file reversion | `src/git/scope.ts` | **Yes** (Threshold exceeded) |
| `P6.4.9` | `SEC-009` | Restrict raw backend stream files to mode 0600 user-only permissions | `src/backends/adapters/claude.ts`<br>`src/backends/adapters/agy.ts` | **Yes** (Threshold exceeded) |

---

## 5. Machine-Readable Schema Representation

```json
{
  "version": 1,
  "asOf": "2026-10-17T05:45:00Z",
  "targetRef": "2dfa7b210d567f996aea67971cae219ae10e21c3",
  "verdict": "pass_with_findings",
  "domains": {
    "sandbox_containment": {
      "status": "fail",
      "findingsCount": 2,
      "summary": "Bubblewrap commands correctly enforce root immutability (--ro-bind / /), worktree binds, and network unsharing, but fail open when bubblewrap is missing and lack root squash and extraBinds path assertions."
    },
    "env_scrubbing": {
      "status": "fail",
      "findingsCount": 2,
      "summary": "Claude and Agy adapters enforce system allowlists, but OpenCode and process supervisor inherit full unscrubbed parent process.env when options.env is omitted; custom task env variables lack sensitive key screening."
    },
    "redaction": {
      "status": "fail",
      "findingsCount": 2,
      "summary": "Core redaction utility redacts AWS keys, GitHub tokens, and private keys, but omits email address sanitization; failure packets, event stores, and CLI output streams bypass secret filtering."
    },
    "path_traversal": {
      "status": "fail",
      "findingsCount": 2,
      "summary": "isSafePath provides robust boundary and symlink checks, but spec parser and linter allow unsupported glob metacharacters and traversal prefixes, and revertOutOfScope lacks safe path assertions."
    },
    "credential_handling": {
      "status": "warn",
      "findingsCount": 2,
      "summary": "Strict zero-credential storage and zero-prompting adherence verified across CLI, config, and sessions under .substrate/; however, raw adapter stream files are created without 0600 permission restrictions."
    }
  },
  "findings": [
    {
      "id": "SEC-001",
      "domain": "sandbox_containment",
      "severity": "high",
      "title": "Silent sandbox bypass when bubblewrap binary is missing on Linux host",
      "sourceFiles": ["src/verify/runner.ts:30"],
      "description": "In VerifyRunnerImpl.runVerify, useSandbox is evaluated as (options.sandbox === true && sandboxAvailable). When running on Linux without the bwrap binary installed, sandboxAvailable evaluates to false, causing the runner to silently fall back to executing commands in un-sandboxed /bin/bash directly on the host rather than failing closed with a fatal diagnostic.",
      "remediation": "In src/verify/runner.ts, check if options.sandbox is true on Linux; if sandboxAvailable is false, throw a fatal error or emit a blocking diagnostic requiring an explicit --no-sandbox override.",
      "proposedWpId": "P6.4.1"
    },
    {
      "id": "SEC-002",
      "domain": "sandbox_containment",
      "severity": "high",
      "title": "Unvalidated extraBinds mount injection and missing user namespace root squash",
      "sourceFiles": ["src/verify/sandbox.ts:74", "src/verify/sandbox.ts:82"],
      "description": "BwrapSandboxImpl.wrapCommand iterates over options.extraBinds and appends --bind arguments without verifying paths using isSafePath against an allowlist, allowing arbitrary host filesystem mounts. Additionally, wrapCommand mounts host /tmp directly as read-write and omits --unshare-user with UID/GID squash mapping, risking container privilege escalation.",
      "remediation": "In src/verify/sandbox.ts, validate all extraBinds paths with assertSafePath against allowlisted directories, mount /tmp as a private tmpfs, and append --unshare-user with UID/GID squash mappings.",
      "proposedWpId": "P6.4.2"
    },
    {
      "id": "SEC-003",
      "domain": "env_scrubbing",
      "severity": "high",
      "title": "Full parent environment inheritance in OpenCode adapter and process supervisor",
      "sourceFiles": ["src/backends/process.ts:233", "src/backends/adapters/opencode.ts:239", "src/backends/adapters/opencode.ts:319"],
      "description": "spawnSupervisedProcess defaults options.env to raw process.env when options.env is undefined. OpenCodeAdapter.spawn passes env: req.env directly without filtering, causing worker sessions to inherit the full host environment when req.env is omitted. Furthermore, validateEnvironment in OpenCodeAdapter and AgyAdapter runs CLI --version checks with unscrubbed process.env.",
      "remediation": "In src/backends/process.ts, default options.env to an allowlist-scrubbed environment dictionary. In src/backends/adapters/opencode.ts, apply strict allowlist scrubbing before passing env to child processes.",
      "proposedWpId": "P6.4.3"
    },
    {
      "id": "SEC-004",
      "domain": "env_scrubbing",
      "severity": "medium",
      "title": "Unverified custom environment variable injection without credential pattern screening",
      "sourceFiles": ["src/verify/runner.ts:47", "src/backends/adapters/claude.ts:106", "src/backends/adapters/agy.ts:176"],
      "description": "Custom environment variables supplied via Command.env or SpawnRequest.env are merged directly into child process environments across VerifyRunnerImpl, ClaudeAdapter.scrubClaudeEnv, and AgyAdapter.spawn without screening keys against sensitive credential patterns (*KEY*, *TOKEN*, *SECRET*, *AUTH*, *PASSWD*, *CREDENTIAL*, ANTHROPIC_*, OPENAI_*, GITHUB_*, AWS_*).",
      "remediation": "Implement a shared utility to screen all custom environment variable keys against sensitive credential patterns and reject or scrub matches prior to process spawning.",
      "proposedWpId": "P6.4.4"
    },
    {
      "id": "SEC-005",
      "domain": "redaction",
      "severity": "high",
      "title": "Failure packets, event logs, and CLI output bypass secret redaction",
      "sourceFiles": ["src/engine/packet.ts:58", "src/engine/packet.ts:96", "src/store/event-store.ts:46", "src/cli/output.ts:58", "src/cli/output.ts:86", "src/cli/output.ts:117"],
      "description": "buildFailurePacket writes raw diff patches, worker summaries, and verify tails to disk (.patch and .json files) without running them through redactSecrets. EventStoreImpl.append writes unredacted event objects to events.jsonl, and CLI output formatters write unredacted error messages and stream events to stdout/stderr.",
      "remediation": "Pass diff patches, worker summaries, and verify tails through redactSecrets before writing failure packets; apply redactSecrets in EventStoreImpl.append and in CLI formatters.",
      "proposedWpId": "P6.4.5"
    },
    {
      "id": "SEC-006",
      "domain": "redaction",
      "severity": "medium",
      "title": "Missing email address pattern in secret redaction utility",
      "sourceFiles": ["src/util/index.ts:130"],
      "description": "SECRET_PATTERNS in src/util/index.ts contains regular expressions for AWS access keys, GitHub tokens, and private keys, but omits the email address redaction pattern ([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+) required by the specification and privacy guidelines.",
      "remediation": "Add /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+/g to SECRET_PATTERNS in src/util/index.ts.",
      "proposedWpId": "P6.4.6"
    },
    {
      "id": "SEC-007",
      "domain": "path_traversal",
      "severity": "high",
      "title": "Spec parser and linter lack validation for glob metacharacters and escaping patterns",
      "sourceFiles": ["src/spec/parser.ts:101", "src/spec/rules.ts:376", "src/util/index.ts:101"],
      "description": "parseTaskSpec and lint rule L006 do not reject glob expressions in read, write, create, or protected that contain unsupported glob special characters ([, {, }, (, ), !, +, @, \\, ], |) or relative directory traversal prefixes (../). picomatch evaluates these patterns without restriction, allowing worktree scope escapes.",
      "remediation": "Add frontmatter validation in src/spec/parser.ts and rule L006 rejecting unsupported glob characters and any path or glob attempting to traverse outside the worktree root.",
      "proposedWpId": "P6.4.7"
    },
    {
      "id": "SEC-008",
      "domain": "path_traversal",
      "severity": "medium",
      "title": "Missing safe path verification during out-of-scope file reversion",
      "sourceFiles": ["src/git/scope.ts:173", "src/git/scope.ts:197"],
      "description": "ScopeEnforcerImpl.revertOutOfScope receives violation file paths and executes path.join(worktreePath, file) followed by rmSync(full, { recursive: true, force: true }) without verifying that file satisfies isSafePath(worktreePath, file), creating potential risk if violation strings contain traversal components.",
      "remediation": "In src/git/scope.ts, invoke assertSafePath(worktreePath, file) on each violation path prior to git checkout or rmSync deletion.",
      "proposedWpId": "P6.4.8"
    },
    {
      "id": "SEC-009",
      "domain": "credential_handling",
      "severity": "medium",
      "title": "Insecure default file permissions on raw adapter NDJSON streams",
      "sourceFiles": ["src/backends/adapters/claude.ts:196", "src/backends/adapters/agy.ts:202"],
      "description": "ClaudeAdapter and AgyAdapter create raw stream files under .substrate/runs/<run_id>/raw/*.ndjson using createWriteStream and appendFileSync without specifying mode 0o600. The files are created with default umask permissions (0644 or 0664), exposing raw session traces to local users on shared filesystems.",
      "remediation": "Pass { mode: 0o600 } when opening raw write streams and appending raw chunks in ClaudeAdapter and AgyAdapter, and ensure the parent raw/ directory is created with mode 0o700.",
      "proposedWpId": "P6.4.9"
    },
    {
      "id": "SEC-010",
      "domain": "credential_handling",
      "severity": "info",
      "title": "Invariant I12 zero-credential storage and zero CLI prompting verified",
      "sourceFiles": ["src/store/sessions.ts:57", "src/config/index.ts:146", "src/cli/dispatcher.ts:204"],
      "description": "Systematic review of .substrate/ session, settings, and run stores confirms no credentials, tokens, or passwords are stored. CLI command parsers and options contain zero credential prompting, adhering fully to Invariant I12.",
      "remediation": "No remediation required. Maintained as a compliance baseline."
    }
  ],
  "followUpWps": [
    {
      "wpId": "P6.4.1",
      "findingId": "SEC-001",
      "title": "Enforce fail-closed bubblewrap sandbox requirement in verify runner",
      "writeSet": ["src/verify/runner.ts"],
      "requiresApproval": false
    },
    {
      "wpId": "P6.4.2",
      "findingId": "SEC-002",
      "title": "Harden bubblewrap argument construction with user namespace squash and extraBinds validation",
      "writeSet": ["src/verify/sandbox.ts"],
      "requiresApproval": false
    },
    {
      "wpId": "P6.4.3",
      "findingId": "SEC-003",
      "title": "Strict environment allowlisting in process supervisor and OpenCode adapter",
      "writeSet": ["src/backends/process.ts", "src/backends/adapters/opencode.ts"],
      "requiresApproval": false
    },
    {
      "wpId": "P6.4.4",
      "findingId": "SEC-004",
      "title": "Screen custom environment variables against sensitive credential patterns",
      "writeSet": ["src/verify/runner.ts", "src/backends/adapters/claude.ts", "src/backends/adapters/agy.ts"],
      "requiresApproval": true
    },
    {
      "wpId": "P6.4.5",
      "findingId": "SEC-005",
      "title": "Integrate secret redaction into failure packets, event stores, and CLI output formatters",
      "writeSet": ["src/engine/packet.ts", "src/store/event-store.ts", "src/cli/output.ts"],
      "requiresApproval": true
    },
    {
      "wpId": "P6.4.6",
      "findingId": "SEC-006",
      "title": "Add email address redaction regex to core secret redaction utility",
      "writeSet": ["src/util/index.ts"],
      "requiresApproval": true
    },
    {
      "wpId": "P6.4.7",
      "findingId": "SEC-007",
      "title": "Enforce strict glob pattern syntax validation and worktree boundary containment in spec parser and linter",
      "writeSet": ["src/spec/parser.ts", "src/spec/rules.ts"],
      "requiresApproval": true
    },
    {
      "wpId": "P6.4.8",
      "findingId": "SEC-008",
      "title": "Assert safe path containment in scope enforcer out-of-scope file reversion",
      "writeSet": ["src/git/scope.ts"],
      "requiresApproval": true
    },
    {
      "wpId": "P6.4.9",
      "findingId": "SEC-009",
      "title": "Restrict raw backend stream files to mode 0600 user-only permissions",
      "writeSet": ["src/backends/adapters/claude.ts", "src/backends/adapters/agy.ts"],
      "requiresApproval": true
    }
  ]
}
```
