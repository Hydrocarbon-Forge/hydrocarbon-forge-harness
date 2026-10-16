import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  discoverCommands,
  discoverSkills,
  loadAgentDefinitions,
} from "../../../src/config/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "substrate-defs-"));
}

function agentFile(
  dir: string,
  file: string,
  frontmatter: Record<string, unknown>,
  body = "system prompt",
): string {
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const full = join(dir, file);
  writeFileSync(full, `---\n${fm}\n---\n${body}\n`);
  return full;
}

describe("config definitions loader: agents", () => {
  it("loads frontmatter with name/description/role plus optionals", async () => {
    const projectDir = tmp();
    const agentsDir = join(projectDir, ".substrate", "agents");
    agentFile(agentsDir, "coder.md", {
      name: "coder",
      description: "writes code",
      role: "worker",
      backend: "claude",
      model: "m",
      effort: "medium",
      permissionMode: "default",
      maxTurns: 10,
    });
    const { agents, errors } = await loadAgentDefinitions({
      projectDir,
      userConfigDir: tmp(),
      builtinsDir: tmp(),
    });
    expect(errors).toEqual([]);
    expect(agents.map((a) => a.name)).toContain("coder");
    const coder = agents.find((a) => a.name === "coder");
    expect(coder?.role).toBe("worker");
  });

  it("rejects the file when name/description/role are missing, others still load", async () => {
    const projectDir = tmp();
    const agentsDir = join(projectDir, ".substrate", "agents");
    agentFile(agentsDir, "good.md", { name: "good", description: "ok", role: "worker" });
    agentFile(agentsDir, "no-role.md", { name: "bad", description: "missing role" });
    agentFile(agentsDir, "bad-role.md", { name: "bad2", description: "x", role: "wizard" });
    const { agents, errors } = await loadAgentDefinitions({
      projectDir,
      userConfigDir: tmp(),
      builtinsDir: tmp(),
    });
    expect(agents.map((a) => a.name)).toContain("good");
    expect(agents.map((a) => a.name)).not.toContain("bad");
    expect(agents.map((a) => a.name)).not.toContain("bad2");
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("precedence is project over user over builtin; higher wins", async () => {
    const projectDir = tmp();
    const userDir = tmp();
    const builtinDir = tmp();
    agentFile(join(builtinDir), "same.md", {
      name: "same",
      description: "builtin",
      role: "worker",
    });
    agentFile(join(userDir, "agents"), "same.md", {
      name: "same",
      description: "user",
      role: "worker",
    });
    agentFile(join(projectDir, ".substrate", "agents"), "same.md", {
      name: "same",
      description: "project",
      role: "worker",
    });
    const { agents, errors } = await loadAgentDefinitions({
      projectDir,
      userConfigDir: userDir,
      builtinsDir: builtinDir,
    });
    expect(errors).toEqual([]);
    expect(agents.filter((a) => a.name === "same")).toHaveLength(1);
    expect(agents.find((a) => a.name === "same")?.description).toBe("project");
  });

  it("duplicate names within one layer error", async () => {
    const projectDir = tmp();
    const agentsDir = join(projectDir, ".substrate", "agents");
    agentFile(agentsDir, "a1.md", { name: "dup", description: "one", role: "worker" });
    agentFile(agentsDir, "a2.md", { name: "dup", description: "two", role: "worker" });
    const result = await loadAgentDefinitions({
      projectDir,
      userConfigDir: tmp(),
      builtinsDir: tmp(),
    });
    const failed =
      result.errors.length > 0 || result.agents.filter((a) => a.name === "dup").length !== 1;
    expect(failed).toBe(true);
  });

  it("never reads foreign .claude/ or .opencode/ dirs implicitly", async () => {
    const projectDir = tmp();
    agentFile(join(projectDir, ".claude", "agents"), "foreign.md", {
      name: "foreign",
      description: "must not load",
      role: "worker",
    });
    agentFile(join(projectDir, ".opencode", "agents"), "foreign2.md", {
      name: "foreign2",
      description: "must not load",
      role: "worker",
    });
    const { agents } = await loadAgentDefinitions({
      projectDir,
      userConfigDir: tmp(),
      builtinsDir: tmp(),
    });
    expect(agents.map((a) => a.name)).not.toContain("foreign");
    expect(agents.map((a) => a.name)).not.toContain("foreign2");
  });
});

describe("config discovery stubs: commands and skills", () => {
  it("discovers commands as structural summaries only", async () => {
    const dir = join(tmp(), "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "deploy.md"),
      `---\ndescription: "Deploy it"\nargument-hint: "<env>"\nmodel: "m"\n---\nRun $ARGUMENTS SECRET-BODY-MARKER-123\n`,
    );
    const commands = await discoverCommands(dir);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "deploy", description: "Deploy it" });
    expect(JSON.stringify(commands[0])).not.toContain("SECRET-BODY-MARKER-123");
    expect(Object.keys(commands[0]).sort()).toEqual(
      expect.arrayContaining(["name", "description"]),
    );
    expect("body" in (commands[0] as Record<string, unknown>)).toBe(false);
    expect("prompt" in (commands[0] as Record<string, unknown>)).toBe(false);
  });

  it("discovers skills as name/description only", async () => {
    const root = tmp();
    const skillDir = join(root, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: "my-skill"\ndescription: "Does things"\n---\nSECRET-SKILL-BODY-456\n`,
    );
    const skills = await discoverSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({ name: "my-skill", description: "Does things" });
    expect(JSON.stringify(skills)).not.toContain("SECRET-SKILL-BODY-456");
  });

  it("empty or missing dirs return empty summaries without throwing", async () => {
    await expect(discoverCommands(join(tmp(), "nope"))).resolves.toEqual([]);
    await expect(discoverSkills(join(tmp(), "nope"))).resolves.toEqual([]);
  });
});
