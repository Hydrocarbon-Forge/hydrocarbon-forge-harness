// The chat box, addressed to the Planner with the job in context (docs/design/web-ui.md, 4.2 and 7). Enter sends,
// Shift+Enter starts a new line, and the history shows each message with its status and any amendment it carries.
// When the service has no chat route (404 or 501), the box says so instead of failing.

import { api } from "./api.js";
import { applyChat, jobOf, state } from "./store.js";
import { clear, el, errorMessage, fmtClock } from "./util.js";

const $ = (id) => document.getElementById(id);
const NOTE = "Changes apply to pending tasks only. Running tasks finish unless stopped.";
const UNAVAILABLE = "Chat is not available in this build";

let ref = null;
let sending = false;
let sendError = "";
const drafts = new Map();

export function initChat() {
  const input = $("chat-input");
  input.addEventListener("input", () => {
    if (ref !== null) drafts.set(ref, input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape") {
      input.blur();
    }
  });
  $("chat-send").addEventListener("click", () => void send());
}

/** Shows the chat of a job (the box keeps the draft of each job it has shown). */
export function showChat(nextRef) {
  ref = nextRef;
  $("chat-input").value = ref !== null ? drafts.get(ref) ?? "" : "";
  $("chat-input").disabled = ref === null;
  renderLog();
  renderNote();
}

/** A job's chat changed (a message arrived or its status moved). */
export function onChatChanged(changedRef) {
  if (changedRef === ref) renderLog();
}

function amendmentNode(amendment) {
  if (!amendment || typeof amendment !== "object") return null;
  const list = (values) => (Array.isArray(values) && values.length > 0 ? values.join(", ") : "none");
  return el(
    "div",
    { class: "amendment" },
    el("strong", { text: `Amendment ${amendment.outcome ?? ""}` }),
    el("span", { text: ` added: ${list(amendment.added)} | changed: ${list(amendment.changed)} | dropped: ${list(amendment.dropped)} | kept (already started): ${list(amendment.kept_started)}` }),
    amendment.reason ? el("p", { class: "err-text", text: amendment.reason }) : null,
  );
}

function renderLog() {
  const log = $("chat-log");
  clear(log);
  const job = ref !== null ? jobOf(ref) : null;
  const messages = job ? [...job.chat.values()] : [];
  log.hidden = messages.length === 0 && !(job && job.chatError);
  if (job?.chatError) log.append(el("p", { class: "notice err", text: `Could not load the chat: ${job.chatError}` }));
  for (const message of messages) {
    const who = message.role === "user" ? "you" : message.role;
    log.append(
      el(
        "div",
        { class: `chat-msg role-${message.role}` },
        el("div", { class: "chat-head" }, el("strong", { text: who }), el("span", { class: "chat-status", text: message.status }), el("time", { text: fmtClock(message.ts) })),
        el("div", { class: "chat-text", text: message.text }),
        amendmentNode(message.amendment),
      ),
    );
  }
  log.scrollTop = log.scrollHeight;
}

function renderNote() {
  const note = $("chat-note");
  const unavailable = !state.chatAvailable;
  const failed = sendError !== "";
  note.textContent = unavailable ? UNAVAILABLE : failed ? sendError : NOTE;
  note.classList.toggle("err-text", unavailable || failed);
  $("chat-send").disabled = unavailable || ref === null || sending;
}

async function send() {
  if (ref === null || sending) return;
  const input = $("chat-input");
  const text = input.value.trim();
  if (text === "") return;
  if (!state.chatAvailable) {
    renderNote();
    return;
  }
  const target = ref;
  sending = true;
  sendError = "";
  renderNote();
  try {
    const message = await api.postChat(target, text);
    applyChat(target, message);
    drafts.delete(target);
    if (ref === target) input.value = "";
  } catch (err) {
    if (err.status === 404 || err.status === 501) {
      state.chatAvailable = false;
    } else {
      sendError = `Could not send: ${errorMessage(err)}`;
    }
  } finally {
    sending = false;
    renderNote();
    renderLog();
  }
}
