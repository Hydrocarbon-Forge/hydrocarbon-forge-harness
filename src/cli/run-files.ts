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

/** Writes one file of a run directory under a temporary name, then renames it, so a reader never sees half of it. */
function writeWhole(runDir: string, name: string, text: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  const target = path.join(runDir, name);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, target);
}

/**
 * Writes a run's outcome (R10.2): `summary.txt` (the summary block the run printed) and
 * `result.json` (the json object `--output-format json` prints), and, when given, `REPORT.md` (P2.2).
 * Best effort: never fatal.
 */
export function writeOutcome(runDir: string, summaryText: string, result: unknown, reportMarkdown?: string): void {
  try {
    writeWhole(runDir, "summary.txt", summaryText);
    writeWhole(runDir, "result.json", JSON.stringify(result) + "\n");
    if (reportMarkdown !== undefined) writeWhole(runDir, "REPORT.md", reportMarkdown);
  } catch {
    // Best effort: the run's outcome is already on stdout and in events.jsonl.
  }
}

/** Writes `REPORT.md` alone (P2.2): the path a run takes when it ends without a summary (an interrupt, a crash while finishing). Best effort. */
export function writeReportMarkdown(runDir: string, reportMarkdown: string): void {
  try {
    writeWhole(runDir, "REPORT.md", reportMarkdown);
  } catch {
    // Best effort: the event log is the run's record.
  }
}
