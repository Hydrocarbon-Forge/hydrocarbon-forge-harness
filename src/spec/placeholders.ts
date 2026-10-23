// Placeholder detection for the Interface and Behavior sections of a task spec (rule L013).
//
// This is a warning, never an error: the parser does not throw on it and the plan is not refused
// because of it (DECISIONS, R12.3). The same function serves the parser and the lint rule, so both
// agree on what counts as a placeholder.

export interface PlaceholderFinding {
  token: string;
  /** The offending line, trimmed and cut to 80 characters, for the warning text. */
  text: string;
}

/** Real markers: an uppercase TODO, FIXME or TBD as a whole word. Lowercase prose ("todo list") is not a marker. */
const MARKER_RE = /(?<![A-Za-z0-9_])(TODO|FIXME|TBD)(?![A-Za-z0-9_])/;
/** An angle-bracket placeholder token. */
const ANGLE_RE = /<placeholder>/i;
/** A literal "etc..." (or "etc…") stub. */
const ETC_RE = /\betc(?:\.{3}|…)/i;
/** An ellipsis that is the whole content of a line or bullet: a stub, not a sentence. */
const ELLIPSIS_LINE_RE = /^(?:(?:[-*+]|\d+[.)])\s+)?(?:\.{3}|…)$/;

/**
 * Finds placeholder tokens in the prose of one section. Fenced code blocks and inline code spans are
 * ignored. A bare ellipsis inside a sentence, or call shorthand such as `f(..., {x: 1})`, is not a
 * placeholder; an ellipsis counts only as the whole content of a line or bullet, or as "etc...".
 */
export function findPlaceholders(sectionText: string): PlaceholderFinding[] {
  const prose = sectionText
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const findings: PlaceholderFinding[] = [];

  for (const rawLine of prose.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const shown = line.length > 80 ? `${line.slice(0, 77)}...` : line;

    const marker = line.match(MARKER_RE);
    if (marker) {
      findings.push({ token: marker[1], text: shown });
      continue;
    }
    if (ANGLE_RE.test(line)) {
      findings.push({ token: "<placeholder>", text: shown });
      continue;
    }
    if (ELLIPSIS_LINE_RE.test(line)) {
      findings.push({ token: "...", text: shown });
      continue;
    }
    if (ETC_RE.test(line)) {
      findings.push({ token: "etc...", text: shown });
    }
  }

  return findings;
}
