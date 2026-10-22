// The two Server-Sent Event streams (docs/design/web-ui.md, 5.2): the service stream (`run`, `project`) and one job's
// stream (`engine`, `transcript`, `chat`, `state`). The browser reconnects a stream on its own and resends
// Last-Event-ID; a stream the browser gave up on (the server answered with an error) is reopened here with backoff.
// A job stream of a job that is not live is closed, because the server ends it after a quiet spell anyway.

import { streamUrls } from "./api.js";

function parse(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return undefined;
  }
}

/** Opens the service stream. Returns a function that closes it. */
export function openGlobalStream({ onOpen, onRun, onProject, onDown }) {
  let source = null;
  let closed = false;
  let attempt = 0;
  let timer = null;

  const connect = () => {
    if (closed) return;
    source = new EventSource(streamUrls.global());
    source.addEventListener("open", () => {
      attempt = 0;
      onOpen();
    });
    source.addEventListener("run", (e) => {
      const row = parse(e);
      if (row) onRun(row);
    });
    source.addEventListener("project", (e) => {
      const row = parse(e);
      if (row) onProject(row);
    });
    source.addEventListener("error", () => {
      onDown();
      // The browser retries a dropped connection itself; a closed one (the server refused it) is reopened here.
      if (source && source.readyState === EventSource.CLOSED) {
        source = null;
        attempt += 1;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
        timer = setTimeout(connect, delay);
      }
    });
  };

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (source) source.close();
  };
}

/**
 * Opens one job's stream. `isLive()` says whether the job still runs; when the stream drops and the job is not live,
 * the stream is closed (`onEnded`) instead of reconnecting. Returns { close }.
 */
export function openJobStream(ref, { onOpen, onEngine, onTranscript, onChat, onState, onEnded, onDown, isLive }) {
  const source = new EventSource(streamUrls.job(ref));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };
  source.addEventListener("open", () => onOpen());
  source.addEventListener("engine", (e) => {
    const event = parse(e);
    if (event) onEngine(event);
  });
  source.addEventListener("transcript", (e) => {
    const data = parse(e);
    if (data && data.line) onTranscript(data.session, data.line);
  });
  source.addEventListener("chat", (e) => {
    const message = parse(e);
    if (message) onChat(message);
  });
  source.addEventListener("state", (e) => {
    const patch = parse(e);
    if (patch) onState(patch);
  });
  source.addEventListener("error", () => {
    if (closed) return;
    if (!isLive()) {
      close();
      onEnded();
      return;
    }
    if (source.readyState === EventSource.CLOSED) {
      close();
      onEnded();
      return;
    }
    onDown();
  });
  return { close };
}
