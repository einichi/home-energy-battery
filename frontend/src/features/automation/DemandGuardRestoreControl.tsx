import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { restoreDemandGuard } from "../../api/automation";
import { getBackupPreparation } from "../../api/battery";
import type { AutomationRule } from "../../api/contracts";
import { formatDateTimesInText, formatNumber, formatPower, metricValue } from "../../core/format";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";

type RestoreOutcome = { ok: boolean; at: number; detail?: string } | null;
type PolicyCheck = { blocked: boolean; error: string | null } | null;
type RestoreProps = {
  rules: AutomationRule[];
  rulesError?: string | null;
  onRestored: (rules: AutomationRule[]) => void;
  refreshRules: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
};

/** Visible only for an unresolved intervention or the 30-second result of a manual restore. */
export function DemandGuardRestoreControl({ rules, rulesError, onRestored, refreshRules, returnFocusRef }: RestoreProps) {
  const { t } = useTranslation("automation");
  const { status, refresh: refreshStatus } = useEnergyStatus();
  const headingId = useId();
  const hintId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingLatch = useRef(false);
  const restoreFocused = useRef(false);
  const [hasRestored, setHasRestored] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<RestoreOutcome>(null);
  const [policy, setPolicy] = useState<PolicyCheck>(null);
  const [policyRevision, setPolicyRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const guard = rules.find((rule) => rule.type === "backup-demand-guard" && rule.enabled !== false && rule.state?.awaitingRestore === true);
  const awaitingRestore = Boolean(guard);
  const restoreSince = guard?.state?.restoreSince;
  const recoveryStarted = restoreSince ? new Date(restoreSince).getTime() : Number.NaN;
  const success = outcome?.ok === true && !awaitingRestore;

  useEffect(() => {
    if (!guard) return;
    const controller = new AbortController();
    void getBackupPreparation(controller.signal).then(
      (backup) => {
        if (!controller.signal.aborted) setPolicy({ blocked: backup.active && backup.allowDemandGuard === false, error: null });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setPolicy({ blocked: false, error: reason instanceof Error ? reason.message : "" });
      },
    );
    return () => controller.abort();
  }, [guard, policyRevision]);

  useEffect(() => {
    if (!awaitingRestore || !Number.isFinite(recoveryStarted)) return;
    let stopped = false;
    // Start with a fresh clock before the next paint; hidden panels do not tick.
    queueMicrotask(() => { if (!stopped) setNow(Date.now()); });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [awaitingRestore, recoveryStarted]);

  useEffect(() => {
    if (!outcome?.ok || !awaitingRestore) return;
    // A new intervention invalidates the previous success, even if it recovers before the old timeout.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOutcome(null);
  }, [awaitingRestore, outcome]);

  useEffect(() => {
    if (!success || !outcome) return;
    const timer = window.setTimeout(() => {
      if (panelRef.current?.contains(document.activeElement)) returnFocusRef.current?.focus({ preventScroll: true });
      setOutcome(null);
    }, Math.max(0, outcome.at + 30_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [success, outcome, returnFocusRef]);

  useEffect(() => {
    if (!outcome || !restoreFocused.current) return;
    restoreFocused.current = false;
    if (document.activeElement === document.body || panelRef.current?.contains(document.activeElement)) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [outcome]);

  const refresh = () => {
    refreshRules();
    refreshStatus();
    setPolicyRevision((revision) => revision + 1);
  };

  const restore = async () => {
    if (pendingLatch.current) return;
    pendingLatch.current = true;
    restoreFocused.current = panelRef.current?.contains(document.activeElement) ?? false;
    setPending(true);
    setOutcome(null);
    try {
      const nextRules = await restoreDemandGuard();
      const at = Date.now();
      setHasRestored(true);
      onRestored(nextRules);
      setOutcome({ ok: true, at });
    } catch (reason) {
      setOutcome({ ok: false, at: Date.now(), detail: reason instanceof Error ? formatDateTimesInText(reason.message) : undefined });
      // A conflict may mean another client restored the guard, or that Backup Preparation blocks it.
      // Reconcile current state without treating either rejection as a successful restoration.
      refresh();
    } finally {
      pendingLatch.current = false;
      setPending(false);
    }
  };

  if (!awaitingRestore && !pending && !outcome) return null;

  const unavailable = Boolean(rulesError || (awaitingRestore && policy?.error !== null && policy?.error !== undefined));
  const blocked = awaitingRestore && policy?.blocked === true;
  const checking = awaitingRestore && policy === null;
  const failed = outcome?.ok === false;
  const recovering = awaitingRestore && Number.isFinite(recoveryStarted);
  const intervenedAgain = awaitingRestore && hasRestored;
  const freshBattery = success && Date.parse(status?.read_at ?? "") >= (outcome?.at ?? Infinity);
  const batteryPower = freshBattery ? metricValue(status?.energy?.battery?.instant_power) : null;
  const successTitle = batteryPower === null ? "restorePanelSuccess" : batteryPower > 0 ? "restorePanelCharging" : batteryPower < 0 ? "restorePanelDischarging" : "restorePanelIdle";
  const title = pending ? "restorePanelPending" : unavailable ? "restorePanelUnavailable" : blocked ? "restorePanelBlocked" : failed ? "restorePanelFailure" : success ? successTitle : intervenedAgain ? "restorePanelReintervened" : recovering ? "restorePanelRecovering" : "restorePanelAwaiting";
  const badge = pending ? "restoreBadgePending" : unavailable ? "restoreBadgeUnavailable" : blocked ? "restoreBadgeBlocked" : failed ? "restoreBadgeFailure" : success ? "restoreBadgeSuccess" : recovering ? "restoreBadgeRecovering" : "restoreBadgeIntervened";
  const message = pending ? "restorePanelPendingDetail" : unavailable ? "restorePanelUnavailableDetail" : blocked ? "restorePanelBlockedDetail" : failed ? "restorePanelFailureDetail" : success ? "restoreAutoSuccess" : recovering ? "restorePanelRecoveringDetail" : "restorePanelAwaitingDetail";
  const tone = unavailable || failed ? "failure" : success ? "success" : pending ? "pending" : "warning";
  const remainingSeconds = Math.max(0, Math.ceil((recoveryStarted + Number(guard?.conditions?.restoreDelaySeconds ?? 0) * 1000 - now) / 1000));
  const recoveryWait = remainingSeconds > 0 ? `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}` : t("restoreSafetyCheckPending");
  const demand = guard?.conditions?.source === "branchDemandW" ? metricValue(status?.meter?.branch_demand_power) : metricValue(status?.meter?.grid_import_power);
  const threshold = guard?.conditions?.restoreBelowAmps;
  const delaySeconds = guard?.conditions?.restoreDelaySeconds;
  const detail = outcome?.detail || rulesError || policy?.error;

  return (
    <section className="demand-guard-restore panel" data-tone={tone} aria-labelledby={headingId} aria-busy={pending} ref={panelRef}>
      <div className="demand-guard-main">
        <span className="demand-guard-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 20 6v6c0 5-8 9-8 9S4 17 4 12V6z" />
            {success ? <path d="m8 12 3 3 5-6" /> : <path d="M12 8v5m0 3v.1" />}
          </svg>
        </span>
        <div className="demand-guard-copy">
          <div className="demand-guard-kicker">{t("demandGuard")} <span>{t(badge)}</span></div>
          <h2 id={headingId} tabIndex={-1} ref={headingRef}>{t(title)}</h2>
          <p className="demand-guard-message" role={failed || unavailable ? "alert" : "status"}>{t(message)}</p>
        </div>
        <div className="demand-guard-actions">
          {blocked ? <Link className="button" to="/battery/backup">{t("restoreReviewBackup")}</Link> : (
            <button className={`button ${success ? "secondary" : "primary"}`} type="button" aria-describedby={hintId}
              disabled={pending || success || checking}
              onClick={() => unavailable || !awaitingRestore ? refresh() : void restore()}>
              {t(pending ? "restoringAuto" : success ? "restoreAutoDone" : checking ? "restoreChecking" : unavailable || !awaitingRestore ? "restoreRetryStatus" : failed ? "restoreRetry" : "restoreAutoNow")}
            </button>
          )}
          {success ? <small>{t("restoreDismissalHint", { seconds: 30 })}</small> : null}
        </div>
      </div>
      <dl className="demand-guard-metrics">
        {success ? <><div><dt>{t("restoreChargingControl")}</dt><dd>{t("restoreAutoDone")}</dd></div><div><dt>{t("restoreProtection")}</dt><dd>{t("restoreProtectionMonitoring")}</dd></div></> : (
          <>
            <div><dt>{t(guard?.conditions?.source === "branchDemandW" ? "restoreCircuitsDemand" : "currentGridImport")}</dt><dd>{formatPower(demand)}</dd></div>
            <div><dt>{t(recovering ? "restoreRecoveryWait" : "restoreAutomaticRecovery")}</dt><dd>{recovering ? recoveryWait : threshold != null && delaySeconds != null ? t("restoreRecoveryRule", { amps: formatNumber(threshold), minutes: formatNumber(delaySeconds / 60) }) : "—"}</dd></div>
            {guard?.conditions?.breakerAmps != null ? <div><dt>{t("breakerLimit")}</dt><dd>{formatNumber(guard.conditions.breakerAmps)} {t("a")}</dd></div> : null}
          </>
        )}
      </dl>
      {detail ? <details className="demand-guard-error-detail"><summary>{t("restoreTechnicalDetails")}</summary><p>{detail}</p></details> : null}
      <div className="demand-guard-footer">
        <p id={hintId}>{t(success ? "restoreProtectionHint" : blocked ? "restoreBlockedHint" : "restoreAutoHint")}</p>
        <Link to="/automation">{t("restoreViewDetails")}</Link>
      </div>
    </section>
  );
}
