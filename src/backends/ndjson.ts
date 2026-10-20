export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface NdjsonReaderOptions {
  maxLineLength?: number;
  rawSink?: (chunk: string | Buffer) => void;
  onParseError?: (error: Error, rawLine: string) => void;
}

const DEFAULT_MAX_LINE_LENGTH = 10 * 1024 * 1024; // 10 MB

export async function* readNdjsonLines(
  stream: NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
  options?: NdjsonReaderOptions
): AsyncIterable<string> {
  const maxLineLength = options?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  let buffer = "";

  for await (const chunk of stream) {
    if (options?.rawSink) {
      options.rawSink(chunk);
    }

    const chunkStr = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    buffer += chunkStr;

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (rawLine.length > maxLineLength) {
        buffer = "";
        throw new ProtocolError(
          `Line length (${rawLine.length}) exceeds maximum limit of ${maxLineLength} bytes`
        );
      }

      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length > 0) {
        yield line;
      }
    }

    if (buffer.length > maxLineLength) {
      buffer = "";
      throw new ProtocolError(
        `Buffered line fragment (${buffer.length}) exceeds maximum limit of ${maxLineLength} bytes`
      );
    }
  }

  // Trailing line after stream closes
  if (buffer.length > maxLineLength) {
    buffer = "";
    throw new ProtocolError(
      `Buffered line fragment (${buffer.length}) exceeds maximum limit of ${maxLineLength} bytes`
    );
  }

  const trailing = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  if (trailing.trim().length > 0) {
    yield trailing;
  }
}

export async function* readNdjsonStream<T = unknown>(
  stream: NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
  options?: NdjsonReaderOptions
): AsyncIterable<T> {
  for await (const line of readNdjsonLines(stream, options)) {
    try {
      const parsed = parseNdjsonLine<T>(line);
      yield parsed;
    } catch (err: any) {
      if (options?.onParseError) {
        options.onParseError(
          err instanceof Error ? err : new Error(String(err)),
          line
        );
      } else {
        if (err instanceof ProtocolError) {
          throw err;
        }
        throw new ProtocolError(
          `Failed to parse NDJSON line: ${err?.message ?? String(err)}`
        );
      }
    }
  }
}

export function parseNdjsonLine<T = unknown>(line: string): T {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new ProtocolError("Cannot parse empty line as NDJSON");
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (err: any) {
    throw new ProtocolError(`Invalid JSON: ${err?.message ?? String(err)}`);
  }
}
