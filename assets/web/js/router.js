// The URL hash is the place: `#/job/<ref>/<actor>`, where <actor> is planner, engine, integration, repair,
// task/<id> or session/<session id>. A refresh or a shared link opens the same job and actor.

import { actorOfPath, actorPath } from "./store.js";

/** The job and actor a hash names, or null when the hash names no job. An empty actor means the default. */
export function parseHash(hash) {
  const match = /^#\/job\/([^/]+)(?:\/(.*))?$/.exec(hash ?? "");
  if (!match) return null;
  let ref;
  try {
    ref = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const rest = match[2] ?? "";
  return { ref, actor: rest === "" ? null : actorOfPath(rest) };
}

/** The hash of a job and actor. */
export function hashOf(ref, actor) {
  const path = actor ? actorPath(actor) : "";
  const segments = path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`;
  return `#/job/${encodeURIComponent(ref)}${segments}`;
}

/** Writes the hash for the selection. `replace` keeps the browser's history for a change inside one job. */
export function writeHash(ref, actor, replace) {
  const next = hashOf(ref, actor);
  if (window.location.hash === next) return;
  if (replace) window.history.replaceState(null, "", next);
  else window.location.hash = next;
}

/** Calls `select(ref, actor)` when the user moves through history or edits the hash. */
export function listenHash(select) {
  window.addEventListener("hashchange", () => {
    const parsed = parseHash(window.location.hash);
    if (parsed) select(parsed.ref, parsed.actor, { fromHash: true });
  });
}
