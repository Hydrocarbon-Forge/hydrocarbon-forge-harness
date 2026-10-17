#!/usr/bin/env node
import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (specifier.endsWith(".js")) {
          const tsSpec = specifier.slice(0, -3) + ".ts";
          try {
            return nextResolve(tsSpec, context);
          } catch {}
        }
        throw err;
      }
    },
  });
} else if (typeof nodeModule.register === "function") {
  const hookCode = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js")) {
      const tsSpec = specifier.slice(0, -3) + ".ts";
      try {
        return await nextResolve(tsSpec, context);
      } catch {}
    }
    throw err;
  }
}
`;
  nodeModule.register(
    `data:text/javascript;base64,${Buffer.from(hookCode).toString("base64")}`,
    import.meta.url
  );
}

const { benchCommand } = await import("../src/cli/bench.ts");

const exitCode = await benchCommand.execute({
  cwd: process.cwd(),
  rawArgs: process.argv.slice(2),
  flags: {},
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exit(exitCode);
