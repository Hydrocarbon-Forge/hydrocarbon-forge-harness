import http from "node:http";
import net from "node:net";

import { routeRequest, type RouteContext } from "./routes.js";
import { hostGuardOf } from "./http.js";
import type { StreamRegistry } from "./sse.js";
import { webRootOf } from "./static.js";
import { isWildcardHost } from "../store/ui-state.js";
import { log } from "../util/log.js";

// The web UI server (docs/design/web-ui.md, 5.0 and 8.2): node:http. It listens on `localhost` by default, and on the
// host it is given otherwise (an interface name or address, or the all-interfaces wildcard). The POST Host check runs
// only when it is bound to localhost (hostGuardOf). Port 0 asks the operating system for a free port; the port actually
// bound is returned, so nothing here chooses or stores a port.

export interface ServeUiOptions {
  /** The port to listen on. 0 (the default) lets the operating system choose. */
  port?: number;
  /** The host to listen on: `localhost` (the default), an interface name or address, or the all-interfaces wildcard. */
  host?: string;
  env?: NodeJS.ProcessEnv;
}

export interface UiServer {
  /** The URL a browser opens. A wildcard bind is reached as `localhost`; any other host is named as configured. */
  url: string;
  /** The host the server listens on, as configured. */
  host: string;
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
  const host = options.host ?? "localhost";
  const ctx: RouteContext = {
    env,
    webRoot,
    allowedHosts: undefined,
    streams,
    startedAt: new Date().toISOString(),
  };
  const server = http.createServer((req, res) => {
    void routeRequest(req, res, ctx);
  });
  return new Promise<UiServer>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen({ port: options.port ?? 0, host }, () => {
      server.off("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      ctx.allowedHosts = hostGuardOf(host, port);
      server.on("error", (err) => log.warn(`web server error: ${err.message}`));
      // A wildcard has no name a browser can open, so the URL uses localhost; a named host or address is used as given.
      const shown = isWildcardHost(host) ? "localhost" : host;
      const urlHost = net.isIPv6(shown) ? `[${shown}]` : shown;
      resolve({
        url: `http://${urlHost}:${port}`,
        host,
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
