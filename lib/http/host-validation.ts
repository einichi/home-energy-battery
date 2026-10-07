import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { parse } from "tldts";
import { DNS_LABEL, LOCAL_SUFFIXES } from "../domain/hostname.js";

export type HostTrust = "local" | "trusted";

export type HostValidationResult =
  | { valid: true; hostname: string; port: number | null; trust: HostTrust }
  | { valid: false; reason: string };

export interface HostValidationOptions {
  /**
   * Exact, normalized hostnames that are explicitly trusted via Settings (for
   * example a publicly-delegated domain that resolves to a LAN address). Only
   * these publicly-delegated names are accepted; every other one is rejected.
   */
  trustedHosts?: ReadonlySet<string>;
}

function parsePort(value: string | undefined): number | null | false {
  if (value === undefined) return null;
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : false;
}

/** Parse an HTTP Host value without DNS resolution and classify its namespace. */
export function validateHttpHost(
  value: string | readonly string[] | undefined,
  options: HostValidationOptions = {},
): HostValidationResult {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    return { valid: false, reason: "Host header is missing or malformed" };
  }
  if ([...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
    || /[,@/\\]/.test(value)) {
    return { valid: false, reason: "Host header contains ambiguous syntax" };
  }

  let hostnameText: string;
  let portText: string | undefined;
  if (value.startsWith("[")) {
    const bracketed = /^\[([^\]]+)](?::(\d{1,5}))?$/.exec(value);
    if (!bracketed || isIP(bracketed[1]!) !== 6) {
      return { valid: false, reason: "Host header contains an invalid IPv6 literal" };
    }
    const port = parsePort(bracketed[2]);
    if (port === false) return { valid: false, reason: "Host header contains an invalid port" };
    return { valid: true, hostname: bracketed[1]!.toLowerCase(), port, trust: "local" };
  }

  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount > 1) return { valid: false, reason: "IPv6 Host literals must be bracketed" };
  if (colonCount === 1) {
    [hostnameText, portText] = value.split(":", 2) as [string, string];
  } else {
    hostnameText = value;
  }
  const port = parsePort(portText);
  if (port === false) return { valid: false, reason: "Host header contains an invalid port" };

  if (hostnameText.endsWith(".")) hostnameText = hostnameText.slice(0, -1);
  if (!hostnameText || hostnameText.endsWith(".")) {
    return { valid: false, reason: "Host header contains an invalid DNS root suffix" };
  }
  if (isIP(hostnameText) === 4) return { valid: true, hostname: hostnameText, port, trust: "local" };
  if (/^[\d.]+$/.test(hostnameText)) {
    return { valid: false, reason: "Host header contains an invalid IPv4 literal" };
  }

  const hostname = domainToASCII(hostnameText.toLowerCase());
  if (!hostname || hostname.length > 253 || hostname.split(".").some((label) => !DNS_LABEL.test(label))) {
    return { valid: false, reason: "Host header contains an invalid DNS name" };
  }
  if (hostname === "localhost" || !hostname.includes(".")) {
    return { valid: true, hostname, port, trust: "local" };
  }
  if (LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { valid: true, hostname, port, trust: "local" };
  }
  if (options.trustedHosts?.has(hostname)) {
    return { valid: true, hostname, port, trust: "trusted" };
  }

  const classification = parse(hostname, { allowPrivateDomains: true });
  if (classification.isIcann || classification.isPrivate) {
    return { valid: false, reason: "Publicly delegated DNS names are not permitted" };
  }
  return { valid: false, reason: "Host name is outside the supported local namespaces" };
}
