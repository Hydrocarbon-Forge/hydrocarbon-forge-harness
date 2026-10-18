#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distFile = path.resolve(here, "..", "dist", "substrate.mjs");

if (!fs.existsSync(distFile)) {
  process.stderr.write("substrate: dist/substrate.mjs is missing; run `npm run bundle`\n");
  process.exit(1);
}

await import(pathToFileURL(distFile).href);
