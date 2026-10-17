import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BenchmarkTaskSpec } from "../../../bench/types.js";
import { loadBenchmarkTasks } from "../../../bench/tasks.js";

describe("Benchmark task loading and validation (P6.3 §13)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-tasks-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createFixtureRepo(name: string): string {
    const fixturePath = path.join(tempDir, "fixtures", name);
    fs.mkdirSync(fixturePath, { recursive: true });
    fs.writeFileSync(path.join(fixturePath, "package.json"), JSON.stringify({ name }));
    return fixturePath;
  }

  function writeTaskFile(relPath: string, content: string): string {
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return fullPath;
  }

  describe("YAML frontmatter parsing of BenchmarkTaskSpec", () => {
    it("parses valid benchmark task specification with complete frontmatter", async () => {
      createFixtureRepo("demo-repo");

      const taskContent = `---
id: T01-feature-add-auth
title: "Add token auth middleware"
task_class: feature
tags:
  - auth
  - middleware
repo_fixture: fixtures/demo-repo
base_commit: abc1234
setup:
  - run: npm install
    timeout_s: 60
verify:
  - run: npm test -- test/auth.test.js
    timeout_s: 30
budget:
  max_usd: 1.50
  timeout_min: 10
  max_tokens: 50000
---

## Description
This task implements token-based authentication middleware.
`;

      writeTaskFile("bench/tasks/01-auth.md", taskContent);

      const tasks = await loadBenchmarkTasks(["bench/tasks/*.md"], tempDir);

      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.id).toBe("T01-feature-add-auth");
      expect(task.title).toBe("Add token auth middleware");
      expect(task.task_class).toBe("feature");
      expect(task.tags).toEqual(["auth", "middleware"]);
      expect(task.repo_fixture).toBe("fixtures/demo-repo");
      expect(task.base_commit).toBe("abc1234");
      expect(task.setup).toEqual([{ run: "npm install", timeout_s: 60 }]);
      expect(task.verify).toEqual([
        { run: "npm test -- test/auth.test.js", timeout_s: 30 },
      ]);
      expect(task.budget).toEqual({
        max_usd: 1.5,
        timeout_min: 10,
        max_tokens: 50000,
      });
      expect(task.description).toContain("This task implements token-based authentication middleware.");
    });

    it("parses minimal valid task specification with optional fields omitted", async () => {
      createFixtureRepo("minimal-repo");

      const taskContent = `---
id: T02-minimal-task
title: "Minimal Task"
task_class: mechanical
repo_fixture: fixtures/minimal-repo
verify:
  - run: npm run lint
    timeout_s: 15
budget:
  max_usd: 0.50
---
`;

      writeTaskFile("bench/tasks/02-minimal.md", taskContent);

      const tasks = await loadBenchmarkTasks(["bench/tasks/02-minimal.md"], tempDir);

      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.id).toBe("T02-minimal-task");
      expect(task.title).toBe("Minimal Task");
      expect(task.task_class).toBe("mechanical");
      expect(task.repo_fixture).toBe("fixtures/minimal-repo");
      expect(task.setup).toBeUndefined();
      expect(task.tags).toBeUndefined();
      expect(task.base_commit).toBeUndefined();
      expect(task.verify).toEqual([{ run: "npm run lint", timeout_s: 15 }]);
      expect(task.budget.max_usd).toBe(0.5);
    });

    it("supports tasks spanning various task classes: feature, debug, refactor, mechanical, boilerplate, tests", async () => {
      const fixture = createFixtureRepo("suite-repo");

      const taskClasses = [
        "feature",
        "debug",
        "refactor",
        "mechanical",
        "boilerplate",
        "tests",
      ] as const;

      for (const [idx, cls] of taskClasses.entries()) {
        writeTaskFile(
          `bench/tasks/task-${idx}.md`,
          `---
id: TASK-${cls.toUpperCase()}
title: "Task for ${cls}"
task_class: ${cls}
repo_fixture: fixtures/suite-repo
verify:
  - run: npm test
    timeout_s: 10
budget:
  max_usd: 1.00
---
`
        );
      }

      const tasks = await loadBenchmarkTasks(["bench/tasks/*.md"], tempDir);
      expect(tasks).toHaveLength(taskClasses.length);
      const loadedClasses = tasks.map((t) => t.task_class);
      for (const cls of taskClasses) {
        expect(loadedClasses).toContain(cls);
      }
    });
  });

  describe("Validation error handling", () => {
    it("throws validation error when file lacks YAML frontmatter delimiters", async () => {
      writeTaskFile(
        "bench/tasks/no-frontmatter.md",
        `# Just markdown
No YAML frontmatter at all.
`
      );

      await expect(
        loadBenchmarkTasks(["bench/tasks/no-frontmatter.md"], tempDir)
      ).rejects.toThrow(/frontmatter|malformed/i);
    });

    it("throws validation error when required field 'id' is missing", async () => {
      createFixtureRepo("test-repo");
      writeTaskFile(
        "bench/tasks/missing-id.md",
        `---
title: "Missing ID Task"
task_class: debug
repo_fixture: fixtures/test-repo
verify:
  - run: npm test
    timeout_s: 10
budget:
  max_usd: 1.0
---
`
      );

      await expect(
        loadBenchmarkTasks(["bench/tasks/missing-id.md"], tempDir)
      ).rejects.toThrow(/id/i);
    });

    it("throws validation error when required field 'title' is missing", async () => {
      createFixtureRepo("test-repo");
      writeTaskFile(
        "bench/tasks/missing-title.md",
        `---
id: T-MISSING-TITLE
task_class: debug
repo_fixture: fixtures/test-repo
verify:
  - run: npm test
    timeout_s: 10
budget:
  max_usd: 1.0
---
`
      );

      await expect(
        loadBenchmarkTasks(["bench/tasks/missing-title.md"], tempDir)
      ).rejects.toThrow(/title/i);
    });

    it("throws validation error when required field 'task_class' is missing", async () => {
      createFixtureRepo("test-repo");
      writeTaskFile(
        "bench/tasks/missing-class.md",
        `---
id: T-MISSING-CLASS
title: "Missing task_class"
repo_fixture: fixtures/test-repo
verify:
  - run: npm test
    timeout_s: 10
budget:
  max_usd: 1.0
---
`
      );

      await expect(
        loadBenchmarkTasks(["bench/tasks/missing-class.md"], tempDir)
      ).rejects.toThrow(/task_class/i);
    });

    it("throws validation error when required field 'repo_fixture' is missing", async () => {
      writeTaskFile(
        "bench/tasks/missing-fixture.md",
        `---
id: T-MISSING-FIXTURE
title: "Missing repo_fixture"
task_class: feature
verify:
  - run: npm test
    timeout_s: 10
budget:
  max_usd: 1.0
---
`
      );

      await expect(
        loadBenchmarkTasks(["bench/tasks/missing-fixture.md"], tempDir)
      ).rejects.toThrow(/repo_fixture/i);
    });

    it("throws validation error when 'verify' command array is empty per §204", async () => {
      createFixtureRepo("test-repo");
      writeTaskFile(
        "bench/tasks/empty-verify.md",
        `---
id: T-EMPTY-VERIFY
title: "Empty verify"
task_class: feature
repo_fixture: fixtures/test-repo
verify: []
budget:
  max_usd: 1.0
---
`
      );

      await expect(
        loadBenchmarkTasks(["bench/tasks/empty-verify.md"], tempDir)
      ).rejects.toThrow(/Task must specify at least one verification command/i);
    });

    it("throws error 'Fixture path not found: <repo_fixture>' when repo_fixture does not exist per §204", async () => {
      writeTaskFile(
        "bench/tasks/nonexistent-fixture.md",
        `---
id: T-NONEXISTENT-FIXTURE
title: "Nonexistent fixture"
task_class: feature
repo_fixture: fixtures/non-existent-directory
verify:
  - run: npm test
    timeout_s: 10
budget:
  max_usd: 1.0
---
`
      );

      await expect(
        loadBenchmarkTasks(["bench/tasks/nonexistent-fixture.md"], tempDir)
      ).rejects.toThrow(/Fixture path not found: fixtures\/non-existent-directory/i);
    });
  });

  describe("Discovery of tasks in default or custom glob", () => {
    it("discovers all tasks in default directory 'bench/tasks/**' when default glob is used", async () => {
      createFixtureRepo("default-repo");

      writeTaskFile(
        "bench/tasks/task1.md",
        `---
id: T01
title: "Task 1"
task_class: feature
repo_fixture: fixtures/default-repo
verify:
  - run: npm test
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );
      writeTaskFile(
        "bench/tasks/nested/task2.md",
        `---
id: T02
title: "Task 2"
task_class: refactor
repo_fixture: fixtures/default-repo
verify:
  - run: npm test
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );

      const tasks = await loadBenchmarkTasks(["bench/tasks/**"], tempDir);
      expect(tasks).toHaveLength(2);
      const ids = tasks.map((t) => t.id).sort();
      expect(ids).toEqual(["T01", "T02"]);
    });

    it("discovers tasks using custom glob matching specific patterns", async () => {
      createFixtureRepo("glob-repo");

      writeTaskFile(
        "bench/tasks/special-a.md",
        `---
id: T-SPEC-A
title: "Special A"
task_class: debug
repo_fixture: fixtures/glob-repo
verify:
  - run: npm test
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );
      writeTaskFile(
        "bench/tasks/other.md",
        `---
id: T-OTHER
title: "Other"
task_class: debug
repo_fixture: fixtures/glob-repo
verify:
  - run: npm test
    timeout_s: 5
budget:
  max_usd: 1.0
---
`
      );

      const tasks = await loadBenchmarkTasks(["bench/tasks/special-*.md"], tempDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("T-SPEC-A");
    });

    it("returns empty array when glob matches no files", async () => {
      const tasks = await loadBenchmarkTasks(["bench/nonexistent/*.md"], tempDir);
      expect(tasks).toEqual([]);
    });
  });
});
