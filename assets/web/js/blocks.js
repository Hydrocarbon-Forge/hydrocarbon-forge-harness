// Blocks shared by the transcript and the task view: a foldable text block, a diff with red and green gutters, and a
// verify result with its exit status. Each block is built from DOM nodes and textContent only.

import { el, fmtDuration } from "./util.js";

const FOLD_LINES = 6;
const FOLD_CHARS = 400;
const PREVIEW_LINES = 2;
const DIFF_ROWS = 40;

/** Long text folds to its first lines with a toggle; short text is shown whole. */
export function foldText(text, { className = "fold-body", maxLines = FOLD_LINES, maxChars = FOLD_CHARS } = {}) {
  const value = String(text ?? "");
  const lines = value.split("\n");
  const long = lines.length > maxLines || value.length > maxChars;
  const body = el("pre", { class: className });
  const block = el("div", { class: "fold" }, body);
  if (!long) {
    body.textContent = value;
    return block;
  }
  const preview = lines.slice(0, PREVIEW_LINES).join("\n").slice(0, maxChars);
  body.textContent = preview;
  let expanded = false;
  const toggle = el("button", {
    type: "button",
    class: "fold-toggle",
    data: { foldToggle: "" },
    text: `show all ${lines.length} lines (ctrl+o)`,
    on: {
      click: () => {
        expanded = !expanded;
        body.textContent = expanded ? value : preview;
        toggle.textContent = expanded ? "collapse" : `show all ${lines.length} lines (ctrl+o)`;
        if (!expanded) block.classList.remove("expanded");
        else block.classList.add("expanded");
      },
    },
  });
  block.append(toggle);
  return block;
}

/** Expands every fold under a node (the `e` key). */
export function expandFolds(root) {
  for (const toggle of root.querySelectorAll("[data-fold-toggle]")) {
    if (toggle.textContent.startsWith("show")) toggle.click();
  }
}

/** A unified diff: the file, the added and removed counts, one row per line with a red or green gutter. */
export function diffBlock(patch, { maxRows = DIFF_ROWS } = {}) {
  const text = String(patch ?? "");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let file = "";
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (file === "" && line.startsWith("diff --git ")) file = (line.split(" b/")[1] ?? line.slice(11)).trim();
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }

  const rows = el("div", { class: "diff-rows" });
  const rowOf = (line) => {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file") || line.startsWith("deleted file")) {
      return el("div", { class: "dl meta" }, el("span", { class: "gut", text: " " }), el("span", { class: "txt", text: line }));
    }
    if (line.startsWith("@@")) {
      return el("div", { class: "dl hunk" }, el("span", { class: "gut", text: " " }), el("span", { class: "txt", text: line }));
    }
    if (line.startsWith("+")) {
      return el("div", { class: "dl add" }, el("span", { class: "gut", text: "+" }), el("span", { class: "txt", text: line.slice(1) }));
    }
    if (line.startsWith("-")) {
      return el("div", { class: "dl del" }, el("span", { class: "gut", text: "-" }), el("span", { class: "txt", text: line.slice(1) }));
    }
    return el("div", { class: "dl ctx" }, el("span", { class: "gut", text: " " }), el("span", { class: "txt", text: line.startsWith(" ") ? line.slice(1) : line }));
  };
  const shown = lines.slice(0, maxRows);
  for (const line of shown) rows.append(rowOf(line));
  const block = el(
    "section",
    { class: "diff", "aria-label": `diff of ${file || "a file"}` },
    el(
      "header",
      { class: "diff-head" },
      el("span", { class: "file", text: file || "patch" }),
      el("span", { class: "counts" }, el("span", { class: "plus", text: `+${added}` }), " ", el("span", { class: "minus", text: `-${removed}` })),
    ),
    rows,
  );
  if (lines.length > maxRows) {
    const rest = lines.slice(maxRows);
    const more = el("button", {
      type: "button",
      class: "fold-toggle",
      data: { foldToggle: "" },
      text: `show ${rest.length} more lines`,
      on: {
        click: () => {
          for (const line of rest) rows.append(rowOf(line));
          more.remove();
        },
      },
    });
    block.append(more);
  }
  return block;
}

/** A verify command's result: the command, its exit status, its output tails and a link to the full output. */
export function verifyBlock(result, { loadFull } = {}) {
  let badge;
  if (result.timed_out) badge = el("span", { class: "badge warn", text: "timed out" });
  else if (result.exit_code === null || result.exit_code === undefined) badge = el("span", { class: "badge warn", text: "no exit code" });
  else if (result.exit_code === 0) badge = el("span", { class: "badge ok", text: "exit 0" });
  else badge = el("span", { class: "badge err", text: `exit ${result.exit_code}` });

  const head = el(
    "header",
    { class: "verify-head" },
    el("code", { class: "cmd", text: `$ ${result.cmd ?? ""}` }),
    badge,
    el("span", { class: "dim", text: fmtDuration(result.duration_ms ?? 0) }),
  );
  const parts = [head];
  if (result.stdout_tail) parts.push(el("pre", { class: "out", data: { stream: "stdout" }, text: result.stdout_tail }));
  if (result.stderr_tail) parts.push(el("pre", { class: "out err-stream", data: { stream: "stderr" }, text: result.stderr_tail }));
  if (result.truncated) parts.push(el("p", { class: "dim", text: "Output truncated; the full output is linked below." }));
  if (result.full_output && loadFull) {
    const slot = el("div", { class: "full-slot" });
    const button = el("button", {
      type: "button",
      class: "ghost small",
      text: "show full output",
      on: {
        click: async () => {
          button.disabled = true;
          button.textContent = "loading...";
          try {
            const text = await loadFull(result.full_output.key);
            slot.replaceChildren(el("pre", { class: "out full", text: text || "(empty)" }));
          } catch (err) {
            button.disabled = false;
            button.textContent = "could not load the full output; retry";
          }
        },
      },
    });
    slot.append(button);
    parts.push(slot);
  }
  return el("section", { class: `verify ${result.timed_out ? "timed" : result.exit_code === 0 ? "pass" : "fail"}` }, ...parts);
}
