import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteParameters = Readonly<Record<string, string>>;

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: RouteParameters;
}

export type RouteHandler = (context: RouteContext) => void | Promise<void>;

interface Route {
  method: string;
  pattern: string;
  segments: readonly string[];
  handler: RouteHandler;
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function matchRoute(pattern: string, pathname: string): RouteParameters | null {
  const expected = splitPath(pattern);
  const actual = splitPath(pathname);
  if (expected.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedSegment = expected[index]!;
    const actualSegment = actual[index]!;
    if (expectedSegment.startsWith(":")) {
      try {
        params[expectedSegment.slice(1)] = decodeURIComponent(actualSegment);
      } catch {
        return null;
      }
    } else if (expectedSegment !== actualSegment) {
      return null;
    }
  }
  return params;
}

export class NativeRouter {
  readonly #routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.#routes.push({ method: method.toUpperCase(), pattern, segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add("POST", pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add("DELETE", pattern, handler);
  }

  async dispatch(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const method = String(request.method ?? "GET").toUpperCase();
    for (const route of this.#routes) {
      if (route.method !== method || route.segments.length !== splitPath(url.pathname).length) continue;
      const params = matchRoute(route.pattern, url.pathname);
      if (!params) continue;
      await route.handler({ request, response, url, params });
      return true;
    }
    return false;
  }
}
