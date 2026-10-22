import http from "node:http";

import { routeRequest, type RouteContext } from "./routes.js";
import type { StreamRegistry } from "./sse.js";
import { webRootOf } from "./static.js";
import { log } from "../util/log.js";

// The web UI server (docs/design/web-ui.md, 5.0 and 8.2): node:http, bound to the loopback interface only and
// reached as `localhost`. It never listens on an all-interfaces address. Port 0 asks the operating system for a free
// port; the port actually bound is returned, so nothing here chooses or stores a port.

export interface ServeUiOptions {
  /** The port to listen on. 0 (the default) lets the operating system choose. */
  port?: number;
  env?: NodeJS.ProcessEnv;
}

export interface UiServer {
  /** The URL a browser opens, always with the host name `localhost`. */
  url: string;
  /** The port bound. */
  port: number;
  /** Ends every open stream, closes the server and its connections. */
  close(): Promise<void>;
}

/** Starts the web server. Rejects when the port cannot be bound (for example, the port is in use). */
export function serveUi(options: ServeUiOptions = {}): Promise<UiServer> {
  const env = options.env ?? process.env;
  const webRoot = webRootOf();
  const streams: StreamRegistry = new Set();
  const ctx: RouteContext = {
    env,
    webRoot,
    allowedHosts: new Set<string>(),
    streams,
    startedAt: new Date().toISOString(),
  };
  const server = http.createServer((req, res) => {
    void routeRequest(req, res, ctx);
  });
  return new Promise<UiServer>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen({ port: options.port ?? 0, host: "localhost" }, () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const hosts = ctx.allowedHosts as Set<string>;
      hosts.add("localhost");
      hosts.add(`localhost:${port}`);
      server.on("error", (err) => log.warn(`web server error: ${err.message}`));
      resolve({
        url: `http://localhost:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const end of [...streams]) end();
            streams.clear();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
