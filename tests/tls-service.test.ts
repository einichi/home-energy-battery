import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCaddyfile,
  createTlsService,
  DEFAULT_TLS_SETTINGS,
  normalizeRequestedSettings,
  normalizeStoredSettings,
  type CaddyfileInput,
} from "../lib/services/tls-service.js";

function caddyfile(overrides: Partial<CaddyfileInput> = {}): string {
  return buildCaddyfile({
    adminAddress: "127.0.0.1:2019",
    storageRoot: "/data/caddy",
    httpPort: 8787,
    httpsPort: 443,
    internalPort: 40_000,
    includeHttp: true,
    settings: { hostname: "hems.example.com", provider: "cloudflare", acmeEmail: "me@example.com", keepNonTls: true },
    secrets: { cloudflareApiToken: "token-123" },
    ...overrides,
  });
}

const withHttp = caddyfile();
assert.match(withHttp, /admin 127\.0\.0\.1:2019/);
assert.match(withHttp, /storage file_system \/data\/caddy/);
assert.match(withHttp, /persist_config off/);
assert.match(withHttp, /auto_https disable_redirects/);
assert.match(withHttp, /:8787 \{/);
assert.match(withHttp, /hems\.example\.com:443 \{/);
assert.match(withHttp, /dns cloudflare "token-123"/);
assert.match(withHttp, /reverse_proxy 127\.0\.0\.1:40000/);
assert.match(withHttp, /remote_ip/);
assert.match(withHttp, /respond "Forbidden" 403/);

const httpsOnly = caddyfile({ includeHttp: false });
assert.doesNotMatch(httpsOnly, /:8787 \{/);
assert.match(httpsOnly, /hems\.example\.com:443 \{/);

// Missing credentials fall back to Caddy's internal issuer.
const internalIssuer = caddyfile({ settings: { hostname: "hems.example.com", provider: "cloudflare", acmeEmail: null, keepNonTls: false }, secrets: {} });
assert.match(internalIssuer, /tls internal/);

// Route53 credentials are rendered inline.
const route53 = caddyfile({
  settings: { hostname: "hems.example.com", provider: "route53", acmeEmail: null, keepNonTls: false },
  secrets: { route53AccessKeyId: "AKIA", route53SecretAccessKey: "secret", route53Region: "us-east-1" },
});
assert.match(route53, /dns route53 \{/);
assert.match(route53, /access_key_id "AKIA"/);
assert.match(route53, /secret_access_key "secret"/);
assert.match(route53, /region "us-east-1"/);

// Settings validation.
assert.throws(() => normalizeRequestedSettings({ hostname: "192.168.1.1" }, DEFAULT_TLS_SETTINGS), /domain name/);
assert.throws(() => normalizeRequestedSettings({ hostname: "hems.local" }, DEFAULT_TLS_SETTINGS), /domain name/);
assert.throws(() => normalizeRequestedSettings({ provider: "bogus" }, DEFAULT_TLS_SETTINGS), /provider/);
assert.throws(() => normalizeRequestedSettings({ acmeEmail: "not-an-email" }, DEFAULT_TLS_SETTINGS), /email/);
assert.deepEqual(
  normalizeRequestedSettings({ hostname: "HEMS.Example.com", provider: "cloudflare", acmeEmail: "me@example.com", keepNonTls: true }, DEFAULT_TLS_SETTINGS),
  { hostname: "hems.example.com", provider: "cloudflare", acmeEmail: "me@example.com", keepNonTls: true },
);
assert.deepEqual(normalizeRequestedSettings({ hostname: null }, { hostname: "hems.example.com", provider: null, acmeEmail: null, keepNonTls: true }), {
  hostname: null,
  provider: null,
  acmeEmail: null,
  keepNonTls: true,
});
assert.deepEqual(normalizeStoredSettings({ hostname: "HEMS.example.com", keepNonTls: true }), {
  hostname: "hems.example.com",
  provider: null,
  acmeEmail: null,
  keepNonTls: true,
});

// Service round-trip with a fake store, Caddy admin, and certificate probe.
const dataDir = await mkdtemp(path.join(os.tmpdir(), "home-energy-battery-tls-"));
try {
  const documents = new Map<string, Record<string, unknown>>();
  const store = {
    isReady: () => true,
    readDocument: (key: string, fallback: Record<string, unknown>) => documents.get(key) ?? fallback,
    writeDocument: (key: string, value: Record<string, unknown>) => {
      documents.set(key, value);
      return value;
    },
  } as never;
  let loaded: string | null = null;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.endsWith("/config/")) return new Response("{}", { status: 200 });
    if (url.endsWith("/load")) {
      loaded = String(init?.body ?? "");
      return new Response("", { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const service = createTlsService({
    dataDir,
    applicationStore: store,
    httpPort: 8787,
    httpsPort: 443,
    request: fetchImpl,
    probeCertificate: async () => ({ trusted: false, hostname: null, issuer: null, notAfter: null, error: null }),
    now: () => new Date("2024-01-01T00:00:00.000Z"),
  });
  service.setInternalPort(45_000);

  const view = await service.update({
    hostname: "hems.example.com",
    provider: "cloudflare",
    acmeEmail: "me@example.com",
    keepNonTls: true,
    secrets: { cloudflareApiToken: "secret-value" },
  });
  assert.equal(view.hostname, "hems.example.com");
  assert.equal(view.configured, true);
  assert.equal(view.secrets.cloudflare, true);
  assert.equal(view.applyError, null);
  assert.equal(loaded !== null, true);
  assert.match(String(loaded), /dns cloudflare/);
  assert.match(String(loaded), /reverse_proxy 127\.0\.0\.1:45000/);
  assert.deepEqual([...service.trustedHosts()], ["hems.example.com"]);

  const secrets = JSON.parse(await readFile(path.join(dataDir, "tls-secrets.json"), "utf8"));
  assert.equal(secrets.cloudflareApiToken, "secret-value");

  // Clearing the hostname removes the trusted host and the HTTPS site.
  const cleared = await service.update({ hostname: null, clearSecrets: true });
  assert.equal(cleared.hostname, null);
  assert.equal(cleared.configured, false);
  assert.equal(cleared.secrets.cloudflare, false);
  assert.deepEqual([...service.trustedHosts()], []);
  assert.doesNotMatch(loaded ?? "", /hems\.example\.com/);

  service.stop();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("TLS service tests passed");
