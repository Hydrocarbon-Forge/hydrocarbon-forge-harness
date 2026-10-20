#!/usr/bin/env node
/*
 * Gate G5: every installed harness has a live pass at its current version pin.
 *
 * Latest record wins. For each installed harness, every record with that `harness` is
 * taken, whatever its `version` and status, ordered by `ts` (equal `ts` keeps file order).
 * The last one decides:
 * - none: problem "no passed record at version pin <pin>".
 * - `skipped`: problem "latest live record is skipped", so `npm test` run after a live pass
 *   makes the gate fail until `npm run test:live` runs again.
 * - `failed`: problem "latest record ... is failed".
 * - `passed` at a version other than the pin: problem "no passed record at version pin".
 * - `passed` at the pin: OK.
 * Why this reading of "any skipped record": the record file is append-only and a plain
 * `npm test` appends skipped rows, so "any skipped record ever" would make the gate
 * unpassable for good. Only the latest record can say the harness is untested now.
 * Records for harnesses that are not installed are ignored, skipped ones included.
 *
 * Other rules:
 * - Installed and pin come from the built CLI, `backends --output-format json`. It runs
 *   each harness's `--version` and reads the pin from the adapter. No model call is made.
 *   A harness whose installed field is "not installed" is not installed and is not checked.
 *   `--status <file.json>` replaces that call with `[{harness, installed, version, pin}]`.
 * - No installed harness: prints `no installed harness; nothing recorded` and exits 1.
 * - The table shows, per installed harness, the best record at the pin: the latest passed
 *   one, else the latest at the pin. If the latest record is skipped, the row shows it with
 *   result "skipped". A missing record shows "-" and result "missing".
 * - Exit 0 only when every installed harness has a passing record. Exit 1 on problems.
 *   Exit 2 on an internal error, including a malformed record or status file.
 * - The gate only reads `<root>/.substrate/ledger/live-smoke.json`. It never writes or
 *   creates it; only the live test writes records.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");
const cliPath = path.resolve(here, "..", "dist", "substrate.mjs");
const RECORD_REL = path.join(".substrate", "ledger", "live-smoke.json");
const STATUSES = ["passed", "failed", "skipped"];
const NO_INSTALLED = "no installed harness; nothing recorded";

class InternalError extends Error {}

function parseArgs(argv) {
  const opts = { root: defaultRoot, status: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--root" || arg === "--status") && i + 1 < argv.length) {
      if (arg === "--root") opts.root = path.resolve(argv[++i]);
      else opts.status = path.resolve(argv[++i]);
    } else {
      throw new InternalError(`unknown or incomplete argument '${arg}'`);
    }
  }
  return opts;
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new InternalError(`cannot read ${what} ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InternalError(`${what} ${file} is not valid JSON: ${err.message}`);
  }
}

/** Validates one record; throws InternalError naming the file and index on a bad shape. */
function checkRecord(r, i, file) {
  const where = `${file}: record ${i}`;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    throw new InternalError(`${where} is not an object`);
  }
  for (const key of ["harness", "version", "model", "run_id", "ts"]) {
    if (typeof r[key] !== "string") throw new InternalError(`${where} field '${key}' must be a string`);
  }
  if (!STATUSES.includes(r.status)) {
    throw new InternalError(`${where} field 'status' must be one of ${STATUSES.join(", ")}`);
  }
  for (const key of ["exit_code", "cost_usd"]) {
    if (r[key] !== null && typeof r[key] !== "number") {
      throw new InternalError(`${where} field '${key}' must be a number or null`);
    }
  }
  if (Number.isNaN(Date.parse(r.ts))) throw new InternalError(`${where} field 'ts' is not a date`);
}

/** Reads the record file. A missing file means no records. Never writes. */
function loadRecords(root) {
  const file = path.join(root, RECORD_REL);
  if (!fs.existsSync(file)) return [];
  const data = readJson(file, "record file");
  if (!Array.isArray(data)) throw new InternalError(`record file ${file} must hold a JSON array`);
  data.forEach((r, i) => checkRecord(r, i, file));
  return data;
}

/** Reads the `--status` override: [{harness, installed, version, pin}]. */
function loadStatusFile(file) {
  const data = readJson(file, "status file");
  if (!Array.isArray(data)) throw new InternalError(`status file ${file} must hold a JSON array`);
  return data.map((s, i) => {
    if (!s || typeof s !== "object" || typeof s.harness !== "string" || typeof s.installed !== "boolean") {
      throw new InternalError(`status file ${file}: entry ${i} needs harness (string) and installed (boolean)`);
    }
    return {
      harness: s.harness,
      installed: s.installed,
      version: typeof s.version === "string" ? s.version : null,
      pin: typeof s.pin === "string" ? s.pin : null,
    };
  });
}

