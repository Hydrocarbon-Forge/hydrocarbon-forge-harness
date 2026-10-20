import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createE2ERepo } from "./helpers/repo.js";
import { runSubstrate } from "./helpers/run-substrate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUIDE_SOURCE = join(ROOT, "assets", "prompts", "caller", "substrate-caller.md");
const GUIDE_COPY = join(ROOT, "docs", "reference", "caller-guide.md");

// One row per `substrate ...` line of the guide. `<run_id>` is replaced with the
// id of the run that the needs_input scenario pauses.
const ROWS: Array<{ command: string; expectedExit: number }> = [
  { command: "substrate doctor --output-format json", expectedExit: 0 },
  { command: "substrate models --output-format json", expectedExit: 0 },
  { command: "substrate run --mode solo --work claude:haiku --request - --output-format json", expectedExit: 0 },
  { command: "substrate resume <run_id> --answers -", expectedExit: 0 },
  { command: "substrate usage --by model --output-format json", expectedExit: 0 },
];

// Isolates the settings layers so results do not depend on the machine:
// an empty config dir, and empty strings neutralize any inherited overrides.
function isolatedEnv(): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), "substrate-caller-config-"));
  const stateDir = mkdtempSync(join(tmpdir(), "substrate-caller-state-"));
  return {
    SUBSTRATE_CONFIG_DIR: configDir,
    SUBSTRATE_SETTINGS: "",
    SUBSTRATE_PROJECT_DIR: "",
    SUBSTRATE_MODEL: "",
    SUBSTRATE_WORKER_MODEL: "",
    SUBSTRATE_OUTPUT_FORMAT: "",
    SUBSTRATE_EXECUTION: "",
    SUBSTRATE_SETTINGS_CONTENT: "",
    SUBSTRATE_PERMISSION_MODE: "",
    XDG_STATE_HOME: stateDir,
  };
}

// The guide names the model of every request and command it shows. The profile below is
// kept as the settings the pause setup has always used; the rows no longer depend on it.
const PROFILE_SETTINGS = {
  profiles: {
    claude: {
      plan: { model: "sonnet" },
      work: { model: "sonnet" },
    },
  },
};

const MANIFEST = [
  "version: 1",
  "run_id: r_CCCCCCCCCCCC",
  "goal: Add the feature helper",
  "base_ref: main",
  "ecosystem: node-ts",
  "setup:",
  "  - run: echo setup",
  "    timeout_s: 30",
  "contracts:",
  "  files:",
  "    - contracts/types.ts",
  "  typecheck:",
  "    - run: echo typecheck contracts",
  "      timeout_s: 30",
  "integration_verify:",
  "  - run: echo verify all",
  "    timeout_s: 60",
  "tasks:",
  "  - id: T1",
  "    spec: tasks/T1.md",
  "budget:",
  "  max_usd: 5",
  "  max_tokens: 200000",
  "  max_wall_min: 30",
  "",
].join("\n");

const SPEC = [
  "---",
  "id: T1",
  "title: Add feature helper",
  "class: feature",
  "depends_on: []",
  "read:",
  "  - contracts/types.ts",
  "write:",
  "  - src/feature.ts",
  "create:",
  "  - src/helper.ts",
  "protected:",
  "  - contracts/types.ts",
  "budget:",
  "  max_usd: 0.5",
  "  max_turns: 12",
  "verify:",
  "  - run: grep -q runFeature src/feature.ts",
  "    timeout_s: 10",
  "---",
  "",
  "## Objective",
  "",
  "Add a helper that reports whether the feature is enabled.",
  "",
  "## Interface",
  "",
  "Export runFeature from contracts/types.ts and implement it in src/feature.ts.",
  "",
  "## Behavior",
  "",
  "The helper returns true when the enabled flag is set.",
  "",
  "## Invariants",
  "",
  "The contract file is not modified.",
  "",
  "## Edge cases",
  "",
  "An empty options object returns false.",
  "",
  "## Guardrails",
  "",
  "No network access.",
  "",
  "## Out of scope",
  "",
  "Caching and CLI wiring.",
  "",
].join("\n");

const CONTRACT_STUB = "export declare function runFeature(name: string): boolean;\n";

const SEED_FILES = {
  "src/feature.ts": "export const featureEnabled = true;\n",
  "contracts/types.ts": "export {};\n",
};

