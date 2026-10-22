// The glyphs and words of the job and task states (docs/design/web-ui.md, 4.2). Every state also has a word, so the
// page reads correctly with colour off.

export const RUN_GLYPH = {
  running: "●",
  planned: "◇",
  finished: "+",
  failed: "x",
  stopped: "-",
  interrupted: "-",
  cancelled: "-",
  paused: "!",
};

export const TASK_WORD = {
  PENDING: "queued",
  READY: "ready",
  RUNNING: "running",
  VERIFYING: "verifying",
  PASSED: "passed",
  MERGING: "merging",
  MERGED: "merged",
  FAILED: "failed",
  BLOCKED: "blocked",
  SKIPPED: "skipped",
  ABANDONED: "abandoned",
};

export const TASK_GLYPH = {
  PENDING: "·",
  READY: "·",
  RUNNING: "●",
  VERIFYING: "●",
  PASSED: "✓",
  MERGING: "●",
  MERGED: "✓",
  FAILED: "x",
  BLOCKED: "-",
  SKIPPED: "-",
  ABANDONED: "-",
};
