#!/usr/bin/env node
import { runCli } from "../src/cli/dispatcher.js";

const abortController = new AbortController();
let sigintCount = 0;

process.on("SIGINT", () => {
  sigintCount++;
  if (sigintCount === 1) {
    process.stderr.write("\nReceived SIGINT. Aborting execution...\n");
    abortController.abort();
    process.exit(130);
  } else {
    process.exit(130);
  }
});

process.on("SIGTERM", () => {
  process.stderr.write("\nReceived SIGTERM. Terminating cleanly...\n");
  abortController.abort();
  process.exit(143);
});

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (err) {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
