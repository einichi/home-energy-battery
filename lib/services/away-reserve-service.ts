import type { ApplicationConfig } from "../contracts/configuration.js";
import type { AwayPeriod } from "../contracts/away-period.js";
import { cleanAwayReserveState, continuousAwayWindow, ownsAwayReserve, reservePercent, type AwayReserveState } from "../domain/away-reserve.js";
import { asRecord, errorMessage } from "../domain/values.js";
import { isDocumentationHost } from "../domain/status-alerts.js";

interface AwayReserveDependencies {
  documents: {
    readDocument(key: "awayReserveState", fallback: Record<string, unknown>): Record<string, unknown>;
    writeDocument(key: "awayReserveState", value: Record<string, unknown>): unknown;
  };
  readConfig(): Promise<ApplicationConfig>;
  setEnabled(enabled: boolean): Promise<unknown>;
  periods(): AwayPeriod[];
  backupActive(): Promise<boolean>;
  readReserve(host: string): Promise<unknown>;
  executeAction(action: string, payload: Record<string, unknown>, options: { source: string }): Promise<unknown>;
  reserveVerified(percent: number, host: string): Promise<void>;
  allowDocumentationHosts?: boolean;
  now?: () => Date;
}

export function createAwayReserveService(dependencies: AwayReserveDependencies) {
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let deadline: number | null = null;
  let activeCount = 0;
  let timersEnabled = true;
  const now = dependencies.now ?? (() => new Date());
  const read = () => cleanAwayReserveState(dependencies.documents.readDocument("awayReserveState", {}));
  function save(state: AwayReserveState): AwayReserveState {
    const result = { ...state, updatedAt: now().toISOString() };
    dependencies.documents.writeDocument("awayReserveState", result);
    return result;
  }
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    activeCount += 1;
    const task = queue.then(operation).finally(() => { activeCount -= 1; });
    queue = task.catch(() => undefined);
    return task;
  }
  async function actualReserve(host: string): Promise<number> {
    const result = asRecord(await dependencies.readReserve(host));
    const percent = reservePercent(asRecord(result.decoded).percent);
    if (result.error || percent === null) throw new Error("The battery minimum reserve could not be read reliably");
    return percent;
  }
  async function setReserve(percent: number, host: string, restoring: boolean): Promise<void> {
    await dependencies.executeAction("discharge-limit", { host, percent }, { source: restoring ? "away-reserve-restore" : "away-reserve" });
    if (await actualReserve(host) !== percent) throw new Error(`Battery reserve verification failed: expected ${percent}%`);
    await dependencies.reserveVerified(percent, host);
  }
  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null; deadline = null;
  }
  function arm(periods: AwayPeriod[], state: AwayReserveState, enabled: boolean): void {
    if (!timersEnabled) return;
    const at = now().getTime();
    const times = enabled ? periods.flatMap((period) => [Date.parse(period.from), Date.parse(period.until)]) : [];
    if (state.retryAt) times.push(Date.parse(state.retryAt));
    const next = Math.min(...times.filter((time) => Number.isFinite(time) && time > at));
    if (!Number.isFinite(next)) { clearTimer(); return; }
    if (deadline === next && timer) return;
    clearTimer(); deadline = next;
    timer = setTimeout(() => {
      timer = null; deadline = null;
      void reconcile(true).catch(() => { /* The next regular automation tick also retries. */ });
    }, Math.min(2_147_000_000, next - at));
    timer.unref();
  }
  async function view() {
    const config = await dependencies.readConfig();
    const state = read();
    return { enabled: config.awayReserveEnabled, ...state, ownsReserve: ownsAwayReserve(state) };
  }

  async function reconcile(force = false) {
    return exclusive(async () => {
      const config = await dependencies.readConfig();
      const periods = dependencies.periods();
      const window = continuousAwayWindow(periods, now());
      const backup = await dependencies.backupActive();
      let state = read();
      const manualBlocked = window !== null && state.manualWindowFrom === window.from && state.manualHost === config.batteryHost;
      const desired = config.awayReserveEnabled && window !== null && !backup && !manualBlocked;
      const sameWindow = () => window !== null && state.windowFrom === window.from;
      try {
        if (["applying", "active", "restoring"].includes(state.phase) && !ownsAwayReserve(state)) {
          throw new Error("Saved Away reserve recovery information is incomplete; the battery setting was left unchanged");
        }
        if (!force && state.retryAt && Date.parse(state.retryAt) > now().getTime()) return await view();
        if (state.phase === "manual-pending") {
          const observed = await actualReserve(state.host!);
          state = save({ ...state, phase: observed === state.manualRequestedPercent || observed !== 0 ? "manual" : "active", lastError: null, retryAt: null });
        }
        if (state.phase === "manual") {
          if (sameWindow() && state.host === config.batteryHost) {
            save({ ...state, windowUntil: window!.until });
            return await view();
          }
          state = save(cleanAwayReserveState());
        }
        if (ownsAwayReserve(state) && (!desired || !sameWindow() || state.host !== config.batteryHost || state.phase === "restoring")) {
          state = save({ ...state, phase: "restoring" });
          const observed = await actualReserve(state.host!);
          if (observed !== 0 && observed !== state.previousPercent) {
            // An external change supersedes our temporary override, even while offline.
            await dependencies.reserveVerified(observed, state.host!);
            state = save({ ...state, phase: "manual", lastError: null, retryAt: null });
            if (sameWindow() && state.host === config.batteryHost) return await view();
          } else {
            state = save({ ...state, phase: "restoring", lastError: null, retryAt: null });
            if (observed !== state.previousPercent) await setReserve(state.previousPercent!, state.host!, true);
            else await dependencies.reserveVerified(observed, state.host!);
          }
          state = save(manualBlocked ? { ...cleanAwayReserveState(), phase: "manual", host: config.batteryHost,
            windowFrom: window!.from, windowUntil: window!.until }
            : backup && window && config.awayReserveEnabled ? { ...state, phase: "suspended", lastError: null, retryAt: null }
              : cleanAwayReserveState());
        }
        if (!desired) {
          if (manualBlocked) return await view();
          if (backup && window && config.awayReserveEnabled) {
            if (state.phase !== "suspended") save({ ...state, phase: "suspended", windowFrom: window.from, windowUntil: window.until, lastError: null, retryAt: null });
          } else if (!ownsAwayReserve(state) && (state.phase !== "idle" || state.lastError)) save(cleanAwayReserveState());
          return await view();
        }
        if (!config.batteryHost || (isDocumentationHost(config.batteryHost) && !dependencies.allowDocumentationHosts)) {
          throw new Error("Configure a battery address before enabling the Away reserve override");
        }
        if (ownsAwayReserve(state)) {
          const observed = await actualReserve(state.host!);
          if (observed !== 0 && !(state.phase === "applying" && observed === state.previousPercent)) {
            await dependencies.reserveVerified(observed, state.host!);
            save({ ...state, phase: "manual", windowUntil: window!.until, lastError: null, retryAt: null });
            return await view();
          }
          if (observed !== 0) await setReserve(0, state.host!, false);
          else if (state.phase === "applying" || reservePercent(asRecord(config.settingCache.discharge_limit?.lastKnown.decoded).percent) !== 0) {
            await dependencies.reserveVerified(0, state.host!);
          }
        } else {
          const previousPercent = await actualReserve(config.batteryHost);
          // This durable write MUST finish before the first device write.
          state = save({ ...cleanAwayReserveState(), phase: "applying", host: config.batteryHost, previousPercent,
            windowFrom: window!.from, windowUntil: window!.until });
          if (previousPercent !== 0) await setReserve(0, state.host!, false);
          else await dependencies.reserveVerified(0, state.host!);
        }
        save({ ...state, phase: "active", windowUntil: window!.until, lastError: null, retryAt: null });
      } catch (error: unknown) {
        state = read();
        save({ ...state, lastError: errorMessage(error), retryAt: new Date(now().getTime() + 30_000).toISOString() });
      } finally {
        arm(periods, read(), config.awayReserveEnabled);
      }
      return view();
    });
  }

  /** Serialize deliberate reserve changes with the entire write + readback workflow. */
  async function withCommand<T>(action: string, payload: Record<string, unknown>, source: string, operation: () => Promise<T>): Promise<T> {
    if (action !== "discharge-limit" || source === "away-reserve" || source === "away-reserve-restore") return operation();
    return exclusive(async () => {
      const config = await dependencies.readConfig();
      const before = read();
      const host = String(payload.host || config.batteryHost);
      const window = continuousAwayWindow(dependencies.periods(), now());
      const percent = reservePercent(payload.percent);
      const affected = percent !== null && ((ownsAwayReserve(before) && before.host === host)
        || (config.awayReserveEnabled && window !== null && host === config.batteryHost));
      const differentBattery = affected && ownsAwayReserve(before) && before.host !== host;
      if (affected) save(differentBattery
        ? { ...before, manualWindowFrom: window!.from, manualHost: host }
        : { ...before, phase: "manual-pending", host,
          windowFrom: window?.from ?? before.windowFrom, windowUntil: window?.until ?? before.windowUntil,
          manualRequestedPercent: percent });
      let result: T;
      try { result = await operation(); }
      catch (error: unknown) {
        if (affected) save(before);
        throw error;
      }
      if (affected) {
        save({ ...read(), phase: differentBattery ? before.phase : "manual", lastError: null, retryAt: null });
        await dependencies.reserveVerified(percent!, host);
      }
      return result;
    });
  }
  return {
    reconcile, view, withCommand,
    activeCount: () => activeCount,
    start: () => { timersEnabled = true; },
    stop: () => { timersEnabled = false; clearTimer(); },
    setEnabled: async (enabled: boolean) => { await dependencies.setEnabled(enabled); return reconcile(true); },
  };
}
