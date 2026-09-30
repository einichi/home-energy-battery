import type { DatabaseSync } from "node:sqlite";

export interface GasTariffBand extends Record<string, unknown> { yenPerM3?: number }
export interface GasTariffPayload extends Record<string, unknown> { bands?: GasTariffBand[] }
export interface GasTariffRecord extends Record<string, unknown> {
  provider: string;
  billingMonth: string;
  bands: GasTariffBand[];
}

interface Dependencies { database(): DatabaseSync }

function parsePayload(value: unknown): GasTariffPayload {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as GasTariffPayload
      : {};
  } catch {
    return {};
  }
}

export function createGasTariffRepository(dependencies: Dependencies) {
  function snapshots({ provider = "tokyo-gas", billingMonth = null }: { provider?: string; billingMonth?: string | null } = {}): GasTariffRecord[] {
    const rows = billingMonth
      ? dependencies.database().prepare(`
          SELECT provider, billing_month, version, fetched_at, source_url, source_hash, payload_json
          FROM gas_tariff_snapshots WHERE provider = ? AND billing_month = ? ORDER BY version DESC
        `).all(provider, billingMonth)
      : dependencies.database().prepare(`
          SELECT provider, billing_month, version, fetched_at, source_url, source_hash, payload_json
          FROM gas_tariff_snapshots WHERE provider = ? ORDER BY billing_month DESC, version DESC
        `).all(provider);
    return rows.map((row): GasTariffRecord => {
      const payload = parsePayload(row.payload_json);
      return {
        provider: String(row.provider ?? ""), billingMonth: String(row.billing_month ?? ""),
        version: row.version, fetchedAt: row.fetched_at, sourceUrl: row.source_url, sourceHash: row.source_hash,
        ...payload, bands: payload.bands ?? [],
      };
    });
  }

  function recordSnapshot(snapshot: { provider: string; billingMonth: string; sourceHash: string; fetchedAt?: string; sourceUrl?: string | null; payload: GasTariffPayload }): GasTariffRecord & Record<string, unknown> {
    const existing = dependencies.database().prepare(`
      SELECT version, payload_json, fetched_at, source_url FROM gas_tariff_snapshots
      WHERE provider = ? AND billing_month = ? AND source_hash = ? ORDER BY version DESC LIMIT 1
    `).get(snapshot.provider, snapshot.billingMonth, snapshot.sourceHash);
    if (existing) {
      const payload = parsePayload(existing.payload_json);
      return { unchanged: true, provider: snapshot.provider, billingMonth: snapshot.billingMonth, version: existing.version, ...payload, bands: payload.bands ?? [] };
    }
    const versionRow = dependencies.database().prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version FROM gas_tariff_snapshots
      WHERE provider = ? AND billing_month = ?
    `).get(snapshot.provider, snapshot.billingMonth) as { version?: unknown } | undefined;
    const version = Number(versionRow?.version);
    const fetchedAt = snapshot.fetchedAt ?? new Date().toISOString();
    dependencies.database().prepare(`
      INSERT INTO gas_tariff_snapshots(provider, billing_month, version, fetched_at_ms, fetched_at, source_url, source_hash, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(snapshot.provider, snapshot.billingMonth, version, new Date(fetchedAt).getTime(), fetchedAt, snapshot.sourceUrl ?? null, snapshot.sourceHash, JSON.stringify(snapshot.payload));
    return { ...snapshot.payload, provider: snapshot.provider, billingMonth: snapshot.billingMonth, version, fetchedAt, sourceUrl: snapshot.sourceUrl ?? null, sourceHash: snapshot.sourceHash, bands: snapshot.payload.bands ?? [] };
  }

  function override(provider: string = "tokyo-gas", billingMonth: string): (GasTariffRecord & Record<string, unknown>) | null {
    const row = dependencies.database().prepare("SELECT updated_at, payload_json FROM gas_tariff_overrides WHERE provider = ? AND billing_month = ?").get(provider, billingMonth);
    if (!row) return null;
    const payload = parsePayload(row.payload_json);
    return { provider, billingMonth, updatedAt: row.updated_at, ...payload, bands: payload.bands ?? [] };
  }

  function setOverride(provider: string, billingMonth: string, payload: GasTariffPayload): GasTariffRecord & Record<string, unknown> {
    const updatedAt = new Date().toISOString();
    dependencies.database().prepare(`
      INSERT INTO gas_tariff_overrides(provider, billing_month, updated_at_ms, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, billing_month) DO UPDATE SET
        updated_at_ms = excluded.updated_at_ms, updated_at = excluded.updated_at, payload_json = excluded.payload_json
    `).run(provider, billingMonth, Date.now(), updatedAt, JSON.stringify(payload));
    return { provider, billingMonth, updatedAt, ...payload, bands: payload.bands ?? [] };
  }

  function deleteOverride(provider: string, billingMonth: string): boolean {
    return Number(dependencies.database().prepare("DELETE FROM gas_tariff_overrides WHERE provider = ? AND billing_month = ?").run(provider, billingMonth).changes) > 0;
  }

  return { deleteOverride, override, recordSnapshot, setOverride, snapshots };
}
