// A small Markdown renderer for assistant text and report files. It understands fenced code, headings, lists and
// paragraphs, with `code` and **bold** inside a line. It builds DOM nodes from the text: there is no HTML pass-through,
// so a model's markup is shown as plain text.

import { el } from "./util.js";

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;

function inline(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) nodes.push(el("code", { text: match[1] }));
    else nodes.push(el("strong", { text: match[2] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const FENCE = /^```\s*(\S*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const ITEM = /^\s*([-*]|\d+\.)\s+(.*)$/;

/** A block of Markdown text as an element. */
export function markdown(text) {
  const root = el("div", { class: "md" });
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      root.append(el("pre", { class: "code", data: { lang: fence[1] || "text" }, text: code.join("\n") }));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      root.append(el("div", { class: `md-h md-h${heading[1].length}` }, inline(heading[2])));
      i += 1;
      continue;
    }
    if (ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = el(ordered ? "ol" : "ul", { class: "md-list" });
      while (i < lines.length && ITEM.test(lines[i])) {
        list.append(el("li", null, inline(ITEM.exec(lines[i])[2])));
        i += 1;
      }
      root.append(list);
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !ITEM.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    root.append(el("p", null, inline(para.join("\n"))));
  }
  return root;
}
