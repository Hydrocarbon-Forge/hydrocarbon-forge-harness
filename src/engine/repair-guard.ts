import { execFileSync } from "node:child_process";

// The anti-cheat rules for a repair attempt of a failed final check (R12.4). A repair worker must not
// make the check pass by loosening it. The guard reads what the attempt's commit changed, against the
// integration HEAD the attempt started from, and rejects the attempt when it does one of these:
//   (i) changes nothing; (ii) deletes or renames away a test file; (iii) adds a skip or ignore marker;
//   (iv) touches anything under .substrate/ (the run's records and the manifest).
// A worker could still edit a script that the check invokes; that known limit is documented, not solved.

/** One changed path of the attempt's diff, as git reports it (`git diff --name-status -M`). */
export interface RepairChange {
  /** The first letter of git's status: A, M, D, R, C, T and so on. */
  status: string;
  path: string;
  /** For a rename or copy: the path it came from. */
  from?: string;
}

/** The attempt's diff: what changed, and the lines it added, per file. */
export interface RepairDiff {
  changes: RepairChange[];
  added: { path: string; text: string }[];
}

export type RepairVerdict = { ok: true } | { ok: false; reason: string };

/** Path segments and file names that make a path a test file (rule ii). */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec"]);
const TEST_NAME_PATTERNS: readonly RegExp[] = [/\.test\./, /\.spec\./, /_test\./, /^test_/];

/** True when the path is a test file by the rule's table: a test directory, or a test file name. */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((segment) => TEST_DIRS.has(segment))) return true;
  return TEST_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * The skip and ignore markers (rule iii), one table: each marker names itself in the verdict. `.only(` is
 * not a skip and is not listed. The bare words are matched whole, so `process.exit(` is not an `xit(`. The
 * more specific markers come first, so `pytest.skip(` is named as itself, not as the `.skip(` it contains.
 */
export const SKIP_MARKERS: readonly { name: string; pattern: RegExp }[] = [
  { name: "pytest.mark.skip", pattern: /pytest\.mark\.skip\b/ },
  { name: "pytest.skip(", pattern: /pytest\.skip\(/ },
  { name: "unittest.skip", pattern: /unittest\.skip\b/ },
  { name: "xdescribe(", pattern: /\bxdescribe\(/ },
  { name: "xit(", pattern: /\bxit\(/ },
  { name: "it.todo", pattern: /\bit\.todo\b/ },
  { name: "test.todo", pattern: /\btest\.todo\b/ },
  { name: "@Ignore", pattern: /@Ignore\b/ },
  { name: "@Disabled", pattern: /@Disabled\b/ },
  { name: "t.Skip(", pattern: /\bt\.Skip\(/ },
  { name: "#[ignore]", pattern: /#\[ignore\]/ },
  { name: "skipIf", pattern: /\bskipIf\b/ },
  { name: ".skip(", pattern: /\.skip\(/ },
];

/** The rules, in the order they are checked. The first that fails gives the reason. */
export function checkRepairDiff(diff: RepairDiff): RepairVerdict {
  // (i) An attempt that changed nothing is not a repair.
  if (diff.changes.length === 0) {
    return { ok: false, reason: "the repair changed nothing" };
  }

  // (iv) The run's own records and the manifest are not the repair's to touch.
  const substrate = diff.changes.find((c) => c.path.startsWith(".substrate/") || c.from?.startsWith(".substrate/"));
  if (substrate !== undefined) {
    return { ok: false, reason: `it changes ${substrate.path} under .substrate/` };
  }

  // (ii) A test file that is deleted or renamed away (its old path) is a loosened check.
  for (const change of diff.changes) {
    if (change.status === "D" && isTestPath(change.path)) {
      return { ok: false, reason: `it deletes test file ${change.path}` };
    }
    if (change.status === "R" && change.from !== undefined && isTestPath(change.from)) {
      return { ok: false, reason: `it renames away test file ${change.from}` };
    }
  }

  // (iii) An added skip or ignore marker switches a check off.
  for (const line of diff.added) {
    const marker = SKIP_MARKERS.find((m) => m.pattern.test(line.text));
    if (marker !== undefined) {
      return { ok: false, reason: `it adds a skip marker (${marker.name}) in ${line.path}` };
    }
  }

  return { ok: true };
}

/**
 * The attempt's diff, read from git: the changed paths between base and head, and the lines added in each
 * file. Rename detection is on, so a moved test file shows as a rename, not as an add and a delete.
 */
export function readRepairDiff(worktreePath: string, base: string, head: string): RepairDiff {
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const changes: RepairChange[] = [];
  for (const line of git(["diff", "--name-status", "-M", "--no-ext-diff", base, head]).split("\n")) {
    if (line.trim() === "") continue;
    const cols = line.split("\t");
    const status = cols[0].charAt(0);
    if (status === "R" || status === "C") {
      changes.push({ status, from: cols[1], path: cols[2] });
    } else {
      changes.push({ status, path: cols[1] });
    }
  }

  const added: { path: string; text: string }[] = [];
  let current: string | undefined;
  for (const line of git(["diff", "-U0", "--no-color", "--no-ext-diff", "-M", base, head]).split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      current = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("+") && current !== undefined) {
      added.push({ path: current, text: line.slice(1) });
    }
  }
  return { changes, added };
}
