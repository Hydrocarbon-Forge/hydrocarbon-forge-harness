import fs from "node:fs";
import path from "node:path";

// runs/<id>/chat.jsonl (docs/design/web-ui.md, 5.3 and 6.2): one ChatMessage per line; the last line for an id wins.
// The server writes the user lines, the planner chat turn writes the planner's replies and the system notes (what an
// amendment did, or why nothing changed). Ids are allocated under a short lock so two writers never take the same id.

export const CHAT_FILE = "chat.jsonl";
const CHAT_LOCK = "chat.lock";
/** A lock file older than this belongs to a process that died holding it. */
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 5000;

/** The amendment a chat reply reports (docs/design/web-ui.md, 5.3). */
export interface AmendmentSummary {
  chat_id: string;
  outcome: "pending" | "applied" | "rejected";
  applied_at: "live" | "resume" | null;
  added: string[];
  changed: string[];
  dropped: string[];
  kept_started: string[];
  reason: string | null;
}

export type ChatRole = "user" | "planner" | "system";
export type ChatStatus = "queued" | "answering" | "answered" | "failed" | "refused";

/** One line of chat.jsonl: a ChatMessage (docs/design/web-ui.md, 5.3). */
export interface ChatLine {
  id: string;
  ts: string;
  role: ChatRole;
  text: string;
  status: ChatStatus;
  reply_to: string | null;
  session_id: string | null;
  amendment: AmendmentSummary | null;
}

/** The fields a new message carries; the id and the time are allocated when it is written. */
export type ChatInput = Omit<ChatLine, "id" | "ts">;

export interface SystemChatInput {
  text: string;
  status: "answered" | "refused" | "failed";
  reply_to: string | null;
  amendment: AmendmentSummary | null;
}

/** The highest "c<n>" id in the file, plus one. A line that does not parse does not reserve a number. */
function nextChatId(file: string): string {
  let highest = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const match = /^c(\d+)$/.exec(String((JSON.parse(line) as { id?: unknown }).id ?? ""));
        if (match) highest = Math.max(highest, Number(match[1]));
      } catch {
        // A line that does not parse is not a message; it does not reserve a number.
      }
    }
  }
  return `c${highest + 1}`;
}

/** Runs `fn` while holding runs/<id>/chat.lock. A lock left by a dead process is taken over after LOCK_STALE_MS. */
function withChatLock<T>(runDir: string, fn: () => T): T {
  const lock = path.join(runDir, CHAT_LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`the chat file is locked (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Appends one line as it is: a new message, or the same id with a new status (the last line for an id wins). */
export function writeChatLine(runDir: string, line: ChatLine): void {
  fs.appendFileSync(path.join(runDir, CHAT_FILE), `${JSON.stringify(line)}\n`, "utf8");
}

/** Appends a new message under the next free id and returns it. */
export function appendChatMessage(runDir: string, input: ChatInput): ChatLine {
  return withChatLock(runDir, () => {
    const line: ChatLine = { id: nextChatId(path.join(runDir, CHAT_FILE)), ts: new Date().toISOString(), ...input };
    writeChatLine(runDir, line);
    return line;
  });
}

/** Appends one system reply to runs/<id>/chat.jsonl and returns its id. */
export function appendSystemChat(runDir: string, input: SystemChatInput): string {
  return appendChatMessage(runDir, { role: "system", session_id: null, ...input }).id;
}
