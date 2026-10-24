import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAwayReserve } from "../../hooks/useAwayReserve";
import type { AwayReserveStatus as AwayReserveView } from "../../api/contracts";

export function AwayReserveStatus({ reserve, link = false }: { reserve: AwayReserveView | null; link?: boolean }) {
  const { t } = useTranslation();
  if (!reserve || (reserve.phase === "idle" && !reserve.lastError)) return null;
  return <div className="away-reserve-status" role={reserve.lastError ? "alert" : "status"}>
    {reserve.ownsReserve && reserve.phase === "active" ? <p><strong>{t("awayReserveActive", { percent: reserve.previousPercent })}</strong></p> : null}
    {reserve.phase === "applying" ? <p>{t("awayReserveApplying")}</p> : null}
    {reserve.phase === "restoring" ? <p>{t("awayReserveRestoring", { percent: reserve.previousPercent })}</p> : null}
    {reserve.phase === "suspended" ? <p>{t("awayReserveSuspended")}</p> : null}
    {reserve.phase === "manual" || reserve.phase === "manual-pending" ? <p>{t("awayReserveManual")}</p> : null}
    {reserve.lastError ? <p>{t("awayReserveFailure", { error: reserve.lastError })}</p> : null}
    {link ? <Link to="/automation#away-summary-heading">{t("awayReserveManage")}</Link> : null}
  </div>;
}

export function AwayReserveControl({ disabled = false, refreshKey }: { disabled?: boolean; refreshKey?: string }) {
  const { t } = useTranslation();
  const { reserve, error, saving, save } = useAwayReserve(refreshKey);
  return <div className="away-reserve-control">
    <label className="automation-toggle compact"><input type="checkbox" aria-label={t("awayReserveToggle")} aria-describedby="away-reserve-help" checked={reserve?.enabled ?? false}
      disabled={disabled || saving || reserve === null} onChange={(event) => void save(event.target.checked)} />
      <span><strong>{t("awayReserveToggle")}</strong><small id="away-reserve-help">{t("awayReserveHelp")}</small></span></label>
    {error ? <p role="alert">{error}</p> : null}
    <AwayReserveStatus reserve={reserve} />
  </div>;
}
