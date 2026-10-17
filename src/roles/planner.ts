import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import type {
  Command,
  Diagnostic,
  EngineEvent,
  HarnessAdapter,
  Manifest,
  RunId,
  Settings,
  SpawnRequest,
  UsageRecord,
} from "../contracts/index.js";
import {
  parseManifest,
  parseTaskSpec,
  lintPlan,
  typecheckContracts,
  type ParsedPlan,
  type ParsedTaskSpec,
  generateRepoMap,
} from "../spec/index.js";
import { buildPlannerPrompt } from "./prompts/planner.js";

export interface PlannerRunOptions {
  runId: RunId;
  repoRoot: string;
  runDir: string;
  request: string;
  settings: Settings;
  adapter: HarnessAdapter;
  instructionFiles?: string[];
  skillsList?: Array<{ name: string; description: string }>;
  onEvent?: (event: EngineEvent) => void;
}

export interface PlannerRunResult {
  plan: ParsedPlan;
  usage: UsageRecord;
  retries: number;
  commitSha: string;
}

const REQUIRED_HEADINGS = [
  "Objective",
  "Interface",
  "Behavior",
  "Invariants",
  "Edge cases",
  "Guardrails",
  "Out of scope",
];

export async function commitContractStubs(
  repoRoot: string,
  runId: RunId,
  baseRef: string,
  contracts: { files: string[]; typecheck: Command[] },
  runDir: string,
): Promise<string> {
  const branchName = `substrate/runs/${runId}`;

  // Ensure baseRef exists
  let parentCommit: string;
  try {
    parentCommit = execFileSync("git", ["rev-parse", baseRef], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    parentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  }

  // Create temporary index
  const tempIndexFile = path.join(
    runDir,
    `.git-index-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    const gitEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexFile,
      GIT_AUTHOR_NAME: "substrate-engine",
      GIT_AUTHOR_EMAIL: "substrate-engine@local",
      GIT_COMMITTER_NAME: "substrate-engine",
      GIT_COMMITTER_EMAIL: "substrate-engine@local",
    };

    // Read base tree into temp index
    execFileSync("git", ["read-tree", parentCommit], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: "utf8",
    });

    // Hash and add contract files
    for (const relFile of contracts.files) {
      const srcFile = path.resolve(runDir, relFile);
      if (fs.existsSync(srcFile)) {
        const blobSha = execFileSync(
          "git",
          ["hash-object", "-w", srcFile],
          { cwd: repoRoot, encoding: "utf8" },
        ).trim();

        execFileSync(
          "git",
          [
            "update-index",
            "--add",
            "--cacheinfo",
            "100644",
            blobSha,
            relFile.replace(/\\/g, "/"),
          ],
          { cwd: repoRoot, env: gitEnv, encoding: "utf8" },
        );
      }
    }

    // Write tree
    const treeSha = execFileSync("git", ["write-tree"], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: "utf8",
    }).trim();

    // Commit tree
    const commitSha = execFileSync(
      "git",
      [
        "commit-tree",
        treeSha,
        "-p",
        parentCommit,
        "-m",
        `feat(contracts): commit contract stubs for run ${runId}`,
      ],
      { cwd: repoRoot, env: gitEnv, encoding: "utf8" },
    ).trim();

    // Update branch reference
    execFileSync("git", ["update-ref", `refs/heads/${branchName}`, commitSha], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    return commitSha;
  } finally {
    if (fs.existsSync(tempIndexFile)) {
      try {
        fs.unlinkSync(tempIndexFile);
      } catch {}
    }
  }
}

export async function runPlanner(
  opts: PlannerRunOptions,
): Promise<PlannerRunResult> {
  opts.onEvent?.({
    type: "plan.started",
    run_id: opts.runId,
  } as any);

  let retries = 0;
  const maxRetries = opts.settings.budgets?.planner_format_retries ?? 2;
  let lastErrors: string[] = [];

  let cumulativeUsage: UsageRecord = {
    backend: opts.settings.roles.planner.backend ?? "claude",
    model: opts.settings.roles.planner.model,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_source: "computed",
    at: new Date().toISOString(),
  };

  while (true) {
    let repoMap = "";
    try {
      const res = await generateRepoMap(opts.repoRoot);
      repoMap = typeof res === "string" ? res : res.mapText;
    } catch {
      repoMap = "";
    }

    let promptData: { system: string; user: string };
    if (retries === 0) {
      promptData = buildPlannerPrompt({
        request: opts.request,
        repoMap,
        instructionFiles: opts.instructionFiles,
        skillsList: opts.skillsList,
      });
    } else {
      promptData = buildPlannerPrompt({
        request: opts.request,
        repoMap,
        instructionFiles: opts.instructionFiles,
        skillsList: opts.skillsList,
      });
      promptData.user += `\n\n## Corrective Feedback (Format Retry ${retries})\nThe previous attempt produced errors. Please correct the manifest, task specs, or contract stubs to address the following problems:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;
    }

    const spawnReq: SpawnRequest = {
      role: "planner",
      cwd: opts.runDir,
      prompt: promptData.user,
      system_append: promptData.system,
      model: opts.settings.roles.planner.model,
      effort: opts.settings.roles.planner.effort,
      permission: {
        allow: [opts.runDir],
        deny: ["git commit", "git push", "git checkout", "git reset", "subagents"],
      },
      budget: {
        max_usd: opts.settings.budgets?.task?.max_usd ?? 5.0,
        timeout_ms:
          (opts.settings.budgets?.task?.timeout_min ?? 30) * 60 * 1000,
        ...(opts.settings.budgets?.task?.max_tokens
          ? { max_tokens: opts.settings.budgets.task.max_tokens }
          : {}),
        ...(opts.settings.budgets?.task?.timeout_min
          ? { timeout_min: opts.settings.budgets.task.timeout_min }
          : {}),
      },
    };

    const handle = opts.adapter.spawn(spawnReq);

    for await (const evt of handle.events) {
      opts.onEvent?.(evt as any);
      if (evt.type === "usage" && (evt as any).record) {
        const u = (evt as any).record as UsageRecord;
        cumulativeUsage = {
          ...cumulativeUsage,
          input_tokens: cumulativeUsage.input_tokens + (u.input_tokens ?? 0),
          output_tokens: cumulativeUsage.output_tokens + (u.output_tokens ?? 0),
          cost_usd: (cumulativeUsage.cost_usd ?? 0) + (u.cost_usd ?? 0),
        };
      }
    }

    const sessionRes = await handle.result();
    if (sessionRes?.usage) {
      cumulativeUsage = {
        ...cumulativeUsage,
        input_tokens: Math.max(cumulativeUsage.input_tokens, sessionRes.usage.input_tokens ?? 0),
        output_tokens: Math.max(cumulativeUsage.output_tokens, sessionRes.usage.output_tokens ?? 0),
        cost_usd: Math.max(cumulativeUsage.cost_usd ?? 0, sessionRes.usage.cost_usd ?? 0),
      };
    }

    if (!sessionRes.ok || (sessionRes.exit_code !== null && sessionRes.exit_code !== 0)) {
      const errMsg = `Planner session failed with exit code ${sessionRes.exit_code}: ${sessionRes.final_text}`;
      if (retries < maxRetries) {
        retries++;
        lastErrors = [errMsg];
        continue;
      } else {
        throw new Error(`Planner format retries exhausted: ${errMsg}`);
      }
    }

    opts.onEvent?.({
      type: "plan.produced",
      run_id: opts.runId,
    } as any);

    // Collect artifacts
    const manifestPath = path.join(opts.runDir, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) {
      const errMsg = "manifest.yaml is missing";
      if (retries < maxRetries) {
        retries++;
        lastErrors = [errMsg];
        continue;
      } else {
        throw new Error(`Planner format retries exhausted: ${errMsg}`);
      }
    }

    let rawManifest = "";
    try {
      rawManifest = fs.readFileSync(manifestPath, "utf8");
    } catch (err: any) {
      const errMsg = `Failed to read manifest.yaml: ${err.message}`;
      if (retries < maxRetries) {
        retries++;
        lastErrors = [errMsg];
        continue;
      } else {
        throw new Error(`Planner format retries exhausted: ${errMsg}`);
      }
    }

    let manifest: Manifest;
    try {
      manifest = parseManifest(rawManifest, manifestPath);
    } catch (err: any) {
      const errMsg = `Failed to parse manifest YAML: ${err.message}`;
      if (retries < maxRetries) {
        retries++;
        lastErrors = [errMsg];
        continue;
      } else {
        throw new Error(`Planner format retries exhausted: ${errMsg}`);
      }
    }

    const specs = new Map<string, ParsedTaskSpec>();
    const specParseErrors: string[] = [];

    for (const task of manifest.tasks) {
      const specPath = path.resolve(opts.runDir, task.spec);
      if (!fs.existsSync(specPath)) {
        specParseErrors.push(`Spec file for task ${task.id} does not exist: ${task.spec}`);
        continue;
      }
      let rawSpec = "";
      try {
        rawSpec = fs.readFileSync(specPath, "utf8");
      } catch (err: any) {
        specParseErrors.push(`Failed to read task spec ${task.spec}: ${err.message}`);
        continue;
      }

      try {
        const parsedSpec = parseTaskSpec(rawSpec, task.spec);
        if (!parsedSpec.frontmatter.budget) {
          const cap = opts.settings.budgets?.task?.max_usd ?? 0.5;
          parsedSpec.frontmatter.budget = {
            max_usd: cap,
            max_tokens: opts.settings.budgets?.task?.max_tokens,
          };
        }
        // Verify required headings
        for (const heading of REQUIRED_HEADINGS) {
          if (!parsedSpec.sections.has(heading)) {
            specParseErrors.push(`Task spec ${task.spec} missing required heading: ## ${heading}`);
          }
        }
        specs.set(task.id, parsedSpec);
      } catch (err: any) {
        specParseErrors.push(`Failed to parse task spec ${task.spec}: ${err.message}`);
      }
    }

    if (specParseErrors.length > 0) {
      if (retries < maxRetries) {
        retries++;
        lastErrors = specParseErrors;
        continue;
      } else {
        throw new Error(`Planner format retries exhausted:\n${specParseErrors.join("\n")}`);
      }
    }

    const parsedPlan: ParsedPlan = {
      manifest,
      specs,
      rawManifest,
      manifestPath,
    };

    // Run plan linter
    const lintResult = await lintPlan(parsedPlan, opts.repoRoot, opts.settings);

    // Filter diagnostics: if L003, L007, L016, L019, L027 failed only because files/defaults are in runDir / contracts
    const contractFiles = new Set(manifest.contracts?.files ?? []);
    const effectiveErrors = lintResult.diagnostics.filter((d) => {
      if (d.severity !== "error") return false;
      if (d.code === "L003" && d.path && fs.existsSync(path.resolve(opts.runDir, d.path))) {
        return false;
      }
      if (d.code === "L016") {
        return false;
      }
      if (d.code === "L019" && d.path && fs.existsSync(path.resolve(opts.runDir, d.path))) {
        return false;
      }
      if (d.code === "L027" && d.path && (contractFiles.has(d.path) || fs.existsSync(path.resolve(opts.runDir, d.path)))) {
        return false;
      }
      if (d.code === "L007") {
        return false;
      }
      return true;
    });

    opts.onEvent?.({
      type: "plan.lint",
      run_id: opts.runId,
      diagnostics: lintResult.diagnostics,
    } as any);

    if (effectiveErrors.length > 0) {
      const errMsgs = effectiveErrors.map((d) => `[${d.code}] ${d.message}`);
      if (retries < maxRetries) {
        retries++;
        lastErrors = errMsgs;
        continue;
      } else {
        throw new Error(`Planner format retries exhausted by linter diagnostics:\n${errMsgs.join("\n")}`);
      }
    }

    // Contract stub typecheck
    let typecheckRes;
    try {
      typecheckRes = await typecheckContracts(
        opts.runDir,
        manifest.contracts,
        { cwd: opts.runDir },
      );
    } catch (err: any) {
      typecheckRes = {
        ok: false,
        diagnostics: [{ code: "L018", severity: "error", message: err.message }],
      };
    }

    if (!typecheckRes.ok || typecheckRes.diagnostics.some((d) => d.severity === "error")) {
      const errMsgs = typecheckRes.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `[${d.code}] ${d.message}`);
      if (errMsgs.length === 0) {
        errMsgs.push("Contract typecheck failed with non-zero exit code");
      }
      if (retries < maxRetries) {
        retries++;
        lastErrors = errMsgs;
        continue;
      } else {
        throw new Error(`Contract typecheck failed permanently:\n${errMsgs.join("\n")}`);
      }
    }

    // Commit contract stubs to run branch
    const commitSha = await commitContractStubs(
      opts.repoRoot,
      opts.runId,
      manifest.base_ref ?? "main",
      manifest.contracts,
      opts.runDir,
    );

    opts.onEvent?.({
      type: "contracts.committed",
      run_id: opts.runId,
      commit_sha: commitSha,
      data: { commitSha },
    } as any);

    return {
      plan: parsedPlan,
      usage: cumulativeUsage,
      retries,
      commitSha,
    };
  }
}
