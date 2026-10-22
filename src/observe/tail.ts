import fs from "node:fs";

// Incremental reader of an append-only file (events.jsonl, a transcript, chat.jsonl) for the web server's
// streams. It opens the file only for the length of one read, so no descriptor is held between polls. A line
// is returned only when its newline has been written: a torn last line waits for the rest of it, and a file
// that shrank (a torn tail was repaired) is read again from its start.

export class LineTailer {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly file: string) {}

  /** Starts after everything the file holds now, so only lines written later are returned. */
  skipToEnd(): void {
    try {
      this.offset = fs.statSync(this.file).size;
    } catch {
      this.offset = 0;
    }
    this.pending = Buffer.alloc(0);
  }

  /** The complete, non-empty lines written since the last call, oldest first. */
  read(): string[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    const length = size - this.offset;
    const chunk = Buffer.alloc(length);
    let read = 0;
    const fd = fs.openSync(this.file, "r");
    try {
      read = fs.readSync(fd, chunk, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += read;
    const bytes = Buffer.concat([this.pending, chunk.subarray(0, read)]);
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0x0a) continue;
      const line = bytes.subarray(start, i).toString("utf8");
      if (line.trim().length > 0) lines.push(line);
      start = i + 1;
    }
    this.pending = Buffer.from(bytes.subarray(start));
    return lines;
  }
}

/** The complete lines of a file, read whole (a torn last line is left out). Empty when the file does not exist. */
export function completeLinesOf(file: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const parts = content.split("\n");
  if (!content.endsWith("\n")) parts.pop();
  return parts.filter((l) => l.trim().length > 0);
}
