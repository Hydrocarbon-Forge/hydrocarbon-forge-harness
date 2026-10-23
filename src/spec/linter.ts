import type { Diagnostic, Settings } from "../contracts/index.js";
import type { ParsedPlan } from "./parser.js";
import { ALL_RULES, type RuleContext } from "./rules.js";

export interface LintOptions {
  semanticHook?: SemanticCheckHook;
  maxTasks?: number;
  contextBudgetBytes?: number;
  contextBudgetFiles?: number;
}

export interface LintResult {
  ok: boolean;
  hasErrors: boolean;
  diagnostics: Diagnostic[];
}

export type SemanticLintCode = "S001" | "S002" | "S003" | "S004";

export interface SemanticCheckHook {
  runSemanticChecks(
    plan: ParsedPlan, repoRoot: string
  ): Promise<Diagnostic[]>;
}

export async function lintPlan(
  plan: ParsedPlan,
  repoRoot: string,
  settings: Settings,
  options: LintOptions = {}
): Promise<LintResult> {
  const ctx: RuleContext = {
    plan,
    repoRoot,
    settings,
    options,
  };

  const diagnostics: Diagnostic[] = [];

  for (const rule of ALL_RULES) {
    const diags = await rule(ctx);
    diagnostics.push(...diags);
  }

  if (options.semanticHook) {
    try {
      const semanticDiags = await options.semanticHook.runSemanticChecks(plan, repoRoot);
      for (const diag of semanticDiags) {
        diagnostics.push({
          ...diag,
          severity: "info",
        });
      }
    } catch {
      // Semantic check hook error does not fail linting
    }
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const ok = !hasErrors;

  return {
    ok,
    hasErrors,
    diagnostics,
  };
}
