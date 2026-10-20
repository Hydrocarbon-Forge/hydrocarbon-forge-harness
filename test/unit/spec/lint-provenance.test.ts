import { describe, expect, it } from "vitest";

import { lintPlan } from "../../../src/spec/linter.js";
import {
  createTempRepo,
  sampleManifest,
  sampleTaskSpecFrontmatter,
  sampleParsedTaskSpec,
  sampleParsedPlan,
  sampleSettings,
} from "./fixtures.js";

const TEST_PATH = "test/unit/feature.test.ts";

function planOf(
  tasks: Array<{ id: string; depends_on?: string[]; create?: string[]; write?: string[]; protected?: string[]; class?: string; run?: string }>
) {
  const specs = tasks.map((t) =>
    sampleParsedTaskSpec({
      frontmatter: sampleTaskSpecFrontmatter({
        id: t.id as any,
        class: (t.class ?? "feature") as any,
        depends_on: (t.depends_on ?? []) as any,
        create: t.create ?? [],
        write: t.write ?? [],
        protected: t.protected ?? [],
        verify: [{ run: t.run ?? "node --test test/", timeout_s: 30 }],
      }),
    })
  );
  return sampleParsedPlan({
    manifest: sampleManifest({
      tasks: tasks.map((t) => ({ id: t.id as any, spec: `tasks/${t.id}.md` })),
    }),
    specs,
  });
}

async function errorsFor(code: string, plan: ReturnType<typeof planOf>) {
  const result = await lintPlan(plan, createTempRepo(), sampleSettings());
  return result.diagnostics.filter((d) => d.code === code && d.severity === "error");
}

describe("L009: ancestors and the protecting task's descendants", () => {
  it("L009 is not raised when the creator is an ancestor of the protecting task, even for class feature", async () => {
    const plan = planOf([
      { id: "T1", class: "feature", create: [TEST_PATH] },
      { id: "T2", depends_on: ["T1"], protected: [TEST_PATH] },
    ]);
    expect(await errorsFor("L009", plan)).toEqual([]);
  });

  it("L009 is not raised for a transitive ancestor creator", async () => {
    const plan = planOf([
      { id: "T1", create: [TEST_PATH] },
      { id: "T2", depends_on: ["T1"] },
      { id: "T3", depends_on: ["T2"], protected: [TEST_PATH] },
    ]);
    expect(await errorsFor("L009", plan)).toEqual([]);
  });

  it("L009 is still raised for a concurrent task that is not an ancestor, with an actionable message", async () => {
    const plan = planOf([
      { id: "T1", protected: [TEST_PATH] },
      { id: "T2", create: [TEST_PATH] },
    ]);
    const diags = await errorsFor("L009", plan);
    expect(diags).toHaveLength(1);
    expect(diags[0].task).toBe("T2");
    expect(diags[0].message).toBe(
      `Task T2 modifies path '${TEST_PATH}' protected by task T1; make T2 a dependency of T1 (depends_on) or remove '${TEST_PATH}' from T1's protected list`
    );
  });

  it("L009 is still raised for a descendant of the protecting task that modifies the protected path", async () => {
    const plan = planOf([
      { id: "T1", create: [TEST_PATH] },
      { id: "T2", depends_on: ["T1"], protected: [TEST_PATH] },
      { id: "T3", depends_on: ["T2"], write: [TEST_PATH] },
    ]);
    const diags = await errorsFor("L009", plan);
    expect(diags.map((d) => d.task)).toEqual(["T3"]);
  });

  it("L009 is raised when a task modifies a path it protects itself", async () => {
    const plan = planOf([{ id: "T1", create: [TEST_PATH], protected: [TEST_PATH] }]);
    const diags = await errorsFor("L009", plan);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("protects itself");
  });

  it("the tests-class exemption still applies to a concurrent tests task", async () => {
    const plan = planOf([
      { id: "T1", protected: [TEST_PATH] },
      { id: "T2", class: "tests", create: [TEST_PATH] },
    ]);
    expect(await errorsFor("L009", plan)).toEqual([]);
  });
});

describe("L012: verify test paths provided by the task or its dependencies", () => {
  it("L012 is not raised for a test path the same task creates", async () => {
    const plan = planOf([{ id: "T1", create: [TEST_PATH], run: `node --check ${TEST_PATH}` }]);
    expect(await errorsFor("L012", plan)).toEqual([]);
  });

  it("L012 is not raised for a test path a dependency creates", async () => {
    const plan = planOf([
      { id: "T1", create: [TEST_PATH] },
      { id: "T2", depends_on: ["T1"], run: `node --test ${TEST_PATH}` },
    ]);
    expect(await errorsFor("L012", plan)).toEqual([]);
  });

  it("L012 is raised for a test path only an unrelated task creates", async () => {
    const plan = planOf([
      { id: "T1", create: [TEST_PATH] },
      { id: "T2", run: `node --test ${TEST_PATH}` },
    ]);
    const diags = await errorsFor("L012", plan);
    expect(diags.map((d) => d.task)).toEqual(["T2"]);
  });

  it("L012 is raised for a test path nobody creates, with an actionable message", async () => {
    const plan = planOf([{ id: "T1", run: `node --test ${TEST_PATH}` }]);
    const diags = await errorsFor("L012", plan);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe(
      `Verify command references test path '${TEST_PATH}' that nothing provides; create it in this task or a dependency, or fix the path`
    );
  });
});
