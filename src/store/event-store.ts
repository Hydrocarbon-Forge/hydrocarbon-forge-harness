import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EngineEvent, type RunId } from "../contracts/index.js";
import { type EngineState, reduce } from "../engine/reducer.js";

// The contract envelope with the run id validated as a string. Run directories can
// pre-date the RunId regex (see the note in src/contracts/events.ts), so the store
// must accept their ids; the RunId type is enforced where new ids are generated.
// Event data shapes are checked against the catalog by the emit sites.
const StoreEventEnvelope = EngineEvent.extend({ run_id: z.string() });

export interface EventStore {
  append(event: EngineEvent): Promise<void>;
  readAll(): Promise<EngineEvent[]>;
  replay(initialState?: EngineState): Promise<EngineState>;
}

export class EventStoreImpl implements EventStore {
  private readonly logPath: string;
  private lastSeq: number | undefined;

  constructor(
    private readonly runId: RunId,
    options?: { baseDir?: string; runDir?: string }
  ) {
    const baseDir = options?.baseDir ?? process.cwd();
    this.logPath = options?.runDir
      ? path.join(options.runDir, "events.jsonl")
      : path.join(baseDir, ".substrate", "runs", runId, "events.jsonl");
  }

  async append(event: EngineEvent): Promise<void> {
    this.appendSync(event);
  }

  /**
   * Same checks as `append`, for the synchronous write path the emitter uses.
   */
  appendSync(event: EngineEvent): void {
    StoreEventEnvelope.parse(event);

    if (event.run_id !== this.runId) {
      throw new Error(
        `Event run_id "${event.run_id}" does not match store run_id "${this.runId}"`
      );
    }

    if (this.lastSeq === undefined) {
      const existing = this.readAllSync();
      this.lastSeq = existing.length > 0 ? existing[existing.length - 1].seq : 0;
    }

    if (event.seq !== this.lastSeq + 1) {
      throw new Error(
        `Monotonic sequence numbering violation: expected seq ${this.lastSeq + 1}, got ${event.seq}`
      );
    }

    const logDir = path.dirname(this.logPath);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(this.logPath, JSON.stringify(event) + "\n", "utf8");
    this.lastSeq = event.seq;
  }

  async readAll(): Promise<EngineEvent[]> {
    return this.readAllSync();
  }

  readAllSync(): EngineEvent[] {
    if (!fs.existsSync(this.logPath)) {
      return [];
    }

    const content = fs.readFileSync(this.logPath, "utf8");
    if (!content || !content.trim()) {
      return [];
    }

    const rawLines = content.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") {
      rawLines.pop();
    }
    if (rawLines.length === 0) {
      return [];
    }

    const events: EngineEvent[] = [];
    const total = rawLines.length;

    for (let i = 0; i < total; i++) {
      const line = rawLines[i];
      const lineNum = i + 1;
      const isLast = i === total - 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err: any) {
        if (isLast) {
          // Torn-tail JSON from ungraceful kill: ignore truncated last line
          break;
        }
        throw new Error(
          `Corruption error in ${this.logPath} at line ${lineNum}: invalid JSON - ${err?.message}`
        );
      }

      const result = StoreEventEnvelope.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `Corruption error in ${this.logPath} at line ${lineNum}: schema violation - ${result.error.message}`
        );
      }

      events.push(result.data);
    }

    return events;
  }

  async replay(initialState?: EngineState): Promise<EngineState> {
    const events = await this.readAll();
    let state: EngineState = initialState ?? {
      run_id: this.runId,
      state: "CREATED",
      tasks: {},
      usage: { total_usd: 0, by_role: {} },
      checkpoints: [],
    };

    for (const ev of events) {
      state = reduce(state, ev);
    }

    return state;
  }
}
