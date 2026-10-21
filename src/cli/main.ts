const { runCli } = await import(`./dispatcher.js`);
const { installSignalHandlers, exitCodeForSignal } = await import(`./signals.js`);

// A run started with --detach (R10.3) ignores a hangup: closing the terminal does not end it.
if (process.env.SUBSTRATE_DETACHED === "1") {
  process.on("SIGHUP", () => {});
}

let lastSignal: "SIGINT" | "SIGTERM" = "SIGINT";
const controller = new AbortController();

const cleanup = installSignalHandlers({
  controller,
  write: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
});

process.on("SIGINT", () => {
  lastSignal = "SIGINT";
});
process.on("SIGTERM", () => {
  lastSignal = "SIGTERM";
});

let code = 0;
try {
  code = await runCli(process.argv.slice(2), {
    signal: controller.signal,
  });
} catch (err) {
  if (controller.signal.aborted) {
    cleanup();
    process.exit(exitCodeForSignal(lastSignal));
  }
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  code = 1;
}

cleanup();
if (controller.signal.aborted) {
  process.exit(exitCodeForSignal(lastSignal));
}
process.exit(code);
