import type {
  BenchmarkArm,
  BenchmarkArmSummary,
  BenchmarkAttemptResult,
  BenchmarkHypotheses,
  BenchmarkReport,
  BenchmarkTaskSpec,
  HypothesisStatus,
} from "./types.js";

export function evaluateHypotheses(
  tasks: BenchmarkTaskSpec[],
  summaries: Record<BenchmarkArm, BenchmarkArmSummary>,
  results: Record<string, Record<BenchmarkArm, BenchmarkAttemptResult[]>>
): BenchmarkHypotheses {
  // H1 Evaluation: Arm C matches Arm A's pass rate on >= 70% of tasks at lower cost
  const totalTasks = tasks.length;
  let matchedCount = 0;

  for (const task of tasks) {
    const cAttempts = results[task.id]?.["C"] ?? [];
    const aAttempts = results[task.id]?.["A"] ?? [];
    const cPassed = cAttempts.filter((a) => a.passed).length;
    const aPassed = aAttempts.filter((a) => a.passed).length;
    const cPassRate = cAttempts.length > 0 ? cPassed / cAttempts.length : 0;
    const aPassRate = aAttempts.length > 0 ? aPassed / aAttempts.length : 0;

    if (cPassRate >= aPassRate) {
      matchedCount++;
    }
  }

  const matchFraction = totalTasks > 0 ? matchedCount / totalTasks : 0;
  const costC = summaries["C"]?.totalCostUsd ?? 0;
  const costA = summaries["A"]?.totalCostUsd ?? 0;
  const matchPassed = matchFraction >= 0.7;
  const costPassed = costC < costA;
  const h1Supported = matchPassed && costPassed;

  let h1Evidence = "";
  if (h1Supported) {
    h1Evidence = `Arm C matches or beats Arm A on ${matchedCount}/${totalTasks} tasks (${(matchFraction * 100).toFixed(1)}% match >= 70%) at lower total cost ($${costC.toFixed(2)} < $${costA.toFixed(2)})`;
  } else if (!matchPassed) {
    h1Evidence = `Arm C match fraction ${(matchFraction * 100).toFixed(1)}% is below 70% threshold (matched ${matchedCount}/${totalTasks} tasks, failed)`;
  } else {
    h1Evidence = `Arm C total cost ($${costC.toFixed(2)}) is not strictly lower than Arm A cost ($${costA.toFixed(2)})`;
  }

  const h1: HypothesisStatus = {
    id: "H1",
    supported: h1Supported,
    evidence: h1Evidence,
    metrics: {
      matchedCount,
      totalTasks,
      matchFraction,
      costC,
      costA,
    },
  };

  // H2 Evaluation: Substrate first-pass verify rate beats Arm B
  const firstPassRateC = summaries["C"]?.firstPassVerifyRate ?? 0;
  const firstPassRateB = summaries["B"]?.firstPassVerifyRate ?? 0;
  const delta = firstPassRateC - firstPassRateB;
  const h2Supported = firstPassRateC > firstPassRateB;

  let h2Evidence = "";
  if (h2Supported) {
    h2Evidence = `Arm C first-pass verify rate (${firstPassRateC.toFixed(3)}) beats Arm B (${firstPassRateB.toFixed(3)}) with delta +${delta.toFixed(3)}`;
  } else {
    h2Evidence = `Arm C first-pass verify rate (${firstPassRateC.toFixed(3)}) does not beat Arm B (${firstPassRateB.toFixed(3)}) (delta ${delta.toFixed(3)})`;
  }

  const h2: HypothesisStatus = {
    id: "H2",
    supported: h2Supported,
    evidence: h2Evidence,
    metrics: {
      firstPassRateC,
      firstPassRateB,
      delta,
    },
  };

  // H3 Evaluation: Arm D pass rate on mechanical/boilerplate within 10 percentage points of Arm C at near-zero marginal cost
  const mechTasks = tasks.filter(
    (t) => t.task_class === "mechanical" || t.task_class === "boilerplate"
  );

  let h3: HypothesisStatus;
  if (mechTasks.length === 0) {
    h3 = {
      id: "H3",
      supported: false,
      evidence: "not_applicable_no_mechanical_tasks",
      metrics: {
        mechTaskCount: 0,
      },
    };
  } else {
    let mechPassedC = 0;
    let mechTotalC = 0;
    let mechCostC = 0;

    let mechPassedD = 0;
    let mechTotalD = 0;
    let mechCostD = 0;

    for (const t of mechTasks) {
      const cAttempts = results[t.id]?.["C"] ?? [];
      for (const a of cAttempts) {
        mechTotalC++;
        if (a.passed) mechPassedC++;
        mechCostC += a.costUsd || 0;
      }
      const dAttempts = results[t.id]?.["D"] ?? [];
      for (const a of dAttempts) {
        mechTotalD++;
        if (a.passed) mechPassedD++;
        mechCostD += a.costUsd || 0;
      }
    }

    const mechPassRateC = mechTotalC > 0 ? mechPassedC / mechTotalC : 0;
    const mechPassRateD = mechTotalD > 0 ? mechPassedD / mechTotalD : 0;
    const passRateDelta = mechPassRateC - mechPassRateD;

    const passRateOk = passRateDelta <= 0.10;
    const costOk = mechCostD <= 0.10 * mechCostC || mechCostD <= 0.01;
    const h3Supported = passRateOk && costOk;

    let h3Evidence = "";
    if (h3Supported) {
      h3Evidence = `Arm D pass rate on mechanical/boilerplate tasks (${(mechPassRateD * 100).toFixed(1)}%) is within 10 percentage points of Arm C (${(mechPassRateC * 100).toFixed(1)}%, delta ${(passRateDelta * 100).toFixed(1)} points) at near-zero marginal cost ($${mechCostD.toFixed(3)} vs $${mechCostC.toFixed(3)})`;
    } else if (!passRateOk) {
      h3Evidence = `Arm D pass rate on mechanical/boilerplate tasks (${(mechPassRateD * 100).toFixed(1)}%) dropped more than 10 percentage points below Arm C (${(mechPassRateC * 100).toFixed(1)}%, delta ${(passRateDelta * 100).toFixed(1)} points)`;
    } else {
      h3Evidence = `Arm D mechanical cost ($${mechCostD.toFixed(3)}) exceeded near-zero marginal cost threshold ($${(mechCostC * 0.10).toFixed(3)} or $0.01)`;
    }

    h3 = {
      id: "H3",
      supported: h3Supported,
      evidence: h3Evidence,
      metrics: {
        mechTaskCount: mechTasks.length,
        mechPassRateC,
        mechPassRateD,
        passRateDelta,
        mechCostC,
        mechCostD,
      },
    };
  }

  return { h1, h2, h3 };
}

