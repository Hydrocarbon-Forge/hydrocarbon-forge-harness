import fs from "node:fs";
import path from "node:path";

/** The run directory under a project: `.substrate/runs/<id>`. */
export function runDirOf(projectDir: string, runId: string): string {
  return path.join(projectDir, ".substrate", "runs", runId);
}

/**
 * The progress log of one run (R10.2): every progress line the text renderer prints, appended
 * line by line to `progress.log` in the run directory, in every output format. It is a side
 * channel: a write failure is swallowed (one warning on stderr) and never fails or slows the run.
 */
export class ProgressLog {
  private warned = false;
  private readonly file: string;

  constructor(
    runDir: string,
    private readonly warn: (message: string) => void,
  ) {
    this.file = path.join(runDir, "progress.log");
  }

  /** Writes the header line that opens a run's log, or a resume's `# resumed` line (R10.2). */
  header(text: string): void {
    this.append(`# ${text}\n`);
  }

  /** Appends text (already newline-terminated lines) and flushes it to the file. */
  append(text: string): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, text, "utf8");
    } catch (err: any) {
      if (!this.warned) {
        this.warned = true;
        this.warn(`warning: progress log ${this.file} is not written: ${err?.message ?? err}\n`);
      }
    }
  }
}

/**
 * Writes a run's outcome (R10.2): `summary.txt` (the summary block the run printed) and
 * `result.json` (the json object `--output-format json` prints). Each file is written under a
 * temporary name and renamed, so a reader never sees half of one. Best effort: never fatal.
 */
export function writeOutcome(runDir: string, summaryText: string, result: unknown): void {
  try {
    fs.mkdirSync(runDir, { recursive: true });
    const files: Array<[string, string]> = [
      ["summary.txt", summaryText],
      ["result.json", JSON.stringify(result) + "\n"],
    ];
    for (const [name, text] of files) {
      const target = path.join(runDir, name);
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, target);
    }
  } catch {
    // Best effort: the run's outcome is already on stdout and in events.jsonl.
  }
}
