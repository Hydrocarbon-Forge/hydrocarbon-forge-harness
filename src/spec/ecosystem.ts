import fs from "node:fs";
import path from "node:path";
import { Command } from "../contracts/index.js";

export type Ecosystem = "node-ts" | "python" | "rust" | "go" | "other";

export async function detectEcosystem(repoRoot: string): Promise<Ecosystem> {
  const exists = (rel: string) => fs.existsSync(path.resolve(repoRoot, rel));

  // Strict precedence: node-ts > python > rust > go > other
  if (exists("package.json") || exists("tsconfig.json")) {
    return "node-ts";
  }
  if (
    exists("pyproject.toml") ||
    exists("setup.py") ||
    exists("requirements.txt") ||
    exists("Pipfile")
  ) {
    return "python";
  }
  if (exists("Cargo.toml")) {
    return "rust";
  }
  if (exists("go.mod")) {
    return "go";
  }
  return "other";
}

export function getDefaultVerify(ecosystem: Ecosystem): Command[] {
  switch (ecosystem) {
    case "node-ts":
      return [{ run: "npm test", timeout_s: 300 }];
    case "python":
      return [{ run: "pytest", timeout_s: 300 }];
    case "rust":
      return [{ run: "cargo test", timeout_s: 300 }];
    case "go":
      return [{ run: "go test ./...", timeout_s: 300 }];
    case "other":
    default:
      return [{ run: "echo 'No default verify command'", timeout_s: 60 }];
  }
}