export function formatBenchmarkReport(
  report: BenchmarkReport,
  format: "text" | "json" | "markdown"
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  if (format === "markdown") {
    const lines: string[] = [];
    lines.push("# Substrate Benchmark Report");
    lines.push("");
    lines.push(`Timestamp: ${report.timestamp}`);
    lines.push("");
    lines.push("## Arm Summaries");
    lines.push("");
    lines.push(
      "| Arm | Attempts | Passed | Pass Rate | First-Pass Verify Rate | Total Cost ($) | Mean Cost ($) | Mean Duration (ms) |"
    );
    lines.push(
      "| --- | --- | --- | --- | --- | --- | --- | --- |"
    );
    for (const arm of ["A", "B", "C", "D"] as BenchmarkArm[]) {
      const s = report.armSummaries[arm];
      if (s) {
        lines.push(
          `| ${s.arm} | ${s.totalAttempts} | ${s.passedAttempts} | ${(s.passRate * 100).toFixed(1)}% | ${(s.firstPassVerifyRate * 100).toFixed(1)}% | $${s.totalCostUsd.toFixed(2)} | $${s.meanCostUsd.toFixed(2)} | ${Math.round(s.meanDurationMs)}ms |`
        );
      }
    }
    lines.push("");
    lines.push("## Hypotheses");
    lines.push("");
    lines.push(`- **H1** (${report.hypotheses.h1.supported ? "Supported" : "Unsupported"}): ${report.hypotheses.h1.evidence}`);
    lines.push(`- **H2** (${report.hypotheses.h2.supported ? "Supported" : "Unsupported"}): ${report.hypotheses.h2.evidence}`);
    lines.push(`- **H3** (${report.hypotheses.h3.supported ? "Supported" : "Unsupported"}): ${report.hypotheses.h3.evidence}`);
    lines.push("");
    return lines.join("\n");
  }

  // format === "text"
  const lines: string[] = [];
  lines.push("=== Substrate Benchmark Report ===");
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push("");
  lines.push("Arm Summaries:");
  lines.push(
    "Arm | Attempts | Passed | Pass Rate | First-Pass Rate | Total Cost | Mean Cost | Mean Duration"
  );
  lines.push("-".repeat(80));
  for (const arm of ["A", "B", "C", "D"] as BenchmarkArm[]) {
    const s = report.armSummaries[arm];
    if (s) {
      lines.push(
        `${s.arm.padEnd(3)} | ${String(s.totalAttempts).padEnd(8)} | ${String(s.passedAttempts).padEnd(6)} | ${(s.passRate * 100).toFixed(1).padStart(8)}% | ${(s.firstPassVerifyRate * 100).toFixed(1).padStart(14)}% | $${s.totalCostUsd.toFixed(2).padStart(9)} | $${s.meanCostUsd.toFixed(2).padStart(8)} | ${Math.round(s.meanDurationMs)}ms`
      );
    }
  }
  lines.push("");
  lines.push("Hypotheses Evaluation:");
  lines.push(`H1 [${report.hypotheses.h1.supported ? "SUPPORTED" : "UNSUPPORTED"}]: ${report.hypotheses.h1.evidence}`);
  lines.push(`H2 [${report.hypotheses.h2.supported ? "SUPPORTED" : "UNSUPPORTED"}]: ${report.hypotheses.h2.evidence}`);
  lines.push(`H3 [${report.hypotheses.h3.supported ? "SUPPORTED" : "UNSUPPORTED"}]: ${report.hypotheses.h3.evidence}`);
  lines.push("");
  return lines.join("\n");
}
