import fs from "node:fs";
import path from "node:path";

import type {
  BackendName,
  EngineEvent,
  HarnessAdapter,
  Manifest,
  TaskId,
} from "../../contracts/index.js";
import type { EngineState } from "../reducer.js";
import type { EffectContext } from "../effects.js";
import type { TypedEmit } from "../emit.js";
import {
  parseManifest,
  parseTaskSpec,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../../spec/index.js";

export type Emit = TypedEmit;

export { makeEmitter } from "../emit.js";

export function safeParseManifest(raw: string, filePath?: string): Manifest {
  return parseManifest(raw, filePath);
}

export async function safeLoadPlan(
  manifestPath: string,
  repoRoot?: string
): Promise<ParsedPlan & { cleanup: () => void }> {
  const resolvedManifestPath = path.resolve(manifestPath);
  const rawManifest = await fs.promises.readFile(resolvedManifestPath, "utf8");
  const manifest = safeParseManifest(rawManifest, manifestPath);
  const manifestDir = path.dirname(resolvedManifestPath);
  const specs = new Map<TaskId, ParsedTaskSpec>();
  const createdFiles: string[] = [];

  if (repoRoot && manifest.contracts?.files) {
    for (const f of manifest.contracts.files) {
      const full = path.resolve(repoRoot, f);
      if (!fs.existsSync(full)) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "export {};\n", "utf8");
        createdFiles.push(full);
      }
    }
  }

  for (const task of manifest.tasks ?? []) {
    const specPath = path.resolve(manifestDir, task.spec);
    let rawSpec = "";
    if (fs.existsSync(specPath)) {
      rawSpec = await fs.promises.readFile(specPath, "utf8");
    }
    const parsedSpec = parseTaskSpec(rawSpec, task.spec);
    if (!parsedSpec.frontmatter.budget) {
      parsedSpec.frontmatter.budget = { max_usd: 0.5, timeout_min: 30 };
    }

    if (repoRoot) {
      const repoSpecPath = path.resolve(repoRoot, task.spec);
      if (!fs.existsSync(repoSpecPath) && fs.existsSync(specPath)) {
        fs.mkdirSync(path.dirname(repoSpecPath), { recursive: true });
        fs.copyFileSync(specPath, repoSpecPath);
        createdFiles.push(repoSpecPath);
      }
      for (const w of parsedSpec.frontmatter.write ?? []) {
        const repoW = path.resolve(repoRoot, w);
        if (!fs.existsSync(repoW)) {
          fs.mkdirSync(path.dirname(repoW), { recursive: true });
          fs.writeFileSync(repoW, `// stub ${w}\n`, "utf8");
          createdFiles.push(repoW);
        }
      }
    }

    specs.set(task.id, parsedSpec);
  }

  const cleanup = () => {
    for (const f of createdFiles) {
      try {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      } catch {}
    }
  };

  return {
    manifest,
    specs,
    rawManifest,
    manifestPath,
    cleanup,
  };
}

export function adapterFor(
  ctx: EffectContext,
  backend: BackendName
): HarnessAdapter | null {
  const { adapters } = ctx;
  return (backend ? adapters[backend] : undefined) ?? null;
}

