import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { TlsView } from "../../api/contracts";
import { applyTls, getTls, saveTls } from "../../api/system";
import { T, useI18n } from "../../i18n";

type Result = { ok: boolean; message: string } | null;

export function PublicHttpsSettings() {
  const { text } = useI18n();
  const [view, setView] = useState<TlsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [provider, setProvider] = useState("");

  useEffect(() => {
    let active = true;
    getTls()
      .then((next) => {
        if (!active) return;
        setView(next);
        setProvider(next.provider ?? "");
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Unable to load HTTPS settings.");
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const next = await saveTls({
        hostname: String(data.get("hostname") ?? ""),
        provider: String(data.get("provider") ?? ""),
        acmeEmail: String(data.get("acmeEmail") ?? ""),
        keepNonTls: data.get("keepNonTls") === "on",
        clearSecrets: data.get("clearSecrets") === "on",
        secrets: {
          cloudflareApiToken: String(data.get("cloudflareApiToken") ?? ""),
          route53AccessKeyId: String(data.get("route53AccessKeyId") ?? ""),
          route53SecretAccessKey: String(data.get("route53SecretAccessKey") ?? ""),
          route53Region: String(data.get("route53Region") ?? ""),
        },
      });
      setView(next);
      setProvider(next.provider ?? "");
      setResult({ ok: true, message: "HTTPS settings saved." });
    } catch (error: unknown) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const next = await applyTls();
      setView(next);
      setResult({ ok: true, message: "Certificate status refreshed." });
    } catch (error: unknown) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "Refresh failed" });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="panel">
        <p role="alert">{loadError}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="panel automation-empty">
        <T text={"Loading HTTPS settings…"} />
      </div>
    );
  }

  const certificate = view.certificate;
  return (
    <form className="panel system-form" onSubmit={submit} aria-busy={busy}>
      <div className="section-heading">
        <div>
          <h2>
            <T text={"HTTPS & trusted hostname"} />
          </h2>
          <p>
            <T
              text={
                "Serve this app over HTTPS at a publicly delegated domain that resolves to your LAN address. The domain is trusted by exact name; every other public name stays rejected."
              }
            />
          </p>
        </div>
      </div>

      {view.applyError ? (
        <div className="status-banner" data-severity="critical" role="alert">
          <T text={"Caddy: "} />
          {view.applyError}
        </div>
      ) : null}
      {view.warning ? (
        <div className="status-banner" data-severity="warning" role="status">
          {text(view.warning)}
        </div>
      ) : null}

      <div className="automation-form-grid">
        <label className="field">
          <T text={"Trusted hostname"} />
          <input
            name="hostname"
            type="text"
            placeholder="hems.example.com"
            defaultValue={view.hostname ?? ""}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <T text={"DNS provider"} />
          <select name="provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">{text("None")}</option>
            <option value="cloudflare">Cloudflare</option>
            <option value="route53">Route 53</option>
          </select>
        </label>
        <label className="field">
          <T text={"ACME email"} />
          <input
            name="acmeEmail"
            type="email"
            placeholder="you@example.com"
            defaultValue={view.acmeEmail ?? ""}
            autoComplete="off"
          />
        </label>
      </div>

      {provider === "cloudflare" ? (
        <label className="field">
          <T text={"Cloudflare API token"} />
          <input
            name="cloudflareApiToken"
            type="password"
            placeholder={view.secrets.cloudflare ? text("Saved — leave blank to keep") : ""}
            autoComplete="off"
          />
        </label>
      ) : null}
      {provider === "route53" ? (
        <div className="automation-form-grid">
          <label className="field">
            <T text={"AWS access key ID"} />
            <input
              name="route53AccessKeyId"
              type="text"
              placeholder={view.secrets.route53 ? text("Saved — leave blank to keep") : ""}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <T text={"AWS secret access key"} />
            <input name="route53SecretAccessKey" type="password" autoComplete="off" />
          </label>
          <label className="field">
            <T text={"AWS region"} />
            <input name="route53Region" type="text" placeholder="us-east-1" autoComplete="off" />
          </label>
        </div>
      ) : null}

      <fieldset>
        <label>
          <input name="keepNonTls" type="checkbox" defaultChecked={view.keepNonTls} />
          <span>
            <T text={"Keep non-TLS HTTP access as a lockout fallback"} />
          </span>
        </label>
        <p className="field-help">
          <T
            text={
              "The fallback is always available until a trusted certificate exists. Keep it on to stay reachable if certificate renewal later fails."
            }
          />
        </p>
        <label>
          <input name="clearSecrets" type="checkbox" />
          <span>
            <T text={"Remove saved DNS credentials"} />
          </span>
        </label>
      </fieldset>

      <div className="form-footer">
        <button className="button primary" disabled={busy}>
          <T text={"Save HTTPS settings"} />
        </button>
        <button className="button" type="button" onClick={refresh} disabled={busy}>
          <T text={"Refresh certificate status"} />
        </button>
        {result ? (
          <span className="form-result" data-ok={result.ok} role="status">
            {text(result.message)}
          </span>
        ) : null}
      </div>

      <fieldset>
        <legend>
          <T text={"Status"} />
        </legend>
        <dl className="system-status-list">
          <div>
            <dt>
              <T text={"Caddy"} />
            </dt>
            <dd>{view.caddyReachable ? text("Reachable") : text("Not reachable")}</dd>
          </div>
          <div>
            <dt>
              <T text={"Certificate"} />
            </dt>
            <dd>
              {certificate.trusted
                ? `${text("Trusted")}${certificate.issuer ? ` · ${certificate.issuer}` : ""}${certificate.notAfter ? ` · ${certificate.notAfter}` : ""}`
                : certificate.error
                  ? `${text("Not trusted")} · ${certificate.error}`
                  : text("Not trusted")}
            </dd>
          </div>
          <div>
            <dt>
              <T text={"Non-TLS fallback"} />
            </dt>
            <dd>{view.httpFallbackActive ? text("Active") : text("Off")}</dd>
          </div>
          <div>
            <dt>
              <T text={"Listening ports"} />
            </dt>
            <dd>
              {text("HTTPS")} {view.httpsPort} · {text("HTTP")} {view.httpPort}
            </dd>
          </div>
        </dl>
      </fieldset>
    </form>
  );
}
