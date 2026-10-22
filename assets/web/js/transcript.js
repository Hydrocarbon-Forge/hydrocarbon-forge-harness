// The transcript in Claude Code style: assistant text with a bullet, tool calls as `● Name(arg)`, results under a `⎿`
// connector, denials and errors in their own colours, and a summary line when a session ends. A Feed draws a list of
// items and keeps it cheap for a long run: it appends new items, shows only the last WINDOW of them, and leaves the
// scroll position alone unless the reader is at the bottom.

import { foldText } from "./blocks.js";
import { markdown } from "./md.js";
import { atBottom, el, fmtClock, fmtCount, fmtDuration, truncate } from "./util.js";

const WINDOW = 300;

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** One transcript item as a DOM node. Every value is set as text. */
export function renderItem(item) {
  switch (item.kind) {
    case "divider":
      return el("div", { class: "divider", role: "separator" }, el("span", { text: item.text }));
    case "meta":
      return el("div", { class: "meta-line", text: item.text });
    case "text":
      return el(
        "div",
        { class: "entry text", title: fmtClock(item.ts) },
        el("span", { class: "bullet", "aria-hidden": "true", text: "●" }),
        el("div", { class: "entry-body" }, markdown(item.text)),
      );
    case "tool":
      return el(
        "div",
        { class: "entry tool" },
        el("span", { class: "bullet", "aria-hidden": "true", text: "●" }),
        el(
          "span",
          { class: "tool-line" },
          el("span", { class: "tool-name", text: item.name }),
          "(",
          el("span", { class: "tool-arg", text: truncate(item.arg, 240), title: item.arg }),
          ")",
        ),
      );
    case "result":
      return el(
        "div",
        { class: item.ok ? "result" : "result bad" },
        el("span", { class: "conn", "aria-hidden": "true", text: "⎿" }),
        foldText(item.text, { className: "result-body" }),
      );
    case "denied":
      return el("div", { class: "entry denied" }, `⊘ permission denied: ${item.tool}${item.reason ? ` (${item.reason})` : ""}`);
    case "error":
      return el("div", { class: "entry error" }, `✖ error (${item.errorKind}): ${item.text}`);
    case "subagent":
      return el(
        "div",
        { class: "entry subagent" },
        el("span", { class: "bullet", "aria-hidden": "true", text: "●" }),
        " subagent",
        foldText(JSON.stringify(item.raw, null, 2), { className: "result-body" }),
      );
    case "done": {
      const seconds = item.durationMs === null ? "" : ` · ${fmtDuration(item.durationMs)}`;
      const summary = item.ok
        ? `Done (${item.tools} tool ${plural(item.tools, "call", "calls")} · ${fmtCount(item.tokensIn)} in / ${fmtCount(item.tokensOut)} out tokens${seconds})`
        : `Failed (exit ${item.exitCode ?? "?"}${seconds})`;
      const nodes = [el("div", { class: item.ok ? "done" : "done bad", text: summary })];
      if (!item.ok && item.finalText) nodes.push(el("div", { class: "entry error" }, foldText(item.finalText, { className: "result-body" })));
      return el("div", { class: "done-block" }, ...nodes);
    }
    default:
      return el("div", { class: "meta-line", hidden: true });
  }
}

/**
 * A list of items drawn into `container`, inside `scroller`. `getItems()` returns the whole list; the feed draws its
 * tail. `more` is the "Load earlier" control; `onPending(n)` reports how many items arrived while the reader was not
 * at the bottom.
 */
export class Feed {
  constructor({ scroller, container, more, getItems, render, onPending }) {
    this.scroller = scroller;
    this.container = container;
    this.more = more;
    this.getItems = getItems;
    this.render = render;
    this.onPending = onPending ?? (() => {});
    this.windowSize = WINDOW;
    this.start = 0;
    this.drawn = 0;
    this.pending = 0;
  }

  /** Draws the tail of the list from scratch and scrolls to the end. */
  reset() {
    const items = this.getItems();
    this.drawn = items.length;
    this.start = Math.max(0, items.length - this.windowSize);
    this.paint(items);
    this.pending = 0;
    this.onPending(0);
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  paint(items) {
    const frag = document.createDocumentFragment();
    for (let i = this.start; i < this.drawn; i += 1) frag.append(this.render(items[i]));
    this.container.replaceChildren(frag);
    this.updateMore();
  }

  updateMore() {
    this.more.hidden = this.start === 0;
    this.more.textContent = `Load earlier (${this.start} more)`;
  }

  /** Draws what arrived since the last call. Keeps the reader's place unless they were at the bottom. */
  sync() {
    const items = this.getItems();
    if (items.length < this.drawn) {
      this.reset();
      return;
    }
    if (items.length === this.drawn) return;
    const follow = atBottom(this.scroller);
    const frag = document.createDocumentFragment();
    for (let i = this.drawn; i < items.length; i += 1) frag.append(this.render(items[i]));
    const added = items.length - this.drawn;
    this.drawn = items.length;
    this.container.append(frag);
    while (this.container.childElementCount > this.windowSize) {
      this.container.firstElementChild.remove();
      this.start += 1;
    }
    this.updateMore();
    if (follow) {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.pending = 0;
      this.onPending(0);
    } else {
      this.pending += added;
      this.onPending(this.pending);
    }
  }

  /** Shows WINDOW more items above the current ones, keeping the reader at the same place. */
  loadEarlier() {
    const before = this.scroller.scrollHeight;
    this.windowSize += WINDOW;
    const items = this.getItems();
    this.start = Math.max(0, this.drawn - this.windowSize);
    this.paint(items);
    this.scroller.scrollTop += this.scroller.scrollHeight - before;
  }

  /** The reader scrolled: at the bottom, the pending count is read. */
  noteScroll() {
    if (this.pending > 0 && atBottom(this.scroller)) {
      this.pending = 0;
      this.onPending(0);
    }
  }
}
