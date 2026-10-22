import fs from "node:fs";
import path from "node:path";

// runs/<id>/chat.jsonl (docs/design/web-ui.md, 5.3 and 6.2): one ChatMessage per line; the last line for an id
// wins. The server writes the user lines and the planner writes its replies. The engine writes system replies
// here, so the UI can show what happened to an amendment (applied, kept, refused).

export const CHAT_FILE = "chat.jsonl";

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

export interface SystemChatInput {
  text: string;
  status: "answered" | "refused";
  reply_to: string | null;
  amendment: AmendmentSummary | null;
}

/** The next chat id ("c<n>", counted per run): one more than the highest id in the file. */
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

/** Appends one system reply to runs/<id>/chat.jsonl and returns its id. */
export function appendSystemChat(runDir: string, input: SystemChatInput): string {
  const file = path.join(runDir, CHAT_FILE);
  const id = nextChatId(file);
  const line = {
    id,
    ts: new Date().toISOString(),
    role: "system",
    text: input.text,
    status: input.status,
    reply_to: input.reply_to,
    session_id: null,
    amendment: input.amendment,
  };
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  return id;
}
