import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// The engine's inbox (docs/design/web-ui.md, 6.2): runs/<id>/inbox/<n>.json, one message per file, written by the
// server with a temporary name and renamed into place, so a file is read whole. The engine reads the pending
// files oldest first and moves each one it has processed to inbox/consumed/. Nothing is deleted: the moved file
// is the evidence of what the engine was sent.

export const INBOX_DIR = "inbox";
export const INBOX_CONSUMED_DIR = path.join(INBOX_DIR, "consumed");

const InboxFields = {
  v: z.literal(1),
  n: z.number().int().positive(),
  ts: z.string(),
};

export const InboxMessage = z.discriminatedUnion("kind", [
  z.object({ ...InboxFields, kind: z.literal("chat"), chat_id: z.string(), text: z.string() }).strict(),
  z.object({ ...InboxFields, kind: z.literal("amendment"), chat_id: z.string(), dir: z.string() }).strict(),
]);
export type InboxMessage = z.infer<typeof InboxMessage>;

/** One pending file: its number, its path, and either the validated message or why it could not be read. */
export interface InboxEntry {
  n: number;
  file: string;
  message?: InboxMessage;
  error?: string;
}

/**
 * The pending messages of a run, oldest first. A file that does not parse or does not validate is returned
 * with its error, so the caller refuses it in chat instead of skipping it silently.
 */
export function pendingInbox(runDir: string): InboxEntry[] {
  const dir = path.join(runDir, INBOX_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => ({ n: Number(name.slice(0, -".json".length)), file: path.join(dir, name) }))
    .sort((a, b) => a.n - b.n)
    .map((entry): InboxEntry => {
      try {
        const parsed = InboxMessage.safeParse(JSON.parse(fs.readFileSync(entry.file, "utf8")));
        if (!parsed.success) {
          return { ...entry, error: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") };
        }
        return { ...entry, message: parsed.data };
      } catch (err: any) {
        return { ...entry, error: err?.message ?? String(err) };
      }
    });
}

/**
 * Moves a processed message into inbox/consumed/. A name already taken there gets a numbered suffix, so an
 * earlier message is never overwritten. Returns the new path.
 */
export function consumeInboxFile(runDir: string, file: string): string {
  const dir = path.join(runDir, INBOX_CONSUMED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(file, ".json");
  let target = path.join(dir, path.basename(file));
  for (let k = 2; fs.existsSync(target); k++) {
    target = path.join(dir, `${base}-${k}.json`);
  }
  fs.renameSync(file, target);
  return target;
}
