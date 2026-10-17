import { describe, expect, it } from "vitest";

import type {
  BenchmarkArm,
  BenchmarkArmSummary,
  BenchmarkAttemptResult,
  BenchmarkHypotheses,
  BenchmarkReport,
  BenchmarkRunConfig,
  BenchmarkTaskSpec,
} from "../../../bench/types.js";
import { evaluateHypotheses, formatBenchmarkReport } from "../../../bench/report.js";

function makeTask(id: string, task_class: string = "feature"): BenchmarkTaskSpec {
  return {
    id,
    title: `Task ${id}`,
    task_class: task_class as any,
    repo_fixture: "fixtures/repo",
    verify: [{ run: "echo test", timeout_s: 10 }],
    budget: { max_usd: 1.0 },
  };
}

function makeSummary(arm: BenchmarkArm, overrides: Partial<BenchmarkArmSummary> = {}): BenchmarkArmSummary {
  return {
    arm,
    totalAttempts: 10,
    passedAttempts: 8,
    passRate: 0.8,
    firstPassVerifyRate: 0.6,
    totalCostUsd: 5.0,
    meanCostUsd: 0.5,
    meanDurationMs: 12000,
    ...overrides,
  };
}

function makeAttempt(
  taskId: string,
  arm: BenchmarkArm,
  repetition: number,
  passed: boolean,
  firstPassVerified: boolean,
  costUsd: number = 0.5
): BenchmarkAttemptResult {
  return {
    taskId,
    arm,
    repetition,
    passed,
    firstPassVerified,
    costUsd,
    durationMs: 10000,
    verifyResults: [
      {
        cmd: "echo test",
        exit_code: passed ? 0 : 1,
        timed_out: false,
        duration_ms: 100,
        stdout_tail: "",
        stderr_tail: "",
        truncated: false,
      },
    ],
  };
}

