import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { parse } from "tldts";

export const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const LOCAL_SUFFIXES = [".local", ".home.arpa", ".internal"];

/** Normalize a DNS name to lowercase ASCII, stripping exactly one trailing dot. */
export function normalizeDnsName(value: string): string | null {
  let hostname = value.trim().toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.endsWith(".")) return null;
  const ascii = domainToASCII(hostname);
  if (!ascii || ascii.length > 253 || ascii.split(".").some((label) => !DNS_LABEL.test(label))) {
    return null;
  }
  return ascii;
}

/**
 * Normalize a user-supplied hostname for the trusted-host allowlist. Accepts a
 * syntactically valid, publicly-delegated DNS name (ICANN or private suffix);
 * rejects IP literals, single-label names, wildcards, ports, and local
 * namespaces (which are already accepted without an exception).
 */
export function normalizePublicHost(value: unknown): string | null {
  const raw = value === undefined || value === null ? "" : String(value);
  if (!raw || raw !== raw.trim()) return null;
  if (raw.includes("/") || raw.includes(":") || raw.includes("*") || raw.includes("@")) return null;
  const hostname = normalizeDnsName(raw);
  if (!hostname || !hostname.includes(".")) return null;
  if (isIP(hostname) !== 0) return null;
  if (hostname === "localhost") return null;
  if (LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;
  const classification = parse(hostname, { allowPrivateDomains: true });
  if (!classification.isIcann && !classification.isPrivate) return null;
  return hostname;
}
