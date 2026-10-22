import path from "node:path";

import type { ProjectRun } from "../observe/runs-view.js";
import { chatHistoryOf } from "../observe/chat-view.js";
import { appendChatMessage, writeChatLine, type ChatLine } from "../store/chat.js";
import { writeInboxMessage } from "../store/inbox.js";
import { spawnDetached } from "../util/process-control.js";
import { ApiError } from "./http.js";

// The chat POST (docs/design/web-ui.md, 5.2 and 7.1): the message is written to chat.jsonl as queued and to the
// engine's inbox, and a detached planner chat turn (`substrate ui chat-turn`, hidden from help) answers it. The turn
// is a separate process, so the server never waits for the planner.

/** A chat message is at most this many characters (5.0). */
export const CHAT_MESSAGE_CAP = 8000;
/** The turn process's output, kept in the run directory. */
export const CHAT_LOG_FILE = "chat-turn.log";

/** Records the message as queued and starts its turn. Returns the message as written (status queued). */
export function postChatMessage(run: ProjectRun, text: string): ChatLine {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new ApiError("bad_request", "the message is empty");
  if (trimmed.length > CHAT_MESSAGE_CAP) {
    throw new ApiError("bad_request", `a chat message is at most ${CHAT_MESSAGE_CAP} characters`);
  }
  const { runDir, runId } = run.record;
  const message = appendChatMessage(runDir, {
    role: "user",
    text: trimmed,
    status: "queued",
    reply_to: null,
    session_id: null,
    amendment: null,
  });
  writeInboxMessage(runDir, { kind: "chat", chat_id: message.id, text: trimmed });
  startChatTurn(run, runId, message.id);
  return message;
}

/**
 * Starts the detached turn for a message. A turn that cannot start, or that stops with an error before it answered,
 * writes the failure to chat, so the browser is never left waiting for a reply that will not come.
 */
function startChatTurn(run: ProjectRun, runId: string, messageId: string): void {
  const { runDir } = run.record;
  const failIfOpen = (reason: string): void => {
    const current = chatHistoryOf(runDir).find((m) => m.id === messageId);
    if (current === undefined || (current.status !== "queued" && current.status !== "answering")) return;
    writeChatLine(runDir, { ...(current as ChatLine), status: "failed" });
    appendChatMessage(runDir, {
      role: "system",
      text: `${reason}. Nothing was changed.`,
      status: "failed",
      reply_to: messageId,
      session_id: null,
      amendment: null,
    });
  };

  let child: ReturnType<typeof spawnDetached>;
  try {
    child = spawnDetached({
      script: path.resolve(process.argv[1]),
      args: ["ui", "chat-turn", "--project", run.project.path, "--run", runId, "--message", messageId],
      cwd: run.project.path,
      env: { ...process.env },
      logFile: path.join(runDir, CHAT_LOG_FILE),
      stdin: false,
    });
  } catch (err) {
    failIfOpen(`The planner could not be started: ${err instanceof Error ? err.message : String(err)}`);
    throw new ApiError("unavailable", "the planner chat turn could not be started");
  }
  child.on("error", (err) => failIfOpen(`The planner could not be started: ${err.message}`));
  child.on("exit", (code) => {
    if (code !== 0) failIfOpen(`The planner chat turn stopped unexpectedly (exit ${code ?? "by signal"}); see ${CHAT_LOG_FILE}`);
  });
}