/** Asks the built CLI for installed versions and pins. No model call is made. */
function discoverStatus(root) {
  let out;
  try {
    out = execFileSync(process.execPath, [cliPath, "backends", "--output-format", "json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch (err) {
    throw new InternalError(`'backends' command failed: ${err.message.split("\n")[0]}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new InternalError(`'backends' printed invalid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.backends)) {
    throw new InternalError(`'backends' JSON has no backends array`);
  }
  return parsed.backends.map((b) => {
    const installed = typeof b.installed === "string" && b.installed !== "not installed";
    return {
      harness: b.name,
      installed,
      version: installed ? b.installed : null,
      pin: typeof b.pin === "string" && b.pin !== "-" ? b.pin : null,
    };
  });
}

function byTs(a, b) {
  return Date.parse(a.ts) - Date.parse(b.ts); // stable: equal ts keeps file order
}

function formatCost(cost) {
  return typeof cost === "number" ? `$${cost.toFixed(4)}` : "-";
}

/** Evaluates each installed harness. Returns problem lines and table rows. */
function evaluate(statusRows, records) {
  const problems = [];
  const rows = [];
  const installed = statusRows
    .filter((s) => s.installed)
    .sort((a, b) => (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0));

  for (const s of installed) {
    if (s.pin === null) {
      problems.push(`GATE ${s.harness} has no version pin configured`);
      rows.push({ harness: s.harness, version: s.version, model: "-", run: "-", cost: "-", result: "missing" });
      continue;
    }
    const own = records.filter((r) => r.harness === s.harness).sort(byTs);
    const latest = own[own.length - 1];
    const atPin = own.filter((r) => r.version === s.pin);
    const passed = atPin.filter((r) => r.status === "passed");
    const best = passed[passed.length - 1] ?? atPin[atPin.length - 1];
    const missing = { harness: s.harness, version: s.version ?? s.pin, model: "-", run: "-", cost: "-", result: "missing" };
    const noPass = `GATE ${s.harness} no passed record at version pin ${s.pin}`;

    if (!latest) {
      problems.push(noPass);
      rows.push(missing);
      continue;
    }
    if (latest.status === "skipped") {
      problems.push(`GATE ${s.harness} latest live record is skipped (${latest.ts}): run npm run test:live`);
      rows.push({
        harness: s.harness,
        version: s.version ?? s.pin,
        model: latest.model,
        run: latest.run_id,
        cost: "-",
        result: "skipped",
      });
      continue;
    }
    if (latest.status === "failed") {
      if (passed.length === 0) problems.push(noPass);
      problems.push(`GATE ${s.harness} latest record at version pin ${s.pin} is failed (run ${latest.run_id}, ${latest.ts})`);
    } else if (latest.version !== s.pin) {
      problems.push(noPass);
    }

    rows.push(
      best
        ? {
            harness: s.harness,
            version: s.version ?? s.pin,
            model: best.model,
            run: best.run_id,
            cost: formatCost(best.cost_usd),
            result: best.status,
          }
        : missing
    );
  }
  return { problems, rows };
}

function renderTable(rows) {
  const header = { harness: "harness", version: "version", model: "model", run: "run id", cost: "cost", result: "result" };
  const keys = ["harness", "version", "model", "run", "cost", "result"];
  const all = [header, ...rows];
  const widths = keys.map((k) => Math.max(...all.map((r) => String(r[k]).length)));
  const line = (r) => keys.map((k, i) => String(r[k]).padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const statusRows = opts.status ? loadStatusFile(opts.status) : discoverStatus(opts.root);
  const records = loadRecords(opts.root);

  if (!statusRows.some((s) => s.installed)) {
    console.log(NO_INSTALLED);
    return 1;
  }

  const { problems, rows } = evaluate(statusRows, records);
  for (const p of problems) console.log(p);
  console.log(renderTable(rows));
  if (problems.length === 0) {
    console.log("OK");
    return 0;
  }
  console.log(`FAIL: ${problems.length} problem(s)`);
  return 1;
}

try {
  process.exit(main());
} catch (err) {
  const message = err instanceof InternalError ? err.message : err instanceof Error ? err.stack : String(err);
  console.error(`gate-g5 internal error: ${message}`);
  process.exit(2);
}
