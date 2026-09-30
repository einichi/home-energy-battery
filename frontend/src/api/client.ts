import { validateApiPayload } from "./validation";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(payload?.error ?? `Request failed with HTTP ${response.status}`, response.status);
  }
  const payload: unknown = await response.json();
  validateApiPayload(url, payload, "GET");
  return payload as T;
}

export async function sendJson<T>(url: string, method: "POST" | "PATCH" | "DELETE" | "PUT", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as (T & {
    error?: string;
    commandId?: string;
    commandState?: string;
  }) | null;
  if (!response.ok) {
    const error = new ApiError(payload?.error ?? `Request failed with HTTP ${response.status}`, response.status) as ApiError & {
      commandId?: string;
      commandState?: string;
    };
    error.commandId = payload?.commandId;
    error.commandState = payload?.commandState;
    throw error;
  }
  validateApiPayload(url, payload, method);
  return payload as T;
}
