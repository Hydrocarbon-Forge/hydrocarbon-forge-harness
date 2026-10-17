#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");

/**
 * Bundles the Substrate CLI entry point into a standalone executable artifact.
 *
 * @param {import("./bundle.js").BundleOptions} [opts]
 * @returns {Promise<import("./bundle.js").BundleResult>}
 */
export async function bundlePackage(opts = {}) {
  const rootDir = defaultRoot;
  const entryPoint = opts.entryPoint
    ? path.resolve(opts.entryPoint)
    : path.join(rootDir, "bin", "substrate.mjs");
  const outfile = opts.outfile
    ? path.resolve(opts.outfile)
    : path.join(rootDir, "dist", "substrate.mjs");
  const target = opts.target ?? "node22";
  const format = opts.format ?? "esm";
  const sourcemap = opts.sourcemap ?? false;
  const minify = opts.minify ?? false;

  const startTime = Date.now();

  // Ensure output directory exists
  const outDir = path.dirname(outfile);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    // Step 1 & 2: esbuild compile targeting Node 22 ESM with external built-ins/packages
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "node",
      target,
      format,
      outfile,
      packages: "external",
      external: ["node:*"],
      sourcemap,
      minify,
    });

    // Step 3: Ensure single executable shebang at top of file
    let content = fs.readFileSync(outfile, "utf8");
    content = content.replace(/^(?:#![^\n]*\n)+/, "");
    content = `#!/usr/bin/env node\n${content}`;
    fs.writeFileSync(outfile, content, "utf8");
    fs.chmodSync(outfile, 0o755);

    // Step 4: Verify output exists, is non-empty, and passes syntax check
    if (!fs.existsSync(outfile)) {
      throw new Error(`Output file not created: ${outfile}`);
    }

    const stat = fs.statSync(outfile);
    if (stat.size === 0) {
      if (fs.existsSync(outfile)) fs.unlinkSync(outfile);
      throw new Error(`Output file is empty: ${outfile}`);
    }

    const syntaxCheck = spawnSync(process.execPath, ["--check", outfile], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (syntaxCheck.status !== 0) {
      if (fs.existsSync(outfile)) fs.unlinkSync(outfile);
      throw new Error(`Bundle output failed syntax check:\n${syntaxCheck.stderr || syntaxCheck.stdout}`);
    }

    const durationMs = Date.now() - startTime;
    return {
      outfile,
      bytes: stat.size,
      durationMs,
    };
  } catch (err) {
    // If output file exists after error, clean it up
    if (fs.existsSync(outfile)) {
      try {
        fs.unlinkSync(outfile);
      } catch {}
    }
    throw err;
  }
}

// CLI runner execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const res = await bundlePackage();
    console.log(`Bundled ${res.outfile} (${(res.bytes / 1024).toFixed(1)} kB) in ${res.durationMs}ms`);
    process.exit(0);
  } catch (err) {
    console.error(`Bundle failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