const PAUSE_SCENARIO = {
  calls: [
    {
      plan: {
        files: {
          "manifest.yaml": MANIFEST,
          "tasks/T1.md": SPEC,
          "contracts/types.ts": CONTRACT_STUB,
          "QUESTIONS.md": [
            "1. Which cache layer should the helper use?",
            "   Default: memory",
            "2. Should telemetry be enabled?",
            "   Default: false",
          ].join("\n"),
        },
      },
      reply: "I need input\nNEEDS INPUT",
    },
  ],
};

const RESUME_SCENARIO = {
  calls: [
    {
      plan: {
        files: {
          "manifest.yaml": MANIFEST,
          "tasks/T1.md": SPEC,
          "contracts/types.ts": CONTRACT_STUB,
        },
      },
      reply: "Answers incorporated\nPLAN READY",
    },
  ],
};

const RUN_SCENARIO = {
  calls: [
    {
      edits: { "hello.txt": "hello\n" },
      reply: "DONE",
    },
  ],
};

interface FencedBlock {
  lang: string;
  body: string;
}

function guideText(): string {
  return readFileSync(GUIDE_SOURCE, "utf8");
}

function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const re = /^```([A-Za-z0-9_-]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  for (const match of text.matchAll(re)) {
    blocks.push({ lang: match[1], body: match[2] });
  }
  return blocks;
}

function guideCommands(text: string): string[] {
  return fencedBlocks(text).flatMap((block) =>
    block.body
      .split("\n")
      .filter((line) => line.startsWith("substrate "))
      .map((line) => line.trimEnd())
  );
}

// The JSON example in a fenced json block, found by a key it must carry.
function guideJson(text: string, key: string): Record<string, unknown> {
  for (const block of fencedBlocks(text)) {
    if (block.lang !== "json") continue;
    const parsed = JSON.parse(block.body);
    if (parsed && typeof parsed === "object" && key in parsed) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error(`guide has no json block with key "${key}"`);
}

describe("R5.1: caller guide", () => {
  describe("every guide command runs through the built CLI", () => {
    const state: { repo?: ReturnType<typeof createE2ERepo>; runId?: string; env?: Record<string, string> } = {};

    beforeAll(() => {
      execFileSync("npm", ["run", "bundle"], { cwd: ROOT, stdio: "pipe" });

      state.env = isolatedEnv();
      state.repo = createE2ERepo(SEED_FILES);

      // The resume row needs a paused run in the same repository.
      const pause = runSubstrate({
        repo: state.repo,
        env: state.env,
        settings: PROFILE_SETTINGS,
        scenario: PAUSE_SCENARIO,
        args: ["plan", "--output-format", "json", "Add the feature helper"],
      });
      if (pause.exitCode !== 3) {
        throw new Error(`needs_input setup exited ${pause.exitCode}: ${pause.stderr}`);
      }
      state.runId = JSON.parse(pause.stdout).run_id as string;
    }, 600000);

    afterAll(() => {
      state.repo?.cleanup();
    });

    it("every row exits with its expected code, the request and answers come from the guide", () => {
      const text = guideText();
      for (const { command, expectedExit } of ROWS) {
        const args = command.split(" ").slice(1).map((arg) => (arg === "<run_id>" ? state.runId! : arg));

        let stdin: string | undefined;
        let scenario: { calls: unknown[] } | undefined;
        if (args.includes("--request")) {
          stdin = JSON.stringify(guideJson(text, "goal"));
          scenario = RUN_SCENARIO;
        } else if (args.includes("resume")) {
          stdin = JSON.stringify(guideJson(text, "answers"));
          scenario = RESUME_SCENARIO;
        }

        const res = runSubstrate({
          repo: state.repo,
          env: state.env,
          settings: PROFILE_SETTINGS,
          scenario,
          args,
          stdin,
        });
        expect(res.exitCode, `${command}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(expectedExit);
      }
    });
  });

  it("the table contains every substrate command line of the guide", () => {
    const commands = guideCommands(guideText());
    expect(commands.length).toBeGreaterThan(0);
    const table = new Set(ROWS.map((row) => row.command));
    for (const command of commands) {
      expect(table.has(command), `guide line not in the e2e table: ${command}`).toBe(true);
    }
  });

  it("the guide and its docs/reference copy are byte-identical", () => {
    const source = readFileSync(GUIDE_SOURCE);
    const copy = readFileSync(GUIDE_COPY);
    expect(copy.equals(source)).toBe(true);
  });
});
