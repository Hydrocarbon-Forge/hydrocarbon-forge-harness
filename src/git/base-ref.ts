import { execFileSync } from "node:child_process";

/**
 * The base a run is built on. The run's own base is HEAD when the run starts, and
 * that is what the planner is given in its request. A manifest `base_ref` is advisory:
 * it is used only when it names a different commit that resolves, and otherwise the
 * run base is used and a note says why.
 */
export interface ResolvedBase {
  /** The commit the run stubs, integrates and verifies on. */
  sha: string;
  /** Set when the manifest's base_ref was ignored; the text is one line for progress output. */
  note?: string;
}

function gitOut(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function commitOf(repoRoot: string, ref: string): string | undefined {
  // A leading dash would read as an option, so such a ref never resolves.
  if (ref.startsWith("-")) return undefined;
  return gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** Resolve the base for a run in `repoRoot`; `manifestBaseRef` is the planner's advisory value. */
export function resolveBaseRef(repoRoot: string, manifestBaseRef: string | undefined): ResolvedBase {
  const runSha = commitOf(repoRoot, "HEAD");
  if (runSha === undefined) {
    throw new Error("the run base cannot be resolved: HEAD does not point at a commit");
  }
  const ref = manifestBaseRef?.trim() ?? "";
  if (ref === "" || ref === "(none)") return { sha: runSha };

  const branch = gitOut(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (ref === "HEAD" || ref === branch || ref === runSha) return { sha: runSha };

  const sha = commitOf(repoRoot, ref);
  // Unresolvable, or the run base's commit under another name: the run base is used.
  if (sha === undefined || sha === runSha) {
    return { sha: runSha, note: `planner base_ref '${ref}' ignored; using run base ${runSha.slice(0, 7)}` };
  }
  return { sha };
}
