import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { Effort, Engine, PermissionMode } from "../../contracts/index.js";
import type { SessionStore } from "../../store/sessions.js";
import { readCharter } from "../../charter/index.js";

export interface CliGlobalFlags {
  print?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  workerModel?: string;
  effort?: Effort;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  mode?: "auto" | "solo" | "plan";
  noGovernor?: boolean;
  historyAll?: boolean;
}

export interface CliGovernanceFlags {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  timeout?: number;
  sandbox?: boolean;
  settings?: string;
}

export type ParsedCliFlags = CliGlobalFlags & CliGovernanceFlags;

export interface CommandContext {
  cwd: string;
  flags: ParsedCliFlags;
  rawArgs: string[];
  stdin?: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  engine?: Engine;
  sessionStore?: SessionStore;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(ctx: CommandContext): Promise<number>;
}

const { registry } = await import(`../registry.js`);

export const charterCommand: CliCommand = {
  name: "charter",
  description: "View or modify project charter and version",
  async execute(ctx: CommandContext): Promise<number> {
    const sub = ctx.rawArgs[0];
    const substrateDir = path.join(ctx.cwd, ".substrate");

    if (sub === "show") {
      const charterPath = path.join(substrateDir, "charter.md");
      if (!fs.existsSync(charterPath)) {
        ctx.stderr.write("Error: no charter; create one with substrate charter set <file>\n");
        return 2;
      }
      const content = fs.readFileSync(charterPath, "utf8");
      ctx.stdout.write(content.endsWith("\n") ? content : content + "\n");
      return 0;
    }

    if (sub === "set") {
      const target = ctx.rawArgs[1];
      if (!target) {
        ctx.stderr.write("Error: file or '-' required for charter set\n");
        return 2;
      }

      let rawInput: string | undefined;
      if (target === "-") {
        rawInput = ctx.stdin;
        if (rawInput === undefined && !process.stdin.isTTY) {
          const { readStdinIfAvailable } = await import(`../dispatcher.js`);
          rawInput = await readStdinIfAvailable();
        }
      } else {
        const filePath = path.resolve(ctx.cwd, target);
        if (!fs.existsSync(filePath)) {
          ctx.stderr.write(`Error: file not found: ${target}\n`);
          return 2;
        }
        try {
          rawInput = fs.readFileSync(filePath, "utf8");
        } catch (err: any) {
          ctx.stderr.write(`Error reading file: ${err.message}\n`);
          return 2;
        }
      }

      if (!rawInput || !rawInput.trim()) {
        ctx.stderr.write("Error: charter content cannot be empty\n");
        return 2;
      }

      // Check for frontmatter in the input
      const inputMatch = rawInput.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      let body = rawInput;
      let inputVersion: string | undefined;
      if (inputMatch) {
        body = inputMatch[2];
        try {
          const parsed = YAML.parse(inputMatch[1]);
          if (parsed && typeof parsed === "object" && parsed.version !== undefined) {
            inputVersion = String(parsed.version).trim() || undefined;
          }
        } catch {
          // ignore YAML parse error
        }
      }

      // Check 4096-byte threshold
      if (
        Buffer.byteLength(rawInput, "utf8") > 4096 ||
        Buffer.byteLength(body, "utf8") > 4096
      ) {
        ctx.stderr.write(
          "Warning: charter exceeds 4096 bytes and will be truncated when passed to the planner\n"
        );
      }

      // Existing frontmatter version is preserved if present
      const existing = readCharter(substrateDir);
      const existingVersion = existing?.version;
      const versionToUse = existingVersion ?? inputVersion;

      let toWrite = "";
      if (versionToUse !== undefined) {
        toWrite = `---\nversion: ${versionToUse}\n---\n${body}`;
      } else {
        toWrite = body;
      }
      if (!toWrite.endsWith("\n")) {
        toWrite += "\n";
      }

      fs.mkdirSync(substrateDir, { recursive: true });
      fs.writeFileSync(path.join(substrateDir, "charter.md"), toWrite, "utf8");
      return 0;
    }

    if (sub === "bump") {
      const version = ctx.rawArgs[1];
      if (!version || !/^v\d+$/.test(version)) {
        ctx.stderr.write("Error: invalid version format; must match ^v\\d+$\n");
        return 2;
      }

      fs.mkdirSync(substrateDir, { recursive: true });
      const existing = readCharter(substrateDir);
      const body = existing ? existing.body : "";

      let toWrite = `---\nversion: ${version}\n---\n${body}`;
      if (!toWrite.endsWith("\n")) {
        toWrite += "\n";
      }
      fs.writeFileSync(path.join(substrateDir, "charter.md"), toWrite, "utf8");

      const archiveVerDir = path.join(substrateDir, "archive", version);
      fs.mkdirSync(archiveVerDir, { recursive: true });
      const indexPath = path.join(archiveVerDir, "INDEX.md");
      if (!fs.existsSync(indexPath)) {
        fs.writeFileSync(indexPath, "", "utf8");
      }

      ctx.stdout.write(`charter now at ${version}\n`);
      return 0;
    }

    ctx.stderr.write(`Error: unknown charter command '${sub ?? ""}'\n`);
    return 2;
  },
};

registry.register(charterCommand);
