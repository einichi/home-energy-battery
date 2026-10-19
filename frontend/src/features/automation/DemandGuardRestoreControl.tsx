import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { restoreDemandGuard } from "../../api/automation";
import type { AutomationRule } from "../../api/contracts";
import { formatDateTimesInText } from "../../core/format";

type RestoreOutcome = { ok: boolean; message: string } | null;

/**
 * Direct Demand Guard restore action. Rendered wherever the guard's intervening
 * state is shown; it restores Auto without waiting for the restore threshold or delay.
 */
export function DemandGuardRestoreControl({ rules, onRestored }: { rules: AutomationRule[]; onRestored: (rules: AutomationRule[]) => void }) {
  const { t } = useTranslation("automation");
  const hintId = useId();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<RestoreOutcome>(null);
  const pendingLatch = useRef(false);
  const awaitingRestore = rules.some((rule) => rule.type === "backup-demand-guard" && rule.state?.awaitingRestore === true);

  const restore = async () => {
    if (pendingLatch.current) return;
    pendingLatch.current = true;
    setPending(true);
    setOutcome(null);
    try {
      const nextRules = await restoreDemandGuard();
      onRestored(nextRules);
      setOutcome({ ok: true, message: t("restoreAutoSuccess") });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "";
      setOutcome({ ok: false, message: detail ? `${t("restoreAutoFailure")} ${formatDateTimesInText(detail)}` : t("restoreAutoFailure") });
    } finally {
      pendingLatch.current = false;
      setPending(false);
    }
  };

  return (
    <div className="demand-guard-restore">
      {awaitingRestore ? (
        <>
          <div className="button-row">
            <button className="quiet-button" type="button" aria-describedby={hintId} disabled={pending} onClick={() => void restore()}>
              {t(pending ? "restoringAuto" : "restoreAutoNow")}
            </button>
          </div>
          <p id={hintId} className="demand-guard-restore-hint">{t("restoreAutoHint")}</p>
        </>
      ) : null}
      {outcome ? (
        <p className={`inline-save-result ${outcome.ok ? "success" : "failure"}`} role={outcome.ok ? "status" : "alert"}>{outcome.message}</p>
      ) : null}
    </div>
  );
}
