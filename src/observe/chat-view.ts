import fs from "node:fs";
import path from "node:path";

import { completeLinesOf } from "./tail.js";

// The chat history of a run (docs/design/web-ui.md, 5.3 and 6.2): runs/<id>/chat.jsonl, one ChatMessage per line,
// the last line for an id wins. Messages come back oldest first (by the order of their first line).

export interface ChatMessageView {
  id: string;
  ts: string;
  role: "user" | "planner" | "system";
  text: string;
  status: "queued" | "answering" | "answered" | "failed" | "refused";
  reply_to: string | null;
  session_id: string | null;
  amendment: unknown;
}

/** One chat line parsed, or undefined for a line that is not a chat message. */
export function parseChatLine(line: string): ChatMessageView | undefined {
  try {
    const raw = JSON.parse(line) as Partial<ChatMessageView>;
    if (typeof raw.id !== "string" || typeof raw.ts !== "string" || typeof raw.text !== "string") return undefined;
    return {
      id: raw.id,
      ts: raw.ts,
      role: (raw.role ?? "user") as ChatMessageView["role"],
      text: raw.text,
      status: (raw.status ?? "queued") as ChatMessageView["status"],
      reply_to: raw.reply_to ?? null,
      session_id: raw.session_id ?? null,
      amendment: raw.amendment ?? null,
    };
  } catch {
    return undefined;
  }
}

export function chatHistoryOf(runDir: string): ChatMessageView[] {
  const file = path.join(runDir, "chat.jsonl");
  if (!fs.existsSync(file)) return [];
  const order: string[] = [];
  const latest = new Map<string, ChatMessageView>();
  for (const line of completeLinesOf(file)) {
    const message = parseChatLine(line);
    if (message === undefined) continue;
    if (!latest.has(message.id)) order.push(message.id);
    latest.set(message.id, message);
  }
  return order.map((id) => latest.get(id) as ChatMessageView);
}
