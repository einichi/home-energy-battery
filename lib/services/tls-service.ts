import tls from "node:tls";
import path from "node:path";
import type { TlsCertificateStatus, TlsProvider, TlsView } from "../../shared/api-contracts.js";
import { normalizePublicHost } from "../domain/hostname.js";
import { readJsonFile, writeJsonFileAtomic } from "../json-file.js";

export type { TlsProvider };

export interface TlsSettings {
  hostname: string | null;
  provider: TlsProvider | null;
  acmeEmail: string | null;
  keepNonTls: boolean;
}

export interface TlsSecrets {
  cloudflareApiToken?: string;
  route53AccessKeyId?: string;
  route53SecretAccessKey?: string;
  route53Region?: string;
}

export const DEFAULT_TLS_SETTINGS: TlsSettings = {
  hostname: null,
  provider: null,
  acmeEmail: null,
  keepNonTls: false,
};

export interface CaddyfileInput {
  adminAddress: string;
  storageRoot: string;
  httpPort: number;
  httpsPort: number;
  internalPort: number;
  includeHttp: boolean;
  settings: TlsSettings;
  secrets: TlsSecrets;
}

const REMOTE_IP_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "::1",
  "fc00::/7",
  "fe80::/10",
].join(" ");

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmpty(value: unknown): string | undefined {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text ? text : undefined;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function issuerLabel(issuer: tls.PeerCertificate["issuer"] | undefined): string | null {
  if (!issuer) return null;
  const raw = issuer.O ?? issuer.CN;
  if (Array.isArray(raw)) return raw.length ? raw.join(", ") : null;
  return raw ?? null;
}

function proxyMatcher(indent: string, internalPort: number): string[] {
  return [
    `${indent}@private remote_ip ${REMOTE_IP_RANGES}`,
    `${indent}handle @private {`,
    `${indent}\treverse_proxy 127.0.0.1:${internalPort} {`,
    // Replace any client-supplied chain with the address Caddy observed, so the
    // app can trust the single forwarded value.
    `${indent}\t\theader_up X-Forwarded-For {remote_host}`,
    `${indent}\t}`,
    `${indent}}`,
    `${indent}handle {`,
    `${indent}\trespond "Forbidden" 403`,
    `${indent}}`,
  ];
}

function providerTlsBlock(provider: TlsProvider | null, secrets: TlsSecrets): string[] | null {
  if (provider === "cloudflare" && secrets.cloudflareApiToken) {
    return [
      "\ttls {",
      `\t\tdns cloudflare ${quote(secrets.cloudflareApiToken)}`,
      "\t}",
    ];
  }
  if (provider === "route53" && secrets.route53AccessKeyId && secrets.route53SecretAccessKey) {
    return [
      "\ttls {",
      "\t\tdns route53 {",
      `\t\t\taccess_key_id ${quote(secrets.route53AccessKeyId)}`,
      `\t\t\tsecret_access_key ${quote(secrets.route53SecretAccessKey)}`,
      ...(secrets.route53Region ? [`\t\t\tregion ${quote(secrets.route53Region)}`] : []),
      "\t\t}",
      "\t}",
    ];
  }
  return null;
}

/**
 * Build a Caddyfile for the app ingress. The plain-HTTP site is included only
 * when TLS is not available or the non-TLS fallback is explicitly kept. Every
 * site rejects non-private client addresses before proxying to the app, and the
 * app's `Host` allowlist remains the DNS-rebinding boundary.
 */
export function buildCaddyfile(input: CaddyfileInput): string {
  const lines: string[] = [];
  lines.push("{");
  lines.push(`\tadmin ${input.adminAddress}`);
  lines.push(`\tstorage file_system ${input.storageRoot}`);
  lines.push("\tpersist_config off");
  lines.push("\tauto_https disable_redirects");
  if (input.settings.acmeEmail) lines.push(`\temail ${quote(input.settings.acmeEmail)}`);
  lines.push("}");

  if (input.includeHttp) {
    lines.push("");
    lines.push(`:${input.httpPort} {`);
    lines.push(...proxyMatcher("\t", input.internalPort));
    lines.push("}");
  }

  if (input.settings.hostname) {
    const tlsBlock = providerTlsBlock(input.settings.provider, input.secrets) ?? ["\ttls internal"];
    lines.push("");
    lines.push(`${input.settings.hostname}:${input.httpsPort} {`);
    lines.push(...tlsBlock);
    lines.push(...proxyMatcher("\t", input.internalPort));
    lines.push("}");
  }

  return `${lines.join("\n")}\n`;
}

export function normalizeStoredSettings(value: unknown): TlsSettings {
  const source = record(value);
  const hostname = typeof source.hostname === "string" ? normalizePublicHost(source.hostname) : null;
  const provider = source.provider === "cloudflare" || source.provider === "route53" ? source.provider : null;
  const acmeEmail = nonEmpty(source.acmeEmail) ?? null;
  return { hostname, provider, acmeEmail, keepNonTls: source.keepNonTls === true };
}

/** Validate a Settings → HTTPS update, throwing a user-facing error on invalid input. */
export function normalizeRequestedSettings(input: unknown, previous: TlsSettings): TlsSettings {
  const source = record(input);
  let hostname = previous.hostname;
  if (source.hostname === null || source.hostname === "") hostname = null;
  else if (source.hostname !== undefined) {
    hostname = normalizePublicHost(source.hostname);
    if (!hostname) throw new Error("Hostname must be a publicly delegated domain name, for example hems.example.com");
  }

  let provider = previous.provider;
  if (source.provider === null || source.provider === "") provider = null;
  else if (source.provider !== undefined) {
    if (source.provider !== "cloudflare" && source.provider !== "route53") {
      throw new Error("DNS provider must be cloudflare or route53");
    }
    provider = source.provider;
  }

  let acmeEmail = previous.acmeEmail;
  if (source.acmeEmail === null || source.acmeEmail === "") acmeEmail = null;
  else if (source.acmeEmail !== undefined) {
    const email = String(source.acmeEmail).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("ACME email must be a valid email address");
    acmeEmail = email;
  }

  const keepNonTls = source.keepNonTls === undefined ? previous.keepNonTls : source.keepNonTls === true;
  return { hostname, provider, acmeEmail, keepNonTls };
}

export interface CertificateProbeInput {
  hostname: string | null;
  port: number;
  timeoutMs?: number;
}

/** Probe the local TLS listener and report whether it presents a publicly-trusted certificate. */
export function probeTrustedCertificate({
  hostname,
  port,
  timeoutMs = 4000,
}: CertificateProbeInput): Promise<TlsCertificateStatus> {
  if (!hostname) return Promise.resolve({ trusted: false, hostname: null, issuer: null, notAfter: null, error: null });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: TlsCertificateStatus) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const socket = tls.connect(
      { host: "127.0.0.1", port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const certificate = socket.getPeerCertificate();
        if (!certificate || !certificate.valid_to) {
          finish({ trusted: false, hostname, issuer: null, notAfter: null, error: "no certificate" });
          return;
        }
        finish({
          trusted: socket.authorized === true,
          hostname,
          issuer: issuerLabel(certificate.issuer),
          notAfter: new Date(certificate.valid_to).toISOString(),
          error: socket.authorized === true ? null : String(socket.authorizationError ?? "certificate is not trusted"),
        });
      },
    );
    socket.on("timeout", () => finish({ trusted: false, hostname, issuer: null, notAfter: null, error: "timeout" }));
    socket.on("error", (error: Error) => finish({ trusted: false, hostname, issuer: null, notAfter: null, error: error.message }));
  });
}

