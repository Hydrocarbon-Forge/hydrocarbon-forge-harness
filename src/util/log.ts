function formatData(data: unknown): string {
  if (data === undefined) return "";
  try {
    return typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function writeLine(
  level: "debug" | "warn" | "error",
  msg: string,
  data?: unknown,
  ...rest: unknown[]
): void {
  const parts = [msg];
  if (data !== undefined) {
    parts.push(formatData(data));
  }
  for (const item of rest) {
    parts.push(formatData(item));
  }
  process.stderr.write(`[substrate] ${level}: ${parts.join(" ")}\n`);
}

export const log = {
  debug(msg: string, data?: unknown, ...rest: unknown[]): void {
    if (process.env.SUBSTRATE_DEBUG === "1") {
      writeLine("debug", msg, data, ...rest);
    }
  },
  warn(msg: string, data?: unknown, ...rest: unknown[]): void {
    writeLine("warn", msg, data, ...rest);
  },
  error(msg: string, data?: unknown, ...rest: unknown[]): void {
    writeLine("error", msg, data, ...rest);
  },
};
