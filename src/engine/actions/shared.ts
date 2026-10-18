import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { EngineEvent, Manifest, SessionHandle, TaskId } from "../../contracts/index.js";
import type { EngineState } from "../reducer.js";
import { appendRunEvent, type EffectContext } from "../effects.js";
import type { TypedEmit } from "../emit.js";
import {
  parseManifest,
  parseTaskSpec,
  type ParsedPlan,
  type ParsedTaskSpec,
} from "../../spec/index.js";

export type Emit = TypedEmit;

export { makeEmitter } from "../emit.js";

export function extractFencedFiles(text: string): Map<string, string> {
  const files = new Map<string, string>();
  const headerRegex = /```(?:[a-zA-Z0-9_-]+):([^\n\r]+)/g;
  const matches: Array<{ file: string; start: number; headerIndex: number }> = [];
  let match;
  while ((match = headerRegex.exec(text)) !== null) {
    matches.push({
      file: match[1].trim(),
      start: match.index + match[0].length,
      headerIndex: match.index,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    let endIdx: number;
    if (i + 1 < matches.length) {
      endIdx = text.lastIndexOf("```", matches[i + 1].headerIndex - 1);
    } else {
      endIdx = text.lastIndexOf("```");
    }
    const content = (endIdx > cur.start ? text.slice(cur.start, endIdx) : text.slice(cur.start)).trim();
    files.set(cur.file, content);
  }
  return files;
}

export function safeParseManifest(raw: string, filePath?: string): Manifest {
  try {
    return parseManifest(raw, filePath);
  } catch {
    return YAML.parse(raw) as Manifest;
  }
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

export function bindAbort(ctx: EffectContext, handle: SessionHandle): () => void {
  if (!ctx.signal) {
    return () => {};
  }
  if (ctx.signal.aborted) {
    handle.kill("cancel");
    return () => {};
  }
  const onAbort = () => {
    handle.kill("cancel");
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    ctx.signal?.removeEventListener("abort", onAbort);
  };
}

