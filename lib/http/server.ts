import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { isLoopbackAddress, isPrivateAddress } from "../net/address-classification.js";
import { validateHttpHost, type HostValidationOptions } from "./host-validation.js";

export type JsonObject = Record<string, unknown>;
export type JsonParser = (text: string, source: string) => unknown;

export class HttpError extends Error {
  readonly statusCode: number;
  commandId?: string;
  commandState?: string;

  constructor(statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function requestError(statusCode: number, message: string, options?: ErrorOptions): HttpError {
  return new HttpError(statusCode, message, options);
}

export function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

export function json<T>(response: ServerResponse, status: number, body: T): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  response.end(JSON.stringify(body, null, 2));
}

export function text(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array,
  type = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, { "content-type": type, ...securityHeaders() });
  response.end(body);
}

export function redirect(response: ServerResponse, location: string, status = 308): void {
  response.writeHead(status, { location, "cache-control": "no-store", ...securityHeaders() });
  response.end();
}

export async function readBody(request: IncomingMessage, parse: JsonParser): Promise<JsonObject> {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw requestError(415, "request body must use application/json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > 1_048_576) throw requestError(413, "request body exceeds 1 MiB limit");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  let parsed: unknown;
  try {
    parsed = parse(body, `${request.method} ${request.url} request body`);
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "invalid JSON";
    throw requestError(400, detail, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw requestError(400, "request body must be a JSON object");
  }
  return parsed as JsonObject;
}

export function requestHasValidOrigin(
  request: IncomingMessage,
  options: { requireOrigin?: boolean } = {},
): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) return true;
  if (String(request.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return options.requireOrigin !== true;
  try {
    return new URL(origin).host === String(request.headers.host ?? "");
  } catch {
    return false;
  }
}

export function requestHostValidation(
  request: IncomingMessage,
  options: HostValidationOptions = {},
): ReturnType<typeof validateHttpHost> {
  const distinctHosts = request.headersDistinct?.host;
  if (distinctHosts && distinctHosts.length !== 1) {
    return { valid: false, reason: "Request must contain exactly one Host header" };
  }
  return validateHttpHost(distinctHosts?.[0] ?? request.headers.host, options);
}

function firstForwardedAddress(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim();
  return first || null;
}

/**
 * Resolve the request's client address and decide whether it is private.
 *
 * `X-Forwarded-For` is only consulted when the socket peer is a trusted proxy
 * (loopback by default), so a direct client cannot spoof it. When the app runs
 * behind the bundled Caddy on loopback, the real client address is carried in
 * the forwarded header.
 */
export function requestHasPrivateClient(request: IncomingMessage): boolean {
  const peer = request.socket?.remoteAddress ?? null;
  if (peer && isLoopbackAddress(peer)) {
    const forwarded = firstForwardedAddress(request.headers["x-forwarded-for"] ?? request.headers["x-real-ip"]);
    if (forwarded) return isPrivateAddress(forwarded);
  }
  return isPrivateAddress(peer ?? undefined);
}

export function createStaticHandler(publicDirectory: string) {
  const publicDir = path.resolve(publicDirectory);
  return async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    if (pathname === "/") {
      redirect(response, "/ui/");
      return;
    }
    const publicPath = pathname === "/ui" || pathname === "/ui/" ? "/ui/index.html" : pathname;
    const resolved = path.resolve(path.join(publicDir, publicPath));
    if (resolved !== publicDir && !resolved.startsWith(`${publicDir}${path.sep}`)) {
      text(response, 403, "Forbidden");
      return;
    }
    try {
      let servedPath = resolved;
      let data: Buffer;
      try {
        data = await readFile(servedPath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || !pathname.startsWith("/ui/")) throw error;
        servedPath = path.join(publicDir, "ui", "index.html");
        data = await readFile(servedPath);
      }
      const extension = path.extname(servedPath);
      const type = extension === ".html" ? "text/html; charset=utf-8"
        : extension === ".css" ? "text/css; charset=utf-8"
          : extension === ".js" ? "text/javascript; charset=utf-8"
            : extension === ".json" || extension === ".map" ? "application/json; charset=utf-8"
              : extension === ".svg" ? "image/svg+xml"
                : "application/octet-stream";
      text(response, 200, data, type);
    } catch {
      text(response, 404, "Not found");
    }
  };
}
