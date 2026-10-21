// The binary a verify command runs, for lint rule L011 (R11.1, known issue 24b).
//
// A verify command is a shell line. Its first command word is the binary the rule checks. Leading
// `NAME=value` assignments are skipped (their values may hold quotes, `$(...)`, backticks or spaces).
// Wrappers (`sh -c`, `bash -c`, `env`, `timeout`, `npx`, `node -e`, ...) are checked as themselves: the
// quoted script after them is never parsed. Command substitutions, redirections, pipes, chains and
// subshells are not modelled beyond the first command word. When the first command word is not a plain
// token (letters, digits, `_`, `-`, `.`, `/`), or the line has a construct the scan does not model, the
// result is undefined and the rule does not fire: when unsure, the rule stays quiet.

/** Shell builtins and keywords: a command word with one of these names is never a missing binary. */
export const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  ":", "[", "]", "alias", "bg", "break", "builtin", "case", "cd", "command", "continue", "declare", "dirs",
  "do", "done", "echo", "elif", "else", "enable", "esac", "eval", "exec", "exit", "export", "false", "fi",
  "fg", "for", "function", "getopts", "hash", "if", "in", "jobs", "let", "local", "popd", "printf", "pushd",
  "pwd", "read", "readonly", "return", "select", "set", "shift", "source", "test", "then", "time", "times",
  "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while", ".",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN_WORD = /^[A-Za-z0-9_./-]+$/;
const OPERATORS = "\n;&|()<>";

/** Index of the `)` that closes the `(` at `open`, or -1 when it does not close or holds a quote. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === "`") return -1;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the `"` that closes the double quote opened at `open`, or -1 when it does not close. */
function closingDouble(s: string, open: number): number {
  for (let j = open + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
    } else if (c === '"') {
      return j;
    } else if (c === "$" && s[j + 1] === "(") {
      const end = closingParen(s, j + 1);
      if (end < 0) return -1;
      j = end;
    } else if (c === "`") {
      const end = s.indexOf("`", j + 1);
      if (end < 0) return -1;
      j = end;
    }
  }
  return -1;
}

/**
 * The binary a verify command runs: its first command word after any leading assignments, or
 * undefined when the line does not start with a plain command word (a subshell, a chain whose first
 * command is an assignment, a substitution or a quoted word) or the scan meets an unmodelled construct.
 */
export function verifyBinaryOf(run: string): string | undefined {
  const s = run.trim();
  const n = s.length;
  let i = 0;
  for (;;) {
    while (i < n && (s[i] === " " || s[i] === "\t")) i++;
    if (i >= n) return undefined;
    let word = "";
    let compound = false;
    while (i < n) {
      const c = s[i];
      if (c === " " || c === "\t" || OPERATORS.includes(c)) break;
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) return undefined;
        compound = true;
        word += s.slice(i, end + 1);
        i = end + 1;
      } else if (c === '"') {
        const end = closingDouble(s, i);
        if (end < 0) return undefined;
        compound = true;
        word += s.slice(i, end + 1);
        i = end + 1;
      } else if (c === "`") {
        const end = s.indexOf("`", i + 1);
        if (end < 0) return undefined;
        compound = true;
        word += s.slice(i, end + 1);
        i = end + 1;
      } else if (c === "$" && s[i + 1] === "(") {
        const end = closingParen(s, i + 1);
        if (end < 0) return undefined;
        compound = true;
        word += s.slice(i, end + 1);
        i = end + 1;
      } else if (c === "\\") {
        compound = true;
        word += s.slice(i, i + 2);
        i += 2;
      } else {
        word += c;
        i++;
      }
    }
    if (word === "") return undefined; // an operator where a command word should be
    if (ASSIGNMENT.test(word)) continue; // NAME=value before the command: skip it
    if (compound || !PLAIN_WORD.test(word)) return undefined;
    return word;
  }
}
