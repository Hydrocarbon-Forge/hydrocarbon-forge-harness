// Output that says a verify command's tool is not installed, so the command could not run (R12.2).
// The classifier (src/engine/verify-outcome.ts) reads this list and nothing else. Each marker is an
// exact, case-sensitive substring of the command's output (its stderr or stdout tail). The list is
// kept short on purpose: a marker that also matches a real assertion failure would hide a broken
// build, and a message not listed here is read as a failed check, which is the safe side.

export interface NotInstalledMarker {
  /** The exact text the tool prints when it is missing. */
  marker: string;
  /** Why the check could not run, in the words the run prints after the command. */
  reason: string;
}

export const NOT_INSTALLED_MARKERS: readonly NotInstalledMarker[] = [
  // `npx tsc` with no typescript installed fetches a stub package that prints this (the R12.2 evidence).
  { marker: "This is not the tsc command you are looking for", reason: "tsc is not installed" },
  // npx could not find an executable in the package it fetched for the command.
  { marker: "could not determine executable to run", reason: "the tool has no executable to run" },
  { marker: "npx: command not found", reason: "npx is not installed" },
  { marker: "command not found", reason: "the command is not installed" },
  { marker: "not recognized as an internal or external command", reason: "the command is not installed" },
];
