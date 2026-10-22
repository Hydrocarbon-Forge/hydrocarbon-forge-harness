// Small DOM and formatting helpers. The client never uses innerHTML: every value from the API goes in through
// text nodes, so a transcript that contains markup is shown as text.

/**
 * Builds an element. Props: `class`, `text` (textContent), `on` (event listeners), `data` (dataset), `attrs`
 * (attributes); any other prop is an attribute (true sets it without a value). Children may be strings, nodes,
 * arrays or null/false (skipped).
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "on") for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
    else if (key === "data") for (const [k, v] of Object.entries(value)) node.dataset[k] = String(v);
    else if (key === "attrs") for (const [k, v] of Object.entries(value)) node.setAttribute(k, String(v));
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
}

/** 42s, 12m 04s, 1h 03m. */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "5m ago", "3h ago", "2d ago". */
export function fmtAgo(iso, now = Date.now()) {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Local clock time of an ISO string, 24-hour, with seconds. */
export function fmtClock(iso) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour12: false });
}

/** Cost of a usage object. An unknown price is never shown as $0 (DECISIONS A7). */
export function fmtCost(usage) {
  if (!usage) return "-";
  if (usage.cost_source === "unknown") return "unknown";
  const cost = Number(usage.cost_usd) || 0;
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** 950, 12.4k, 3.1M. */
export function fmtCount(n) {
  const value = Number(n) || 0;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

export function errorMessage(err) {
  return err && typeof err.message === "string" ? err.message : String(err);
}

/** localStorage with every access wrapped: a private window or blocked storage just means no remembered value. */
export function storeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storeSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the page works without it.
  }
}

/** Whether a scrolling element is within `slack` pixels of its bottom. */
export function atBottom(scroller, slack = 48) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= slack;
}
