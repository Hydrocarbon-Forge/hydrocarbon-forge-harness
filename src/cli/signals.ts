export function exitCodeForSignal(sig: "SIGINT" | "SIGTERM"): 130 | 143 {
  return sig === "SIGINT" ? 130 : 143;
}

export function installSignalHandlers(opts: {
  controller: AbortController;
  write(text: string): void;
  exit(code: number): void;
}): () => void {
  let signalCount = 0;

  const onSignal = (sig: "SIGINT" | "SIGTERM") => {
    signalCount++;
    if (signalCount === 1) {
      opts.write(`substrate: stopping (${sig}); press Ctrl-C again to force exit\n`);
      opts.controller.abort(sig);
    } else {
      opts.exit(exitCodeForSignal(sig));
    }
  };

  const onSigInt = () => onSignal("SIGINT");
  const onSigTerm = () => onSignal("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  return () => {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
  };
}
