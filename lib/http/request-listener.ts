import type { IncomingMessage, ServerResponse } from "node:http";
import { logDetailedError } from "../logging.js";
import type { NativeRouter } from "./router.js";
import { json, requestHasPrivateClient, requestHostValidation, requestHasValidOrigin } from "./server.js";

export interface RequestListenerOptions {
  api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void>;
  apiRouter: NativeRouter;
  serveStatic(response: ServerResponse, pathname: string): Promise<void>;
  trustedHosts(): ReadonlySet<string>;
}

/**
 * Build the top-level HTTP listener: enforce the private-client guard, the Host
 * allowlist, and the origin check, then dispatch API or static requests.
 */
export function createRequestListener(options: RequestListenerOptions) {
  return async function requestListener(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!requestHasPrivateClient(request)) {
        return json(response, 403, { error: "requests from non-private network addresses are not allowed" });
      }
      const hostValidation = requestHostValidation(request, { trustedHosts: options.trustedHosts() });
      if (!hostValidation.valid) {
        return json(response, 400, { error: hostValidation.reason });
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!requestHasValidOrigin(request, { requireOrigin: hostValidation.trust === "trusted" })) {
        return json(response, 403, { error: "cross-origin state-changing requests are not allowed" });
      }
      if (url.pathname.startsWith("/api/")) {
        if (await options.apiRouter.dispatch(request, response, url)) return;
        await options.api(request, response, url);
        return;
      }
      await options.serveStatic(response, url.pathname);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error : new Error(String(error));
      const metadata = detail as Error & { statusCode?: number; commandId?: string; commandState?: string };
      const status = Number.isInteger(metadata.statusCode) ? metadata.statusCode! : 500;
      if (status >= 500) logDetailedError("api", detail);
      json(response, status, {
        error: detail.message,
        ...(metadata.commandId ? { commandId: metadata.commandId } : {}),
        ...(metadata.commandState ? { commandState: metadata.commandState } : {}),
      });
    }
  };
}
