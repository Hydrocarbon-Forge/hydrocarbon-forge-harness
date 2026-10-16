import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

export interface RepoMapOptions {
  maxBytes?: number;
  maxFiles?: number;
  maxDepth?: number;
  excludePatterns?: string[];
}

export interface RepoMapResult {
  mapText: string;
  fileCount: number;
  byteCount: number;
  truncated: boolean;
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".pdf", ".bin", ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
  ".woff", ".woff2", ".eot", ".ttf", ".otf",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(1024);
    const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function parseGitignore(repoRoot: string): string[] {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  const content = fs.readFileSync(gitignorePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function matchesGitignore(relPath: string, isDir: boolean, patterns: string[]): boolean {
  for (const pat of patterns) {
    let cleanPat = pat;
    const isDirPattern = cleanPat.endsWith("/");
    if (isDirPattern) {
      cleanPat = cleanPat.slice(0, -1);
    }
    if (!cleanPat.includes("/")) {
      if (picomatch(cleanPat, { dot: true })(path.basename(relPath))) return true;
      if (picomatch(`**/${cleanPat}`, { dot: true })(relPath)) return true;
      if (picomatch(`**/${cleanPat}/**`, { dot: true })(relPath)) return true;
    } else {
      if (cleanPat.startsWith("/")) cleanPat = cleanPat.slice(1);
      if (picomatch(cleanPat, { dot: true })(relPath)) return true;
      if (picomatch(`${cleanPat}/**`, { dot: true })(relPath)) return true;
      if (picomatch(`**/${cleanPat}`, { dot: true })(relPath)) return true;
      if (picomatch(`**/${cleanPat}/**`, { dot: true })(relPath)) return true;
    }
    if (isDir && (relPath === cleanPat || relPath.endsWith(`/${cleanPat}`))) {
      return true;
    }
  }
  return false;
}

export async function generateRepoMap(
  repoRoot: string,
  options?: RepoMapOptions
): Promise<RepoMapResult> {
  const resolvedRoot = path.resolve(repoRoot);
  const gitignorePatterns = parseGitignore(resolvedRoot);
  const defaultExcludes = new Set([".git", ".substrate", "node_modules"]);
  const customExcludeMatchers = (options?.excludePatterns ?? []).map((p) =>
    picomatch(p, { dot: true })
  );

  const collectedFiles: string[] = [];
  const maxFiles = options?.maxFiles;
  const maxDepth = options?.maxDepth;

  function walk(currentDir: string, currentDepth: number) {
    if (maxFiles !== undefined && collectedFiles.length >= maxFiles) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (maxFiles !== undefined && collectedFiles.length >= maxFiles) {
        break;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (defaultExcludes.has(entry.name)) continue;
        if (matchesGitignore(relPath, true, gitignorePatterns)) continue;
        if (customExcludeMatchers.some((match) => match(relPath) || match(`${relPath}/`))) continue;

        if (maxDepth !== undefined && currentDepth >= maxDepth) {
          continue;
        }

        walk(fullPath, currentDepth + 1);
      } else if (entry.isFile()) {
        if (entry.name === ".gitignore") continue;
        if (matchesGitignore(relPath, false, gitignorePatterns)) continue;
        if (customExcludeMatchers.some((match) => match(relPath))) continue;
        if (isBinaryFile(fullPath)) continue;

        collectedFiles.push(relPath);
      }
    }
  }

  walk(resolvedRoot, 0);

  collectedFiles.sort();
  let mapText = collectedFiles.join("\n");
  const maxBytes = options?.maxBytes ?? 32 * 1024;
  let truncated = false;
  let byteCount = Buffer.byteLength(mapText, "utf8");

  if (byteCount > maxBytes) {
    truncated = true;
    const notice = "\n[... truncated ...]\n";
    const noticeBytes = Buffer.byteLength(notice, "utf8");
    const cutTarget = Math.max(0, maxBytes - noticeBytes);
    const buf = Buffer.from(mapText, "utf8").subarray(0, cutTarget);
    mapText = buf.toString("utf8") + notice;
    byteCount = Buffer.byteLength(mapText, "utf8");
  }

  return {
    mapText,
    fileCount: collectedFiles.length,
    byteCount,
    truncated,
  };
}