describe("Benchmark Hypotheses evaluation & report formatting (P6.3 §13)", () => {
  describe("H1 Evaluation (Arm C matches Arm A's pass rate on >= 70% of tasks at lower cost)", () => {
    it("evaluates H1 as supported when Arm C matches Arm A pass rate on >= 70% of tasks and total cost is lower", () => {
      // 10 tasks: Arm C matches or beats Arm A on 8 tasks (80% >= 70%), total cost C ($6.00) < total cost A ($15.00)
      const tasks = Array.from({ length: 10 }, (_, i) => makeTask(`T${i + 1}`));
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A", { totalCostUsd: 15.0 }),
        B: makeSummary("B", { totalCostUsd: 2.0 }),
        C: makeSummary("C", { totalCostUsd: 6.0 }),
        D: makeSummary("D", { totalCostUsd: 1.0 }),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {};
      for (let i = 0; i < 10; i++) {
        const taskId = `T${i + 1}`;
        // For first 8 tasks, Arm C passed and Arm A passed (matched)
        // For last 2 tasks, Arm A passed and Arm C failed (unmatched)
        const cPassed = i < 8;
        results[taskId] = {
          A: [makeAttempt(taskId, "A", 1, true, true, 1.5)],
          B: [makeAttempt(taskId, "B", 1, false, false, 0.2)],
          C: [makeAttempt(taskId, "C", 1, cPassed, cPassed, 0.6)],
          D: [makeAttempt(taskId, "D", 1, cPassed, cPassed, 0.1)],
        };
      }

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h1.id).toBe("H1");
      expect(hypotheses.h1.supported).toBe(true);
      expect(hypotheses.h1.evidence).toMatch(/80%|0\.8|match/i);
      expect(hypotheses.h1.metrics.matchFraction).toBeCloseTo(0.8, 2);
    });

    it("evaluates H1 as unsupported when match fraction is below 70%", () => {
      // 10 tasks: Arm C matches Arm A on only 5 tasks (50% < 70%)
      const tasks = Array.from({ length: 10 }, (_, i) => makeTask(`T${i + 1}`));
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A", { totalCostUsd: 20.0 }),
        B: makeSummary("B", { totalCostUsd: 2.0 }),
        C: makeSummary("C", { totalCostUsd: 5.0 }),
        D: makeSummary("D", { totalCostUsd: 1.0 }),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {};
      for (let i = 0; i < 10; i++) {
        const taskId = `T${i + 1}`;
        // Arm C only passes 5 of 10
        const cPassed = i < 5;
        results[taskId] = {
          A: [makeAttempt(taskId, "A", 1, true, true, 2.0)],
          B: [makeAttempt(taskId, "B", 1, false, false, 0.2)],
          C: [makeAttempt(taskId, "C", 1, cPassed, cPassed, 0.5)],
          D: [makeAttempt(taskId, "D", 1, false, false, 0.1)],
        };
      }

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h1.supported).toBe(false);
      expect(hypotheses.h1.evidence).toMatch(/match|fraction|below|fail/i);
    });

    it("evaluates H1 as unsupported when cost of C is not strictly lower than A (equal cost or higher)", () => {
      // 10 tasks: 100% matched, but cost C ($15.00) >= cost A ($15.00)
      const tasks = Array.from({ length: 10 }, (_, i) => makeTask(`T${i + 1}`));
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A", { totalCostUsd: 15.0 }),
        B: makeSummary("B", { totalCostUsd: 2.0 }),
        C: makeSummary("C", { totalCostUsd: 15.0 }), // Equal cost
        D: makeSummary("D", { totalCostUsd: 1.0 }),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {};
      for (let i = 0; i < 10; i++) {
        const taskId = `T${i + 1}`;
        results[taskId] = {
          A: [makeAttempt(taskId, "A", 1, true, true, 1.5)],
          B: [makeAttempt(taskId, "B", 1, false, false, 0.2)],
          C: [makeAttempt(taskId, "C", 1, true, true, 1.5)],
          D: [makeAttempt(taskId, "D", 1, true, true, 0.1)],
        };
      }

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h1.supported).toBe(false);
      expect(hypotheses.h1.evidence).toMatch(/cost/i);
    });
  });

  describe("H2 Evaluation (Arm C first-pass verify rate beats Arm B)", () => {
    it("evaluates H2 as supported when Arm C first-pass verify rate is strictly higher than Arm B", () => {
      const tasks = [makeTask("T01"), makeTask("T02")];
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A"),
        B: makeSummary("B", { totalAttempts: 10, firstPassVerifyRate: 0.3 }),
        C: makeSummary("C", { totalAttempts: 10, firstPassVerifyRate: 0.7 }),
        D: makeSummary("D"),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {
        T01: {
          A: [makeAttempt("T01", "A", 1, true, true)],
          B: [makeAttempt("T01", "B", 1, true, false)], // Passed on retry, not first-pass
          C: [makeAttempt("T01", "C", 1, true, true)], // Passed on first-pass
          D: [makeAttempt("T01", "D", 1, true, true)],
        },
        T02: {
          A: [makeAttempt("T02", "A", 1, true, true)],
          B: [makeAttempt("T02", "B", 1, false, false)],
          C: [makeAttempt("T02", "C", 1, true, true)],
          D: [makeAttempt("T02", "D", 1, false, false)],
        },
      };

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h2.id).toBe("H2");
      expect(hypotheses.h2.supported).toBe(true);
      expect(hypotheses.h2.evidence).toMatch(/rate|delta|0\.[37]/i);
    });

    it("evaluates H2 as unsupported when Arm C first-pass verify rate does not beat Arm B (equal or lower)", () => {
      const tasks = [makeTask("T01")];
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A"),
        B: makeSummary("B", { totalAttempts: 5, firstPassVerifyRate: 0.6 }),
        C: makeSummary("C", { totalAttempts: 5, firstPassVerifyRate: 0.6 }), // Equal
        D: makeSummary("D"),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {
        T01: {
          A: [makeAttempt("T01", "A", 1, true, true)],
          B: [makeAttempt("T01", "B", 1, true, true)],
          C: [makeAttempt("T01", "C", 1, true, true)],
          D: [makeAttempt("T01", "D", 1, true, true)],
        },
      };

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h2.supported).toBe(false);
    });
  });

  describe("H3 Evaluation (Arm D pass rate on mechanical/boilerplate within 10 percentage points of Arm C at near-zero marginal cost)", () => {
    it("evaluates H3 as supported when Arm D pass rate on mechanical/boilerplate tasks is within 10 points of Arm C and cost is <= 10% of C", () => {
      // 2 mechanical/boilerplate tasks
      const tasks = [
        makeTask("T-MECH-1", "mechanical"),
        makeTask("T-BOILER-2", "boilerplate"),
        makeTask("T-FEAT-3", "feature"), // Not included in H3 calculation
      ];

      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A"),
        B: makeSummary("B"),
        C: makeSummary("C"),
        D: makeSummary("D"),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {
        "T-MECH-1": {
          A: [makeAttempt("T-MECH-1", "A", 1, true, true, 1.0)],
          B: [makeAttempt("T-MECH-1", "B", 1, true, false, 0.2)],
          C: [makeAttempt("T-MECH-1", "C", 1, true, true, 0.5)], // C passed, cost 0.50
          D: [makeAttempt("T-MECH-1", "D", 1, true, true, 0.02)], // D passed, cost 0.02 (<= 10% of 0.50)
        },
        "T-BOILER-2": {
          A: [makeAttempt("T-BOILER-2", "A", 1, true, true, 1.0)],
          B: [makeAttempt("T-BOILER-2", "B", 1, false, false, 0.2)],
          C: [makeAttempt("T-BOILER-2", "C", 1, true, true, 0.5)], // C passed, cost 0.50
          D: [makeAttempt("T-BOILER-2", "D", 1, true, true, 0.03)], // D passed, cost 0.03 (<= 10% of 0.50)
        },
        "T-FEAT-3": {
          A: [makeAttempt("T-FEAT-3", "A", 1, true, true, 2.0)],
          B: [makeAttempt("T-FEAT-3", "B", 1, false, false, 0.5)],
          C: [makeAttempt("T-FEAT-3", "C", 1, true, true, 1.0)],
          D: [makeAttempt("T-FEAT-3", "D", 1, false, false, 0.1)],
        },
      };

      // Both C and D passed 2/2 mechanical/boilerplate tasks (delta = 0 <= 0.10)
      // Mech cost C = 1.00, Mech cost D = 0.05 <= 0.10 * 1.00
      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h3.id).toBe("H3");
      expect(hypotheses.h3.supported).toBe(true);
      expect(hypotheses.h3.evidence).toMatch(/delta|marginal|cost|points/i);
    });

    it("evaluates H3 as supported when Arm D marginal cost is <= $0.01 regardless of percentage threshold", () => {
      const tasks = [makeTask("T-MECH-1", "mechanical")];
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A"),
        B: makeSummary("B"),
        C: makeSummary("C"),
        D: makeSummary("D"),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {
        "T-MECH-1": {
          A: [makeAttempt("T-MECH-1", "A", 1, true, true, 1.0)],
          B: [makeAttempt("T-MECH-1", "B", 1, true, false, 0.2)],
          C: [makeAttempt("T-MECH-1", "C", 1, true, true, 0.05)], // Cost 0.05
          D: [makeAttempt("T-MECH-1", "D", 1, true, true, 0.008)], // Cost 0.008 <= 0.01
        },
      };

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h3.supported).toBe(true);
    });

    it("evaluates H3 as unsupported when Arm D pass rate drops more than 10 percentage points below Arm C", () => {
      // 10 mechanical tasks: Arm C passes 10 (100%), Arm D passes 8 (80%, delta = 20% > 10%)
      const tasks = Array.from({ length: 10 }, (_, i) =>
        makeTask(`T-MECH-${i + 1}`, "mechanical")
      );
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A"),
        B: makeSummary("B"),
        C: makeSummary("C"),
        D: makeSummary("D"),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {};
      for (let i = 0; i < 10; i++) {
        const taskId = `T-MECH-${i + 1}`;
        const dPassed = i < 8; // 8/10 = 80%
        results[taskId] = {
          A: [makeAttempt(taskId, "A", 1, true, true, 1.0)],
          B: [makeAttempt(taskId, "B", 1, false, false, 0.2)],
          C: [makeAttempt(taskId, "C", 1, true, true, 0.5)], // 10/10 = 100%
          D: [makeAttempt(taskId, "D", 1, dPassed, dPassed, 0.01)],
        };
      }

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h3.supported).toBe(false);
      expect(hypotheses.h3.evidence).toMatch(/delta|pass rate/i);
    });

    it("handles edge case: zero mechanical/boilerplate tasks (H3 records not applicable per §268)", () => {
      // Only feature tasks
      const tasks = [makeTask("T-FEAT-1", "feature"), makeTask("T-FEAT-2", "feature")];
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A"),
        B: makeSummary("B"),
        C: makeSummary("C"),
        D: makeSummary("D"),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {
        "T-FEAT-1": {
          A: [makeAttempt("T-FEAT-1", "A", 1, true, true)],
          B: [makeAttempt("T-FEAT-1", "B", 1, false, false)],
          C: [makeAttempt("T-FEAT-1", "C", 1, true, true)],
          D: [makeAttempt("T-FEAT-1", "D", 1, true, true)],
        },
        "T-FEAT-2": {
          A: [makeAttempt("T-FEAT-2", "A", 1, true, true)],
          B: [makeAttempt("T-FEAT-2", "B", 1, false, false)],
          C: [makeAttempt("T-FEAT-2", "C", 1, true, true)],
          D: [makeAttempt("T-FEAT-2", "D", 1, true, true)],
        },
      };

      const hypotheses = evaluateHypotheses(tasks, summaries, results);

      expect(hypotheses.h3.supported).toBe(false);
      expect(hypotheses.h3.evidence).toMatch(/not_applicable_no_mechanical_tasks|no_mechanical/i);
    });

    it("handles edge case: 0% pass rate without division by zero errors", () => {
      const tasks = [makeTask("T-MECH-1", "mechanical")];
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A", { totalAttempts: 0, passedAttempts: 0, passRate: 0 }),
        B: makeSummary("B", { totalAttempts: 0, passedAttempts: 0, passRate: 0 }),
        C: makeSummary("C", { totalAttempts: 0, passedAttempts: 0, passRate: 0 }),
        D: makeSummary("D", { totalAttempts: 0, passedAttempts: 0, passRate: 0 }),
      };

      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {
        "T-MECH-1": {
          A: [],
          B: [],
          C: [],
          D: [],
        },
      };

      expect(() => evaluateHypotheses(tasks, summaries, results)).not.toThrow();
      const hypotheses = evaluateHypotheses(tasks, summaries, results);
      expect(Number.isNaN(hypotheses.h1.metrics.matchFraction)).toBe(false);
    });
  });

  describe("Benchmark report formatting (text, json, markdown)", () => {
    function makeReport(): BenchmarkReport {
      const tasks = [makeTask("T01")];
      const summaries: Record<BenchmarkArm, BenchmarkArmSummary> = {
        A: makeSummary("A", { passRate: 0.9, totalCostUsd: 12.0 }),
        B: makeSummary("B", { passRate: 0.4, totalCostUsd: 1.5 }),
        C: makeSummary("C", { passRate: 0.9, totalCostUsd: 4.5 }),
        D: makeSummary("D", { passRate: 0.8, totalCostUsd: 0.5 }),
      };
      const results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>> = {
        T01: {
          A: [makeAttempt("T01", "A", 1, true, true, 1.2)],
          B: [makeAttempt("T01", "B", 1, false, false, 0.15)],
          C: [makeAttempt("T01", "C", 1, true, true, 0.45)],
          D: [makeAttempt("T01", "D", 1, true, true, 0.05)],
        },
      };

      const config: BenchmarkRunConfig = {
        repetitions: 1,
      };

      const hypotheses: BenchmarkHypotheses = evaluateHypotheses(tasks, summaries, results);

      return {
        timestamp: "2026-10-17T12:00:00Z",
        config,
        armSummaries: summaries,
        taskResults: results,
        hypotheses,
      };
    }

    it("formats report as human-readable text table and summary", () => {
      const report = makeReport();
      const text = formatBenchmarkReport(report, "text");

      expect(typeof text).toBe("string");
      expect(text).toContain("Arm");
      expect(text).toContain("Pass Rate");
      expect(text).toContain("H1");
      expect(text).toContain("H2");
      expect(text).toContain("H3");
    });

    it("formats report as valid parseable JSON payload", () => {
      const report = makeReport();
      const jsonStr = formatBenchmarkReport(report, "json");

      const parsed = JSON.parse(jsonStr);
      expect(parsed).toBeDefined();
      expect(parsed.armSummaries).toBeDefined();
      expect(parsed.armSummaries.A.passRate).toBe(0.9);
      expect(parsed.hypotheses).toBeDefined();
    });

    it("formats report as GitHub-compatible markdown table with hypotheses breakdown", () => {
      const report = makeReport();
      const markdown = formatBenchmarkReport(report, "markdown");

      expect(markdown).toContain("| Arm |");
      expect(markdown).toContain("| A |");
      expect(markdown).toContain("| B |");
      expect(markdown).toContain("| C |");
      expect(markdown).toContain("| D |");
      expect(markdown).toContain("## Hypotheses");
      expect(markdown).toContain("H1");
      expect(markdown).toContain("H2");
      expect(markdown).toContain("H3");
    });
  });
});
