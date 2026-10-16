import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  generateRepoMap,
  type RepoMapOptions,
  type RepoMapResult,
} from "../../../src/spec/repomap.js";
import { createTempRepo } from "./fixtures.js";

describe("repo map: generateRepoMap", () => {
  it("generates a structural repo map of repository files", async () => {
    const repo = createTempRepo();
    writeFileSync(join(repo, "package.json"), "{}");
    writeFileSync(join(repo, "src", "index.ts"), "export const a = 1;");
    writeFileSync(join(repo, "src", "util.ts"), "export const b = 2;");
    writeFileSync(join(repo, "test", "index.test.ts"), "test");

    const result = await generateRepoMap(repo);

    expect(typeof result.mapText).toBe("string");
    expect(result.fileCount).toBeGreaterThanOrEqual(4);
    expect(result.byteCount).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);

    expect(result.mapText).toContain("src/index.ts");
    expect(result.mapText).toContain("src/util.ts");
    expect(result.mapText).toContain("package.json");
  });

  it("excludes default ignored directories (.git, .substrate, node_modules)", async () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, ".git", "objects"), { recursive: true });
    writeFileSync(join(repo, ".git", "config"), "git config");

    mkdirSync(join(repo, ".substrate", "state"), { recursive: true });
    writeFileSync(join(repo, ".substrate", "settings.json"), "{}");

    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "");

    writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;");

    const result = await generateRepoMap(repo);

    expect(result.mapText).toContain("src/app.ts");
    expect(result.mapText).not.toContain(".git/config");
    expect(result.mapText).not.toContain(".substrate/settings.json");
    expect(result.mapText).not.toContain("node_modules/pkg");
  });

  it("respects .gitignore patterns", async () => {
    const repo = createTempRepo();
    writeFileSync(join(repo, ".gitignore"), "dist/\n*.secret\n");
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, "dist", "bundle.js"), "bundle");
    writeFileSync(join(repo, "src", "keys.secret"), "key");
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;");

    const result = await generateRepoMap(repo);

    expect(result.mapText).toContain("src/app.ts");
    expect(result.mapText).not.toContain("dist/bundle.js");
    expect(result.mapText).not.toContain("keys.secret");
  });

  it("excludes binary files", async () => {
    const repo = createTempRepo();
    writeFileSync(join(repo, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(repo, "app.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    writeFileSync(join(repo, "code.ts"), "export const x = 1;");

    const result = await generateRepoMap(repo);

    expect(result.mapText).toContain("code.ts");
    expect(result.mapText).not.toContain("image.png");
    expect(result.mapText).not.toContain("app.bin");
  });

  it("respects maxDepth option", async () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, "level1", "level2", "level3"), { recursive: true });
    writeFileSync(join(repo, "level1", "a.ts"), "");
    writeFileSync(join(repo, "level1", "level2", "b.ts"), "");
    writeFileSync(join(repo, "level1", "level2", "level3", "c.ts"), "");

    const result = await generateRepoMap(repo, { maxDepth: 1 });

    expect(result.mapText).toContain("level1/a.ts");
    expect(result.mapText).not.toContain("level3/c.ts");
  });

  it("respects maxFiles option", async () => {
    const repo = createTempRepo();
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(repo, `file_${i}.ts`), `const v = ${i};`);
    }

    const result = await generateRepoMap(repo, { maxFiles: 5 });

    expect(result.fileCount).toBeLessThanOrEqual(5);
  });

  it("caps output at maxBytes and sets truncated flag with notice", async () => {
    const repo = createTempRepo();
    // Create many files to exceed small maxBytes
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(repo, `file_${i}.ts`), `const v = ${i};`);
    }

    const smallMaxBytes = 200;
    const result = await generateRepoMap(repo, { maxBytes: smallMaxBytes });

    expect(result.truncated).toBe(true);
    expect(result.byteCount).toBeLessThanOrEqual(smallMaxBytes + 100); // small tolerance for notice
    expect(result.mapText.toLowerCase()).toContain("truncat");
  });

  it("respects custom excludePatterns", async () => {
    const repo = createTempRepo();
    writeFileSync(join(repo, "src", "skip_me.txt"), "skip");
    writeFileSync(join(repo, "src", "keep_me.txt"), "keep");

    const result = await generateRepoMap(repo, {
      excludePatterns: ["**/skip_me.txt"],
    });

    expect(result.mapText).toContain("keep_me.txt");
    expect(result.mapText).not.toContain("skip_me.txt");
  });
});