export interface ServerDocumentStore {
  isReady(): boolean;
  readDocument(key: "serverSettings", fallback: Record<string, unknown>): Record<string, unknown>;
  writeDocument(key: "serverSettings", value: Record<string, unknown>): Record<string, unknown>;
}

export interface TlsServiceOptions {
  dataDir: string;
  applicationStore: ServerDocumentStore;
  httpPort: number;
  httpsPort: number;
  adminAddress?: string;
  request?: typeof fetch;
  probeCertificate?: (input: CertificateProbeInput) => Promise<TlsCertificateStatus>;
  now?: () => Date;
  logError?: (scope: string, error: unknown) => void;
  refreshIntervalMs?: number;
}

const EMPTY_TRUSTED_HOSTS: ReadonlySet<string> = new Set();

export function createTlsService(options: TlsServiceOptions) {
  const {
    dataDir,
    applicationStore,
    httpPort,
    httpsPort,
    adminAddress = "127.0.0.1:2019",
    now = () => new Date(),
    logError,
    refreshIntervalMs = 5 * 60_000,
  } = options;
  const request = options.request ?? fetch;
  const probe = options.probeCertificate ?? probeTrustedCertificate;
  const secretsFile = path.join(dataDir, "tls-secrets.json");
  const storageRoot = path.join(dataDir, "caddy");
  // Caddy's admin endpoint rejects requests that carry a Sec-Fetch-Mode header
  // (Node's fetch sends `cors`) unless an allowed Origin header is present.
  const adminOrigin = `http://${adminAddress}`;

  let internalPort: number | null = null;
  let cachedSettings: TlsSettings | null = null;
  let certificate: TlsCertificateStatus = { trusted: false, hostname: null, issuer: null, notAfter: null, error: null };
  let lastAppliedAt: string | null = null;
  let applyError: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  function loadSettings(): TlsSettings {
    if (cachedSettings) return cachedSettings;
    try {
      if (!applicationStore.isReady()) return { ...DEFAULT_TLS_SETTINGS };
      const document = record(applicationStore.readDocument("serverSettings", {}));
      cachedSettings = normalizeStoredSettings(document.tls);
    } catch (error) {
      logError?.("tls.settings", error);
      cachedSettings = { ...DEFAULT_TLS_SETTINGS };
    }
    return cachedSettings;
  }

  function persistSettings(settings: TlsSettings): void {
    const document = record(applicationStore.readDocument("serverSettings", {}));
    applicationStore.writeDocument("serverSettings", { ...document, tls: settings });
    cachedSettings = settings;
  }

  async function readSecrets(): Promise<TlsSecrets> {
    const value = record(await readJsonFile(secretsFile, {}));
    return {
      cloudflareApiToken: nonEmpty(value.cloudflareApiToken),
      route53AccessKeyId: nonEmpty(value.route53AccessKeyId),
      route53SecretAccessKey: nonEmpty(value.route53SecretAccessKey),
      route53Region: nonEmpty(value.route53Region),
    };
  }

  async function writeSecrets(secrets: TlsSecrets): Promise<void> {
    const clean = Object.fromEntries(Object.entries(secrets).filter(([, value]) => Boolean(value)));
    await writeJsonFileAtomic(secretsFile, clean, 0o600);
  }

  async function updateSecrets(input: Record<string, unknown>): Promise<void> {
    const secrets = await readSecrets();
    if (input.clearSecrets === true) {
      await writeSecrets({});
      return;
    }
    const incoming = record(input.secrets);
    const next: TlsSecrets = { ...secrets };
    const assign = (key: keyof TlsSecrets, value: unknown) => {
      if (value === undefined) return;
      if (value === null || String(value) === "") delete next[key];
      else next[key] = String(value).trim();
    };
    assign("cloudflareApiToken", incoming.cloudflareApiToken);
    assign("route53AccessKeyId", incoming.route53AccessKeyId);
    assign("route53SecretAccessKey", incoming.route53SecretAccessKey);
    assign("route53Region", incoming.route53Region);
    await writeSecrets(next);
  }

  async function caddyReachable(): Promise<boolean> {
    try {
      const response = await request(`http://${adminAddress}/config/`, {
        method: "GET",
        headers: { origin: adminOrigin },
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function includeHttpFor(settings: TlsSettings, certificateTrusted: boolean): boolean {
    return settings.keepNonTls || !certificateTrusted || !settings.hostname;
  }

  async function apply(): Promise<void> {
    const settings = loadSettings();
    const secrets = await readSecrets();
    certificate = await probe({ hostname: settings.hostname, port: httpsPort });
    const includeHttp = includeHttpFor(settings, certificate.trusted);
    if (internalPort === null) {
      applyError = "Internal listener is not ready";
      return;
    }
    const caddyfile = buildCaddyfile({
      adminAddress,
      storageRoot,
      httpPort,
      httpsPort,
      internalPort,
      includeHttp,
      settings,
      secrets,
    });
    const reachable = await caddyReachable();
    if (!reachable) {
      applyError = "Caddy is not reachable";
      return;
    }
    // `/load` is idempotent and graceful; applying on every pass also re-applies
    // the site after an independent Caddy restart (persist_config is off).
    try {
      const response = await request(`http://${adminAddress}/load`, {
        method: "POST",
        headers: { "content-type": "text/caddyfile", origin: adminOrigin },
        body: caddyfile,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Caddy rejected the configuration (${response.status})`);
      applyError = null;
      lastAppliedAt = now().toISOString();
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
      logError?.("tls.apply", error);
    }
  }

  async function update(input: Record<string, unknown>): Promise<TlsView> {
    const previous = loadSettings();
    const settings = normalizeRequestedSettings(input, previous);
    persistSettings(settings);
    if (input.secrets !== undefined || input.clearSecrets === true) {
      await updateSecrets(input);
    }
    await apply();
    return view();
  }

  async function refresh(): Promise<TlsView> {
    await apply();
    return view();
  }

  async function view(): Promise<TlsView> {
    const settings = loadSettings();
    const secrets = await readSecrets();
    const reachable = await caddyReachable();
    const includeHttp = includeHttpFor(settings, certificate.trusted);
    const warning = settings.hostname && certificate.trusted && includeHttp
      ? "Non-TLS HTTP access is still enabled while a trusted certificate is active. Keep it only if you need the lockout fallback."
      : null;
    return {
      hostname: settings.hostname,
      provider: settings.provider,
      acmeEmail: settings.acmeEmail,
      keepNonTls: settings.keepNonTls,
      configured: Boolean(settings.hostname),
      secrets: {
        cloudflare: Boolean(secrets.cloudflareApiToken),
        route53: Boolean(secrets.route53AccessKeyId && secrets.route53SecretAccessKey),
      },
      caddyReachable: reachable,
      httpPort,
      httpsPort,
      certificate,
      httpFallbackActive: includeHttp,
      warning,
      applyError,
      lastAppliedAt,
    };
  }

  function setInternalPort(port: number): void {
    internalPort = port;
  }

  /** Hostnames the HTTP layer should accept in addition to the local namespaces. */
  function trustedHosts(): ReadonlySet<string> {
    const settings = loadSettings();
    return settings.hostname ? new Set([settings.hostname]) : EMPTY_TRUSTED_HOSTS;
  }

  async function start(): Promise<void> {
    await apply();
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void apply().catch((error) => logError?.("tls.refresh", error));
    }, refreshIntervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    apply,
    refresh,
    setInternalPort,
    start,
    stop,
    trustedHosts,
    update,
    view,
  };
}

export type TlsService = ReturnType<typeof createTlsService>;
