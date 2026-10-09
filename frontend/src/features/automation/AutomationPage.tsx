import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import {
  createAwayPeriod,
  deleteAwayPeriod,
  endAwayPeriod,
  extendAwayPeriod,
  getBacktests,
  recalculateAdaptiveCharging,
  resumeAdaptiveCharging,
  runBacktest,
  saveAutomationRule,
  updateAwayPeriod,
} from "../../api/automation";
import type {
  AdaptiveChargingStatus,
  AdaptiveTimelineItem,
  AppConfig,
  AutomationRule,
  AwayPeriod,
  AwayPeriodsView,
  BacktestRunSummary,
  CommandReceipt,
} from "../../api/contracts";
import { updateConfig } from "../../api/queries";
import { formatDate, formatDateTime, formatDateTimesInText, formatEnergy, formatPercent, formatPower, formatTime, metricValue } from "../../core/format";
import { useAutomation } from "../../hooks/useAutomation";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useTranslation } from "react-i18next";

type AutomationView = "plan" | "performance" | "configuration";
type Prerequisite = { label: string; ready: boolean; detail: string; action: string; href: string };
type ActionResult = { ok: boolean; message: string } | null;
type Confirmation = {
  title: string;
  impact: string;
  confirmLabel: string;
  run: () => Promise<void>;
} | null;
type AwayDraft = {
  mode: "create" | "edit" | "extend";
  id: string | null;
  from: string;
  until: string;
  source: "manual" | "scheduled";
};

const automationReceiptSources = new Set(["adaptive-charging", "charging-demand-guard", "backup-preparation"]);

function localDateTimeValue(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initialAwayDraft(): AwayDraft {
  const from = new Date();
  from.setSeconds(0, 0);
  from.setMinutes(Math.ceil(from.getMinutes() / 30) * 30);
  const until = new Date(from.getTime() + 24 * 60 * 60_000);
  return { mode: "create", id: null, from: localDateTimeValue(from), until: localDateTimeValue(until), source: "scheduled" };
}

function prerequisites(config: AppConfig | null): Prerequisite[] {
  const adaptive = config?.adaptiveCharging;
  return [
    { label: "Off-peak electricity pricing", ready: Boolean(config && config.rateMode !== "simple"), detail: "One discounted off-peak window is enough; a multi-rate plan is optional.", action: "Open rate settings", href: "/system/rates" },
    { label: "Solar generation", ready: config?.solarEnabled !== false, detail: "Solar production must be available for the next-day forecast.", action: "Open equipment settings", href: "/system/equipment" },
    { label: "Total circuit load", ready: config?.smartCosmoEnabled !== false, detail: "Monitored circuit history is required to predict consumption.", action: "Open equipment settings", href: "/system/equipment" },
    { label: "Home location", ready: adaptive?.latitude !== null && adaptive?.latitude !== undefined && adaptive?.longitude !== null && adaptive?.longitude !== undefined && Number.isFinite(Number(adaptive.latitude)) && Number.isFinite(Number(adaptive.longitude)), detail: "Latitude and longitude drive sunrise and weather forecasts.", action: "Review planning settings", href: "#adaptive-settings" },
    { label: "Solar array", ready: Number(adaptive?.arrayPeakKw) > 0, detail: "Array peak capacity is required to scale the solar forecast.", action: "Review planning settings", href: "#adaptive-settings" },
    { label: "Battery capacity and charge power", ready: Number(config?.batteryCapabilities?.usableCapacityKwh) > 0 && Number(config?.batteryCapabilities?.maximumChargeWatts) > 0, detail: "Usable capacity and maximum charging power bound the plan.", action: "Review planning settings", href: "#adaptive-settings" },
  ];
}

function masterState(adaptive: AdaptiveChargingStatus | null, checks: Prerequisite[]) {
  if (!adaptive) return { label: "Loading", tone: "neutral", detail: "Reading automation status." };
  if (checks.some((item) => !item.ready)) return { label: "Needs setup", tone: "warning", detail: `${checks.filter((item) => !item.ready).length} prerequisites still need attention.` };
  if (!adaptive.enabled) return { label: "Paused", tone: "neutral", detail: "Adaptive Charging is configured but disabled." };
  if (adaptive.paused) return { label: "Paused", tone: "warning", detail: adaptive.pausedUntil ? `Paused until ${formatDateTime(adaptive.pausedUntil)}.` : "Paused by an operational override." };
  if (!adaptive.available) return { label: "Degraded", tone: "critical", detail: formatDateTimesInText(adaptive.reason ?? "Automation cannot currently produce a safe plan.") };
  if (adaptive.batteryModel?.status === "learning") return { label: "Learning", tone: "info", detail: "The plan is active while the battery model gathers enough evidence to calibrate itself." };
  return { label: "Running", tone: "positive", detail: "Automation is available and monitoring the active plan." };
}

function nextAction(adaptive: AdaptiveChargingStatus | null, checks: Prerequisite[]) {
  if (!adaptive) return { title: "Reading the current plan", reason: "Waiting for automation status." };
  const firstMissing = checks.find((item) => !item.ready);
  if (firstMissing) return { title: `Complete ${firstMissing.label.toLowerCase()} setup`, reason: firstMissing.detail };
  if (!adaptive.enabled) return { title: "Enable Adaptive Charging when ready", reason: "No automated battery charging will be scheduled while it is disabled." };
  if (adaptive.paused) return { title: adaptive.pausedUntil ? `Resume after ${formatDateTime(adaptive.pausedUntil)}` : "Resume Adaptive Charging", reason: formatDateTimesInText(adaptive.reason ?? "A manual or safety override currently owns battery operation.") };
  if (adaptive.owner === "adaptiveCharging" && adaptive.activeSlot) return { title: `Charge until ${formatTime(adaptive.activeSlot.end ?? adaptive.activeSlot.windowEnd)}`, reason: formatDateTimesInText(adaptive.plan?.reason ?? `The active discounted window is working toward ${formatPercent(adaptive.activeSlot.targetSocPercent)} state of charge.`) };
  const now = Date.now();
  const slot = adaptive.plan?.slots?.find((item) => new Date(item.end).getTime() > now);
  if (slot) return { title: `Charge ${formatTime(slot.start)}–${formatTime(slot.end)}`, reason: `Planned during a discounted window${slot.targetSocPercent == null ? "." : ` to work toward ${formatPercent(slot.targetSocPercent)} state of charge.`}` };
  return { title: "No grid charging is currently planned", reason: formatDateTimesInText(adaptive.warning ?? adaptive.plan?.reason ?? "Forecast demand and local generation do not require a charging window yet.") };
}

function demandGuard(rules: AutomationRule[]) {
  return rules.find((item) => item.type === "backup-demand-guard") ?? null;
}

function Timeline({ items = [] }: { items?: AdaptiveTimelineItem[] }) {
  const { t } = useTranslation("automation");
  if (!items.length) return <div className="automation-empty" role="status">{t("noPlanTimelineIsAvailableYetCompleteSetupOrRecalculateAf4a125b")}</div>;
  const start = new Date(items[0].start).getTime();
  const end = new Date(items.at(-1)?.end ?? items[0].end).getTime();
  const duration = Math.max(1, end - start);
  return (
    <div className="automation-timeline" aria-label={t("todayAndTonightAutomationPlan")}>
      <div className="automation-timeline-track">
        {items.map((item, index) => {
          const left = (new Date(item.start).getTime() - start) / duration * 100;
          const width = (new Date(item.end).getTime() - new Date(item.start).getTime()) / duration * 100;
          const tone = Number(item.plannedChargeWh) > 0 ? "charge" : item.away ? "away" : item.discounted ? "discount" : "observe";
          const detail = `${formatTime(item.start)}–${formatTime(item.end)} · Demand ${formatPower(item.demandW ?? null)} · Solar ${formatPower(item.solarW ?? null)} · Planned charge ${Math.round(Number(item.plannedChargeWh) || 0)} Wh${item.away ? " · Away assumptions" : ""}`;
          return <i key={`${item.start}:${index}`} data-tone={tone} style={{ left: `${left}%`, width: `${Math.max(.35, width)}%` }} title={detail} aria-label={detail} />;
        })}
      </div>
      <div className="automation-timeline-axis"><time>{formatDateTime(items[0].start)}</time><time>{formatDateTime(items.at(-1)?.end)}</time></div>
      <div className="automation-timeline-legend"><span data-tone="charge">{t("plannedCharging")}</span><span data-tone="discount">{t("discountedPeriod")}</span><span data-tone="away">{t("awayAssumptions")}</span><span data-tone="observe">{t("forecastOnly")}</span></div>
    </div>
  );
}

type ActivityRow = { at?: string | null; kind: string; actor: string; message: string; result: string };

function receiptActor(source: string) {
  if (source === "adaptive-charging") return "Adaptive Charging";
  if (source === "charging-demand-guard") return "Demand Guard";
  return "Disaster Prep";
}

function receiptResult(receipt: CommandReceipt) {
  if (receipt.state === "succeeded") return "Verified";
  if (receipt.state === "mismatched") return "Readback mismatch";
  if (receipt.state === "timed-out") return "Timed out";
  if (receipt.state === "failed") return "Failed";
  return receipt.state.replaceAll("-", " ");
}

function activityResult(kindValue?: string | null) {
  const kind = kindValue?.toLowerCase() ?? "";
  if (kind.includes("error") || kind.includes("fail")) return "Failed";
  if (kind.includes("warning") || kind.includes("skip")) return "Attention";
  if (kind.includes("plan") || kind.includes("learning")) return "Recorded";
  return "Completed";
}

function Activity({ adaptive, guard, receipts }: { adaptive: AdaptiveChargingStatus | null; guard: AutomationRule | null; receipts: CommandReceipt[] }) {
  const { t } = useTranslation("automation");
  const rows = useMemo<ActivityRow[]>(() => [
    ...(adaptive?.log ?? []).map((entry) => ({ at: entry.at, kind: entry.kind ?? "info", actor: "Adaptive Charging", message: entry.message ?? "No detail recorded", result: activityResult(entry.kind) })),
    ...(guard?.log ?? []).map((entry) => ({ at: entry.at, kind: entry.kind ?? "info", actor: "Demand Guard", message: entry.message ?? "No detail recorded", result: activityResult(entry.kind) })),
    ...receipts.filter((receipt) => automationReceiptSources.has(receipt.source)).map((receipt) => ({ at: receipt.completedAt ?? receipt.requestedAt, kind: receipt.state, actor: receiptActor(receipt.source), message: receipt.message ?? `${receipt.action.replaceAll("-", " ")} requested`, result: receiptResult(receipt) })),
  ].sort((left, right) => new Date(right.at ?? 0).getTime() - new Date(left.at ?? 0).getTime()).slice(0, 16), [adaptive?.log, guard?.log, receipts]);

  return (
    <section className="panel automation-activity" aria-labelledby="automation-activity-heading">
      <div className="section-heading"><div><p className="eyebrow">{t("auditTrail")}</p><h2 id="automation-activity-heading">{t("recentActivity")}</h2></div></div>
      {rows.length ? <div className="table-scroll"><table><thead><tr><th>{t("severity")}</th><th>{t("time")}</th><th>{t("actor")}</th><th>{t("actionAndReason")}</th><th>{t("result")}</th></tr></thead><tbody>{rows.map((entry, index) => <tr key={`${entry.at}:${entry.actor}:${index}`}><td><span className="event-severity" data-kind={entry.kind}>{entry.kind}</span></td><td>{formatDateTime(entry.at)}</td><td>{t(entry.actor)}</td><td>{formatDateTimesInText(entry.message)}</td><td>{t(entry.result)}</td></tr>)}</tbody></table></div> : <p className="automation-empty">{t("noAutomationActivityHasBeenRecordedYet")}</p>}
    </section>
  );
}

function ConfirmationDialog({ confirmation, close }: { confirmation: NonNullable<Confirmation>; close: () => void }) {
  const { t } = useTranslation("automation");
  const [busy, setBusy] = useState(false);
  const dialogRef = useDialogFocus<HTMLElement>(close);
  const run = async () => {
    setBusy(true);
    try {
      await confirmation.run();
      close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="command-dialog panel" role="dialog" aria-modal="true" aria-labelledby="automation-confirm-title" ref={dialogRef} tabIndex={-1}>
        <p className="eyebrow">{t("reviewAutomationChange")}</p>
        <h2 id="automation-confirm-title">{confirmation.title}</h2>
        <p className="impact-note">{confirmation.impact}</p>
        <div className="button-row dialog-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={close}>{t("cancel")}</button>
          <button className="button primary" type="button" disabled={busy} onClick={() => void run()}>{busy ? "Applying…" : confirmation.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function AwayWorkspace({ away, busy, result, onSubmit, onDelete, onBackHome }: {
  away: AwayPeriodsView;
  busy: string | null;
  result: ActionResult;
  onSubmit: (draft: AwayDraft) => Promise<void>;
  onDelete: (period: AwayPeriod) => Promise<void>;
  onBackHome: (period: AwayPeriod) => Promise<void>;
}) {
  const { t } = useTranslation("automation");
  const [draft, setDraft] = useState<AwayDraft>(initialAwayDraft);
  const [deleteCandidate, setDeleteCandidate] = useState<AwayPeriod | null>(null);
  const reset = () => setDraft(initialAwayDraft());
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await onSubmit(draft);
      reset();
    } catch {
      // Keep the entered period available for correction.
    }
  };
  const beginNow = () => {
    const now = new Date();
    const currentUntil = new Date(draft.until);
    const until = Number.isFinite(currentUntil.getTime()) && currentUntil > now ? currentUntil : new Date(now.getTime() + 24 * 60 * 60_000);
    setDraft({ mode: "create", id: null, from: localDateTimeValue(now), until: localDateTimeValue(until), source: "manual" });
  };
  const edit = (period: AwayPeriod, mode: "edit" | "extend") => setDraft({ mode, id: period.id, from: localDateTimeValue(period.from), until: localDateTimeValue(period.until), source: period.source === "manual" ? "manual" : "scheduled" });

  return (
    <section className="panel away-workspace" aria-labelledby="away-summary-heading">
      <div className="section-heading">
        <div><p className="eyebrow">{t("occupancyContext")}</p><h2 id="away-summary-heading">{t("awaySchedule")}</h2></div>
        <span className="automation-status-pill" data-tone={away.state === "away" ? "warning" : "positive"}>{away.state === "away" ? "Away" : "Home"}</span>
      </div>
      <p className="section-copy">{t("awayPeriodsReduceForecastDemandAssumptionsAndQueueAFresh52917b")}</p>
      {away.active ? <div className="away-active"><div><strong>{t("awayNow")}</strong><span>{"" + t("expectedHome") + " "}{formatDateTime(away.active.until)}</span></div><div className="button-row"><button className="quiet-button" type="button" disabled={busy !== null} onClick={() => edit(away.active as AwayPeriod, "extend")}>{t("extend")}</button><button className="button primary" type="button" disabled={busy !== null} onClick={() => void onBackHome(away.active as AwayPeriod)}>{t("backHome")}</button></div></div> : null}
      <form className="away-form" onSubmit={(event) => void submit(event)}>
        <div className="section-heading away-form-heading"><div><h3>{draft.mode === "edit" ? "Edit Away period" : draft.mode === "extend" ? "Extend Away period" : draft.source === "manual" ? "Away now" : "Schedule Away period"}</h3>{draft.source === "manual" ? <p>{t("confirmWhenYouExpectToReturnBeforeStartingAwayMode")}</p> : null}</div>{draft.mode !== "create" || draft.source === "manual" ? <button className="text-button" type="button" onClick={reset}>{t("cancel")}</button> : null}</div>
        <div className="away-form-grid">
          <label className="field">{t("from")}<input aria-label={t("awayFrom")} type="datetime-local" required disabled={draft.mode === "extend"} value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} /></label>
          <label className="field">{t("until")}<input aria-label={t("awayUntil")} type="datetime-local" required value={draft.until} onChange={(event) => setDraft((current) => ({ ...current, until: event.target.value }))} /></label>
          <div className="away-form-actions"><button className="quiet-button" type="button" disabled={busy !== null || away.active !== null} onClick={beginNow}>{t("awayNow")}</button><button className="button primary" type="submit" disabled={busy !== null}>{busy === "away" ? "Saving…" : draft.mode === "edit" ? "Save period" : draft.mode === "extend" ? "Save extension" : draft.source === "manual" ? "Start Away period" : "Add period"}</button></div>
        </div>
      </form>
      {result ? <p className={`inline-save-result ${result.ok ? "success" : "failure"}`} role={result.ok ? "status" : "alert"}>{formatDateTimesInText(result.message)}</p> : null}
      <div className="away-period-list">
        <h3>{t("upcomingPeriods")}</h3>
        {away.periods.filter((period) => period.status !== "active").length ? away.periods.filter((period) => period.status !== "active").map((period) => <article key={period.id}><div><strong>{formatDateTime(period.from)}</strong><span>{t("{until} · {source}", { until: formatDateTime(period.until), source: t(period.source === "manual" ? "Started manually" : "Scheduled") })}</span></div><div className="button-row">{deleteCandidate?.id === period.id ? <><span className="delete-prompt">{t("removeThisPeriod")}</span><button className="quiet-button" type="button" onClick={() => setDeleteCandidate(null)}>{t("keep")}</button><button className="button danger" type="button" disabled={busy !== null} onClick={() => void onDelete(period).then(() => setDeleteCandidate(null))}>{t("remove")}</button></> : <><button className="quiet-button" type="button" disabled={busy !== null} onClick={() => edit(period, "edit")}>{t("edit")}</button><button className="quiet-button danger" type="button" disabled={busy !== null} onClick={() => setDeleteCandidate(period)}>{t("delete")}</button></>}</div></article>) : <p className="automation-empty compact">{t("noFutureAwayPeriodsAreScheduled")}</p>}
      </div>
      <p className="panel-note">{"" + t("normalDemandAssumptionsResumeAfterTheReturnTimePlusA") + " "}{away.returnBufferMinutes ?? 30}{t("minuteBuffer")}</p>
    </section>
  );
}

function formatWh(value?: number | null) {
  return value === null || value === undefined ? "—" : Number.isFinite(Number(value)) ? `${Math.round(Number(value))} Wh` : "—";
}

function signedEnergy(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)} kWh`;
}

function PerformanceView({ adaptive }: { adaptive: AdaptiveChargingStatus | null }) {
  const { t } = useTranslation("automation");
  const [backtests, setBacktests] = useState<BacktestRunSummary[]>([]);
  const [backtestRange, setBacktestRange] = useState<"90d" | "all">("90d");
  const [backtestBusy, setBacktestBusy] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void getBacktests(controller.signal)
      .then((response) => setBacktests(response.runs))
      .catch((reason) => {
        if (!controller.signal.aborted) setBacktestError(reason instanceof Error ? reason.message : "Backtests could not be loaded");
      });
    return () => controller.abort();
  }, []);
  const startBacktest = async () => {
    setBacktestBusy(true);
    setBacktestError(null);
    try {
      const run = await runBacktest({ range: backtestRange, mode: "both", modelId: "adaptive-planner" });
      setBacktests((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    } catch (reason) {
      setBacktestError(reason instanceof Error ? reason.message : "Backtest failed");
    } finally {
      setBacktestBusy(false);
    }
  };
  const latestBacktest = backtests[0] ?? null;
  const plan = adaptive?.plan;
  const demandDays = plan?.demandHistory?.validDayCount ?? plan?.demandHistory?.recentComparableDayCount ?? 0;
  const solarOutcomes = adaptive?.solarForecastAccuracy?.outcomes ?? [];
  const windowOutcomes = [...(adaptive?.windowSummaries ?? [])].reverse();
  const fuelOutcomes = useMemo(() => {
    const seen = new Set<string>();
    return (adaptive?.fuelCellForecastOutcomes ?? []).filter((outcome) => {
      const key = outcome.targetStart ?? outcome.start;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((outcome) => {
      const start = new Date(outcome.start ?? outcome.targetStart ?? "");
      const end = new Date(outcome.end ?? "");
      const hours = Math.max(0, end.getTime() - start.getTime()) / 3_600_000;
      const predictedKwh = outcome.medianW === null || outcome.medianW === undefined ? null : Number(outcome.medianW) * hours / 1000;
      const actualKwh = outcome.actualKwh === null || outcome.actualKwh === undefined ? null : Number(outcome.actualKwh);
      return { ...outcome, start, end, predictedKwh, actualKwh, errorKwh: predictedKwh !== null && actualKwh !== null ? actualKwh - predictedKwh : null };
    }).filter((outcome) => Number.isFinite(outcome.start.getTime()) && Number.isFinite(outcome.end.getTime()) && outcome.predictedKwh !== null && outcome.actualKwh !== null);
  }, [adaptive?.fuelCellForecastOutcomes]);
  const solarMae = solarOutcomes
    .map((outcome) => outcome.errorKwh === null || outcome.errorKwh === undefined ? null : Math.abs(Number(outcome.errorKwh)))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const fuelMae = fuelOutcomes
    .map((outcome) => outcome.errorKwh === null || outcome.errorKwh === undefined ? null : Math.abs(outcome.errorKwh))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  return (
    <section className="automation-view-stack" aria-label="Automation performance">
      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">{t("currentPlanningEvidence")}</p><h2>{t("forecastAndControlPerformance")}</h2></div></div>
        <div className="performance-domain-grid">
          <article><span>{t("solarForecast")}</span><strong>{formatEnergy(plan?.predictedSolarKwh)}</strong><small>{"" + t("estimatedForTheCurrentHorizon") + " "}{solarOutcomes.length} {" " + t("completedDays") + ""}</small></article>
          <article><span>{t("demandForecast")}</span><strong>{formatEnergy(plan?.predictedDemandKwh)}</strong><small>{"" + t("estimatedFrom") + " "}{demandDays} {" " + t("validHistoricalDays") + ""}</small></article>
          <article><span>{t("batteryPlan")}</span><strong>{formatEnergy(plan?.plannedChargeKwh)}</strong><small>{"" + t("estimatedGridCharge") + " "}{windowOutcomes.length} {" " + t("completedWindows") + ""}</small></article>
          <article><span>{t("eneFarmForecast")}</span><strong>{formatEnergy(plan?.predictedFuelCellKwh)}</strong><small>{"" + t("estimatedContribution") + " "}{fuelOutcomes.length} {" " + t("completedIntervals") + ""}</small></article>
        </div>
      </section>
      <section className="performance-detail-grid">
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow">{t("solar")}</p><h2>{t("forecastOutcomes")}</h2></div><span className="quality-label">{adaptive?.solarForecastAccuracy?.learned ? "Calibrated estimate" : "Learning estimate"}</span></div><dl className="performance-summary"><div><dt>{t("evidence")}</dt><dd>{adaptive?.solarForecastAccuracy?.sampleCount ?? 0} {" " + t("days") + ""}</dd></div><div><dt>{t("meanAbsoluteError")}</dt><dd>{solarMae.length ? formatEnergy(solarMae.reduce((sum, value) => sum + value, 0) / solarMae.length) : "—"}</dd></div></dl>{solarOutcomes.length ? <div className="table-scroll"><table><thead><tr><th>{t("date")}</th><th>{t("issuedEstimate")}</th><th>{t("planningEstimate")}</th><th>{t("recordedGeneration")}</th><th>{t("error")}</th></tr></thead><tbody>{[...solarOutcomes].reverse().slice(0, 8).map((outcome, index) => <tr key={`${outcome.targetDate}:${index}`}><td>{outcome.targetDate ? formatDate(`${outcome.targetDate}T00:00:00`) : "—"}</td><td>{formatEnergy(outcome.predictedKwh)}</td><td>{formatEnergy(outcome.planningKwh)}</td><td>{formatEnergy(outcome.actualKwh)}</td><td>{signedEnergy(outcome.errorKwh)}</td></tr>)}</tbody></table></div> : <p className="automation-empty compact">{t("noCompletedSolarForecastDaysYet")}</p>}</article>
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow">{t("demand")}</p><h2>{t("historicalModel")}</h2></div><span className="quality-label">{t("estimated")}</span></div><dl className="performance-summary"><div><dt>{t("recordedDays")}</dt><dd>{plan?.demandHistory?.recordedDayCount ?? 0}</dd></div><div><dt>{t("validDays")}</dt><dd>{plan?.demandHistory?.validDayCount ?? 0}</dd></div><div><dt>{t("recentComparisons")}</dt><dd>{plan?.demandHistory?.recentComparableDayCount ?? 0}</dd></div><div><dt>{t("seasonalComparisons")}</dt><dd>{plan?.demandHistory?.seasonalComparableDayCount ?? 0}</dd></div></dl><p className="panel-note">{t("demandErrorHistoryIsNotAvailableYet")}</p></article>
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow">{t("battery")}</p><h2>{t("chargingWindowOutcomes")}</h2></div><span className="quality-label">{t("recordedEstimated")}</span></div>{windowOutcomes.length ? <div className="table-scroll"><table><thead><tr><th>{t("window")}</th><th>{t("planned")}</th><th>{t("delivered")}</th><th>{t("guardImpact")}</th><th>{t("soc")}</th><th>{t("result")}</th></tr></thead><tbody>{windowOutcomes.slice(0, 8).map((outcome, index) => <tr key={`${outcome.key}:${index}`}><td>{formatDateTime(outcome.windowStart)}<small>{t(outcome.label ?? "Discounted")}</small></td><td>{formatWh(outcome.plannedWh)}</td><td>{formatWh(outcome.deliveredWh)}{Number(outcome.estimatedDeliveryWh) > 0 ? <small>{formatWh(outcome.estimatedDeliveryWh)} {" " + t("boundaryEstimate") + ""}</small> : null}</td><td>{Number(outcome.interruptionCount) > 0 ? t("countInterruptionsMinutesMinUnavailable", { count: outcome.interruptionCount, minutes: Math.round(Number(outcome.guardInterruptedMs) / 60_000) }) : "—"}</td><td>{t("{start} → {end}", { start: formatPercent(outcome.startSocPercent), end: formatPercent(outcome.endSocPercent) })}</td><td>{outcome.socTargetReached ? t("Target reached") : Number(outcome.unmetWh) > 0 ? t("{value} short", { value: formatWh(outcome.unmetWh) }) : t("Completed")}</td></tr>)}</tbody></table></div> : <p className="automation-empty compact">{t("noCompletedChargingWindowsYet")}</p>}</article>
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow">{t("eneFarm")}</p><h2>{t("forecastOutcomes")}</h2></div><span className="quality-label">{t("estimatedVsRecorded")}</span></div><dl className="performance-summary"><div><dt>{t("completedIntervals112850")}</dt><dd>{fuelOutcomes.length}</dd></div><div><dt>{t("meanAbsoluteError")}</dt><dd>{fuelMae.length ? formatEnergy(fuelMae.reduce((sum, value) => sum + value, 0) / fuelMae.length) : "—"}</dd></div></dl>{fuelOutcomes.length ? <div className="table-scroll"><table><thead><tr><th>{t("interval")}</th><th>{t("medianEstimate")}</th><th>{t("recordedOutput")}</th><th>{t("error")}</th><th>{t("planInfluence")}</th></tr></thead><tbody>{fuelOutcomes.slice(0, 8).map((outcome, index) => <tr key={`${outcome.targetStart}:${index}`}><td>{t("{start}–{end}", { start: formatTime(outcome.start.toISOString()), end: formatTime(outcome.end.toISOString()) })}</td><td>{formatEnergy(outcome.predictedKwh)}</td><td>{formatEnergy(outcome.actualKwh)}</td><td>{signedEnergy(outcome.errorKwh)}</td><td>{outcome.influence ?? "—"}</td></tr>)}</tbody></table></div> : <p className="automation-empty compact">{t("noCompletedEneFarmForecastIntervalsYet")}</p>}</article>
      </section>
      <section className="panel backtest-performance" aria-labelledby="backtest-performance-heading">
        <div className="section-heading">
          <div><p className="eyebrow">{t("unifiedReplay")}</p><h2 id="backtest-performance-heading">{t("forecastBacktesting")}</h2></div>
          <div className="backtest-actions"><label><span>{t("period")}</span><select value={backtestRange} onChange={(event) => setBacktestRange(event.target.value as "90d" | "all")}><option value="90d">{t("last90Days")}</option><option value="all">{t("allHistory")}</option></select></label><button className="button primary" type="button" disabled={backtestBusy} onClick={() => void startBacktest()}>{t(backtestBusy ? "Running…" : "Run backtest")}</button></div>
        </div>
        <p className="section-copy">{t("replaysVersionedPlansWithoutIssuingDeviceCommandsRecorde723e6a")}</p>
        {backtestError ? <p className="inline-save-result failure" role="alert">{backtestError}</p> : null}
        {latestBacktest ? <>
          <div className="performance-domain-grid backtest-summary">
            <article><span>{t("plansEvaluated")}</span><strong>{t("{evaluated}/{total}", { evaluated: latestBacktest.evaluablePlanCount, total: latestBacktest.planCount })}</strong><small>{t("countExcludedForInsufficientEvidence", { count: latestBacktest.excludedPlanCount })}</small></article>
            <article><span>{t("asOperated")}</span><strong>{latestBacktest.asOperated?.targetMetPercent == null ? "—" : `${Math.round(latestBacktest.asOperated.targetMetPercent)}%`}</strong><small>{t("Required SOC achieved · {cost}", { cost: latestBacktest.asOperated?.averageGridCostYen == null ? t("cost unavailable") : t("¥{amount} average grid cost", { amount: Math.round(latestBacktest.asOperated.averageGridCostYen) }) })}</small></article>
            <article><span>{t("modelOnly")}</span><strong>{latestBacktest.modelOnly?.targetMetPercent == null ? "—" : `${Math.round(latestBacktest.modelOnly.targetMetPercent)}%`}</strong><small>{t("Ideal command delivery · {cost}", { cost: latestBacktest.modelOnly?.averageGridCostYen == null ? t("cost unavailable") : t("¥{amount} average grid cost", { amount: Math.round(latestBacktest.modelOnly.averageGridCostYen) }) })}</small></article>
            <article><span>{t("solarError")}</span><strong>{latestBacktest.components.solar.meanAbsoluteErrorKwh == null ? "—" : formatEnergy(latestBacktest.components.solar.meanAbsoluteErrorKwh)}</strong><small>{t("{count} completed forecast outcomes", { count: latestBacktest.components.solar.sampleCount })}</small></article>
          </div>
          <div className="backtest-meta"><span>{t("Model {id} v{version}", { id: latestBacktest.modelId, version: latestBacktest.modelVersion })}</span><span>{t("Engine v{version}", { version: latestBacktest.engineVersion })}</span><span>{t("{start}–{end}", { start: formatDate(latestBacktest.periodStart), end: formatDate(latestBacktest.periodEnd) })}</span><span>{t(latestBacktest.status)}</span></div>
          <div className="table-scroll backtest-detail-table"><table><thead><tr><th>{t("forecastComponent")}</th><th>{t("evidence")}</th><th>{t("meanAbsoluteError")}</th><th>{t("bias")}</th></tr></thead><tbody>{(["solar", "demand", "fuelCell"] as const).map((component) => { const metric = latestBacktest.components[component]; return <tr key={component}><td>{t(component === "solar" ? "Solar" : component === "demand" ? "Demand" : "Ene-Farm")}</td><td>{metric.sampleCount}</td><td>{metric.meanAbsoluteErrorKwh == null ? "—" : formatEnergy(metric.meanAbsoluteErrorKwh)}</td><td>{metric.meanBiasKwh == null ? "—" : signedEnergy(metric.meanBiasKwh)}</td></tr>; })}</tbody></table></div>
           {latestBacktest.seasonal.length ? <div className="table-scroll backtest-detail-table"><table><thead><tr><th>{t("season")}</th><th>{t("plansEvaluated")}</th><th>{t("requiredSOCAchieved")}</th><th>{t("averageGridCost")}</th></tr></thead><tbody>{latestBacktest.seasonal.map((season) => <tr key={season.season}><td>{t(season.season[0].toUpperCase() + season.season.slice(1))}</td><td>{t("{evaluated}/{total}", { evaluated: season.evaluablePlanCount, total: season.planCount })}</td><td>{season.targetMetPercent == null ? "—" : `${Math.round(season.targetMetPercent)}%`}</td><td>{season.averageGridCostYen == null ? "—" : `¥${Math.round(season.averageGridCostYen)}`}</td></tr>)}</tbody></table></div> : null}
          {latestBacktest.notes.map((note) => <p className="panel-note" key={note}>{note}</p>)}
        </> : <p className="automation-empty compact">{t("noBacktestHasBeenRunYet")}</p>}
      </section>
      <section className="panel model-progress"><div className="section-heading"><div><p className="eyebrow">{t("batteryLearning")}</p><h2>{t("modelEvidence")}</h2></div><span className="quality-label">{adaptive?.batteryModel?.status ?? "Unavailable"} {" " + t("v") + ""}{adaptive?.batteryModel?.version ?? "—"}</span></div><dl><div><dt>{t("chargeObservations")}</dt><dd>{adaptive?.batteryModel?.charge?.acceptedObservationCount ?? 0}</dd></div><div><dt>{t("dischargeObservations")}</dt><dd>{adaptive?.batteryModel?.discharge?.acceptedObservationCount ?? 0}</dd></div><div><dt>{t("chargePowerSamples")}</dt><dd>{adaptive?.batteryModel?.power?.sampleCount ?? 0}</dd></div><div><dt>{t("chargingSessions")}</dt><dd>{adaptive?.batteryModel?.power?.sessionCount ?? 0}</dd></div></dl></section>
    </section>
  );
}

function numberValue(form: FormData, name: string) {
  return Number(form.get(name));
}

export function AutomationPage() {
  const { t } = useTranslation("automation");
  const [view, setView] = useState<AutomationView>("plan");
  const [busy, setBusy] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<ActionResult>(null);
  const [awayResult, setAwayResult] = useState<ActionResult>(null);
  const [adaptiveResult, setAdaptiveResult] = useState<ActionResult>(null);
  const [guardResult, setGuardResult] = useState<ActionResult>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const { config, status, replaceConfig, refresh: refreshStatus } = useEnergyStatus();
  const { adaptive, rules, away, receipts, loading, manualRefreshing, error, refresh } = useAutomation();
  const checks = prerequisites(config);
  const state = masterState(adaptive, checks);
  const next = nextAction(adaptive, checks);
  const guard = demandGuard(rules);
  const breakerWatts = Number(guard?.conditions?.breakerAmps) * Number(guard?.conditions?.breakerVoltage);
  const thresholdWatts = (Number(guard?.conditions?.breakerAmps) - Number(guard?.conditions?.reserveAmps)) * Number(guard?.conditions?.breakerVoltage);
  const gridImport = metricValue(status?.meter?.grid_import_power);
  const headroom = Number.isFinite(thresholdWatts) && gridImport !== null ? thresholdWatts - gridImport : null;
  const configurationReady = checks.every((item) => item.ready);
  const guardPlanningBasis = adaptive?.plan?.windows
    ?.map((window) => window.guardDeliverability)
    .filter((model) => model?.learned === true)
    .sort((left, right) => Number(left?.deliveryFactor) - Number(right?.deliveryFactor))[0];

  const runPlanAction = async (name: "recalculate" | "resume") => {
    setBusy(name);
    setPlanResult(null);
    try {
      if (name === "recalculate") await recalculateAdaptiveCharging();
      else await resumeAdaptiveCharging();
      setPlanResult({ ok: true, message: name === "recalculate" ? "Plan recalculated successfully." : "Adaptive Charging resumed. A fresh plan has been queued." });
      refresh();
      refreshStatus();
    } catch (reason) {
      setPlanResult({ ok: false, message: formatDateTimesInText(reason instanceof Error ? reason.message : "Automation action failed") });
    } finally {
      setBusy(null);
    }
  };

  const saveAdaptive = async (nextConfig: AppConfig) => {
    setBusy("adaptive-config");
    setAdaptiveResult(null);
    try {
      const saved = await updateConfig(nextConfig);
      replaceConfig({ ...saved, runtime: config?.runtime });
      setAdaptiveResult({ ok: true, message: "Adaptive Charging settings saved. A fresh plan has been queued." });
      refresh();
      refreshStatus();
    } catch (reason) {
      setAdaptiveResult({ ok: false, message: formatDateTimesInText(reason instanceof Error ? reason.message : "Adaptive Charging settings could not be saved") });
    } finally {
      setBusy(null);
    }
  };

  const submitAdaptive = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config) return;
    const form = new FormData(event.currentTarget);
    const enabled = form.get("enabled") === "on";
    const nextConfig: AppConfig = {
      ...config,
      batteryCapabilities: {
        usableCapacityKwh: numberValue(form, "usableCapacityKwh"),
        maximumChargeWatts: numberValue(form, "maximumChargeWatts"),
        roundTripEfficiency: (Number(form.get("roundTripEfficiencyPercent")) || 90) / 100,
      },
      adaptiveCharging: {
        ...config.adaptiveCharging,
        enabled,
        latitude: numberValue(form, "latitude"),
        longitude: numberValue(form, "longitude"),
        arrayPeakKw: numberValue(form, "arrayPeakKw"),
        panelTiltDegrees: numberValue(form, "panelTiltDegrees"),
        panelAzimuthDegrees: numberValue(form, "panelAzimuthDegrees"),
        systemLossPercent: numberValue(form, "systemLossPercent"),
        targetSocPercent: numberValue(form, "targetSocPercent"),
        forecastMarginPercent: numberValue(form, "forecastMarginPercent"),
      },
    };
    const impact = enabled
      ? "Adaptive Charging will be allowed to choose discounted charging windows and control battery charging after the next plan is calculated. If it is already controlling the battery, changing these values can end the current charging window before recalculation."
      : "Adaptive Charging will stop owning battery operation. Any active automated charging window will be ended and normal device-managed operation will be restored.";
    setConfirmation({ title: enabled ? "Apply Adaptive Charging settings" : "Turn off Adaptive Charging", impact, confirmLabel: enabled ? "Save and recalculate" : "Turn off", run: () => saveAdaptive(nextConfig) });
  };

  const saveGuard = async (rule: AutomationRule) => {
    setBusy("guard-config");
    setGuardResult(null);
    try {
      await saveAutomationRule(rule);
      setGuardResult({ ok: true, message: "Demand Guard settings saved." });
      refresh();
    } catch (reason) {
      setGuardResult({ ok: false, message: formatDateTimesInText(reason instanceof Error ? reason.message : "Demand Guard settings could not be saved") });
    } finally {
      setBusy(null);
    }
  };

  const submitGuard = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const enabled = form.get("enabled") === "on";
    const breakerAmps = numberValue(form, "breakerAmps");
    const reserveAmps = numberValue(form, "reserveAmps");
    const restoreBelowAmps = numberValue(form, "restoreBelowAmps");
    if (reserveAmps >= breakerAmps || restoreBelowAmps > breakerAmps) {
      setGuardResult({ ok: false, message: "Reserve amps must be below the breaker limit, and the restore threshold cannot exceed it." });
      return;
    }
    const rule: AutomationRule = {
      ...guard,
      name: guard?.name ?? "Charging demand guard",
      type: "backup-demand-guard",
      enabled,
      dashboardWarningEnabled: form.get("dashboardWarningEnabled") === "on",
      conditions: {
        source: guard?.conditions?.source ?? "gridImportW",
        breakerVoltage: guard?.conditions?.breakerVoltage ?? 100,
        breakerAmps,
        reserveAmps,
        restoreBelowAmps,
        restoreDelaySeconds: numberValue(form, "restoreDelaySeconds"),
      },
    };
    if (enabled) {
      setConfirmation({ title: "Enable Demand Guard", impact: "Demand Guard monitors grid import while the battery is charging. If the configured breaker margin is crossed, it can place the battery in Standby, then restore Auto mode after demand remains below the recovery threshold.", confirmLabel: "Enable protection", run: () => saveGuard(rule) });
    } else {
      void saveGuard(rule);
    }
  };

  const mutateAway = async (draft: AwayDraft) => {
    setBusy("away");
    setAwayResult(null);
    try {
      const from = new Date(draft.from);
      const until = new Date(draft.until);
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime()) || until <= from) throw new Error("The return time must be after the Away start time.");
      if (draft.mode === "extend" && draft.id) await extendAwayPeriod(draft.id, until.toISOString());
      else if (draft.mode === "edit" && draft.id) await updateAwayPeriod(draft.id, { from: from.toISOString(), until: until.toISOString() });
      else await createAwayPeriod({ from: from.toISOString(), until: until.toISOString(), source: draft.source });
      setAwayResult({ ok: true, message: draft.mode === "extend" ? "Away period extended and plan recalculation queued." : draft.mode === "edit" ? "Away period updated and plan recalculation queued." : "Away period saved and plan recalculation queued." });
      refresh();
    } catch (reason) {
      setAwayResult({ ok: false, message: formatDateTimesInText(reason instanceof Error ? reason.message : "Away period could not be saved") });
      throw reason;
    } finally {
      setBusy(null);
    }
  };

  const removeAway = async (period: AwayPeriod) => {
    setBusy("away");
    setAwayResult(null);
    try {
      await deleteAwayPeriod(period.id);
      setAwayResult({ ok: true, message: "Away period removed and plan recalculation queued." });
      refresh();
    } catch (reason) {
      setAwayResult({ ok: false, message: formatDateTimesInText(reason instanceof Error ? reason.message : "Away period could not be removed") });
    } finally {
      setBusy(null);
    }
  };

  const backHome = async (period: AwayPeriod) => {
    setBusy("away");
    setAwayResult(null);
    try {
      await endAwayPeriod(period.id);
      setAwayResult({ ok: true, message: "Home state restored. Normal demand assumptions and plan recalculation are queued." });
      refresh();
    } catch (reason) {
      setAwayResult({ ok: false, message: formatDateTimesInText(reason instanceof Error ? reason.message : "Home state could not be restored") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page automation-page">
      <header className="page-heading"><div><p className="eyebrow">{t("decide")}</p><h1>{t("automation")}</h1><p>{t("understandWhatTheSystemWillDoNextWhyItChoseThatActionAnd7a95b9")}</p></div><button className="quiet-button" type="button" onClick={refresh} disabled={loading || manualRefreshing}>{loading ? "Loading…" : manualRefreshing ? "Refreshing…" : "Refresh"}</button></header>
      {error ? <div className="status-banner" data-severity="critical">{"" + t("automation581c15") + " "}{formatDateTimesInText(error)}</div> : null}

      <nav className="automation-tabs" aria-label={t("automationViews")}>{(["plan", "performance", "configuration"] as AutomationView[]).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}>{t(item[0].toUpperCase() + item.slice(1))}</button>)}</nav>

      {view === "plan" ? <>
        <section className="automation-summary-grid" aria-label="Automation summary">
          <article className="panel automation-master"><p className="eyebrow">{t("systemState")}</p><div className="automation-master-state"><h2>{t(state.label)}</h2><span data-tone={state.tone} /></div><p>{t(state.detail)}</p></article>
          <article className="panel automation-next"><p className="eyebrow">{t("nextAction")}</p><h2>{t(next.title)}</h2><p>{t(next.reason)}</p>{adaptive?.plan?.targetSunset ? <small>{"" + t("planHorizon") + " "}{formatDateTime(adaptive.plan.targetSunset)}</small> : null}{adaptive?.plan?.horizonTruncated ? <small className="plan-horizon-warning" role="status">{"" + t("solarForecastEndsBeforeThePlanningLookAheadThePlanEndsAt") + " "}{formatDateTime(adaptive.plan.forecastLastHour ?? adaptive.plan.horizonEnd ?? null)}</small> : null}</article>
        </section>

        <section className="panel automation-protections" aria-labelledby="protections-heading"><div className="section-heading"><div><p className="eyebrow">{t("safety")}</p><h2 id="protections-heading">{t("activeProtections")}</h2></div></div><div className="protection-grid"><article><span>{t("demandGuard")}</span><strong>{t(guard?.enabled ? guard.state?.awaitingRestore ? "Intervening" : "Monitoring" : "Off")}</strong><small>{guard?.enabled ? `${formatPower(headroom)} headroom before intervention` : "Breaker protection is disabled"}</small></article><article><span>{t("breakerContract")}</span><strong>{formatPower(Number.isFinite(breakerWatts) ? breakerWatts : null)}</strong><small>{guard?.conditions?.breakerAmps ?? "—"} {" " + t("aAt") + " "}{guard?.conditions?.breakerVoltage ?? "—"} {" " + t("vc9ee56") + ""}</small></article><article><span>{t("currentGridImport")}</span><strong>{formatPower(gridImport)}</strong><small>{Number.isFinite(thresholdWatts) ? `Guard threshold ${formatPower(thresholdWatts)}` : "Guard threshold unavailable"}</small></article><article><span>{t("disasterPrepPriority")}</span><strong>{t(status?.batteryStrategy?.kind === "backup-preparation" ? "Active" : "Inactive")}</strong><small>{status?.batteryStrategy?.kind === "backup-preparation" ? "Backup readiness owns the battery; Adaptive Charging can observe but cannot issue commands." : "Adaptive Charging may operate when its plan and safety checks allow."}</small></article><article className="protection-owner"><span>{t("operationalOwner")}</span><strong>{status?.batteryStrategy?.title ?? "Unavailable"}</strong><small>{formatDateTimesInText(status?.batteryStrategy?.description ?? "Waiting for battery strategy")}</small></article></div></section>

        <section className="panel automation-plan" aria-labelledby="automation-plan-heading"><div className="section-heading"><div><p className="eyebrow">{t("todayAndTonight")}</p><h2 id="automation-plan-heading">{t("sharedAutomationTimeline")}</h2></div><div className="automation-plan-actions"><span className="sample-count">{adaptive?.plan?.timeline?.length ?? 0} {" " + t("intervals") + ""}</span><button className="quiet-button" type="button" disabled={busy !== null || !adaptive?.enabled || !configurationReady} onClick={() => void runPlanAction("recalculate")}>{busy === "recalculate" ? "Recalculating…" : "Recalculate plan"}</button>{adaptive?.paused ? <button className="button primary" type="button" disabled={busy !== null || !configurationReady} onClick={() => setConfirmation({ title: "Resume Adaptive Charging", impact: "Adaptive Charging will clear the current pause and recalculate its plan. It may resume control of battery charging when the next eligible discounted window begins. Active Disaster Prep still takes priority.", confirmLabel: "Resume automation", run: () => runPlanAction("resume") })}>{t("resume")}</button> : null}</div></div><Timeline items={adaptive?.plan?.timeline} /><div className="selected-windows"><h3>{t("selectedDiscountedWindows")}</h3>{adaptive?.plan?.slots?.length ? <div>{adaptive.plan.slots.map((slot, index) => <article key={`${slot.start}:${index}`}><span>{t(slot.label ?? "Discounted rate")}</span><strong>{t("{start}–{end}", { start: formatTime(slot.start), end: formatTime(slot.end) })}</strong><small>{formatWh(slot.targetWh)} {" " + t("planned80e610") + ""}{slot.targetSocPercent == null ? "" : ` · target ${formatPercent(slot.targetSocPercent)}`}</small></article>)}</div> : <p>{t("noDiscountedChargingWindowIsSelectedForThisPlan")}</p>}</div>{planResult ? <p className={`inline-save-result ${planResult.ok ? "success" : "failure"}`} role={planResult.ok ? "status" : "alert"}>{planResult.message}</p> : null}</section>

        <div className="automation-context-grid"><AwayWorkspace away={away} busy={busy} result={awayResult} onSubmit={mutateAway} onDelete={removeAway} onBackHome={backHome} /><section className="panel automation-assumptions" aria-labelledby="assumptions-heading"><div className="section-heading"><div><p className="eyebrow">{t("planningBasis")}</p><h2 id="assumptions-heading">{t("forecastAssumptions")}</h2></div></div><dl><div><dt>{t("currentSOC")}</dt><dd>{formatPercent(adaptive?.plan?.currentSocPercent)}</dd></div><div><dt>{t("targetSOC")}</dt><dd>{formatPercent(adaptive?.plan?.targetSocPercent)}</dd></div><div><dt>{t("expectedSunsetSOC")}</dt><dd>{formatPercent(adaptive?.plan?.expectedSunsetSocPercent)}</dd></div><div><dt>{t("forecastConfidence")}</dt><dd>{adaptive?.solarForecastAccuracy?.learned ? `Calibrated · ${adaptive.solarForecastAccuracy.sampleCount ?? 0} days` : `Initial model · ${adaptive?.solarForecastAccuracy?.sampleCount ?? 0} days`}</dd></div><div><dt>{t("forecastSolar")}</dt><dd>{formatEnergy(adaptive?.plan?.predictedSolarKwh)}</dd></div><div><dt>{t("forecastDemand")}</dt><dd>{formatEnergy(adaptive?.plan?.predictedDemandKwh)}</dd></div><div><dt>{t("forecastEneFarm")}</dt><dd>{formatEnergy(adaptive?.plan?.predictedFuelCellKwh)}</dd></div><div><dt>{t("forecastSurplus")}</dt><dd>{formatEnergy(adaptive?.plan?.predictedSurplusKwh)}</dd></div><div><dt>{t("demandGuardHistory")}</dt><dd>{guardPlanningBasis ? t("usesFactorDeliveryReliabilityFromCountComparableWindowsWf0de68", { factor: Math.round(Number(guardPlanningBasis.deliveryFactor) * 100), count: guardPlanningBasis.sampleCount, minutes: Math.round(Number(guardPlanningBasis.interruptionReserveMs) / 60_000) }) : t("collectingComparableInterruptedChargingWindows")}</dd></div></dl></section></div>
        <Activity adaptive={adaptive} guard={guard} receipts={receipts} />
      </> : null}

      {view === "performance" ? <PerformanceView adaptive={adaptive} /> : null}

      {view === "configuration" ? <section className="automation-view-stack" aria-label="Automation configuration"><section className="panel setup-checklist"><div className="section-heading"><div><p className="eyebrow">{t("prerequisites")}</p><h2>{t("setupChecklist")}</h2></div><span className="sample-count">{t("{ready}/{total} {label}", { ready: checks.filter((item) => item.ready).length, total: checks.length, label: t("ready") })}</span></div><ul>{checks.map((item) => <li key={item.label} data-ready={item.ready}><i aria-hidden="true">{item.ready ? "✓" : "!"}</i><div><strong>{item.label}</strong><span>{item.detail}</span>{item.href.startsWith("#") ? <a href={item.href}>{item.action}<span aria-hidden="true">{t("→")}</span></a> : <Link to={item.href}>{item.action}<span aria-hidden="true">{t("→")}</span></Link>}</div></li>)}</ul></section>
        <form id="adaptive-settings" className="panel automation-settings-form" key={`adaptive:${JSON.stringify(config?.adaptiveCharging)}:${JSON.stringify(config?.batteryCapabilities)}`} onSubmit={submitAdaptive}><div className="section-heading"><div><p className="eyebrow">{t("planningSettings")}</p><h2>{t("adaptiveChargingConfiguration")}</h2><p className="section-copy">{t("changesInvalidateTheCurrentPlanAndQueueARecalculation")}</p></div></div><label className="automation-toggle"><input name="enabled" type="checkbox" defaultChecked={config?.adaptiveCharging?.enabled === true} /><span><strong>{t("enableAdaptiveCharging")}</strong><small>{t("allowTheApplicationToSelectAndOperateDiscountedChargingW39f85b")}</small></span></label><div className="automation-form-grid"><label className="field">{t("latitude")}<input name="latitude" type="number" min="-90" max="90" step="0.000001" required defaultValue={config?.adaptiveCharging?.latitude ?? ""} /></label><label className="field">{t("longitude")}<input name="longitude" type="number" min="-180" max="180" step="0.000001" required defaultValue={config?.adaptiveCharging?.longitude ?? ""} /></label><label className="field">{t("arrayPeakCapacity")}<div className="input-suffix"><input name="arrayPeakKw" type="number" min="0.1" step="0.1" required defaultValue={config?.adaptiveCharging?.arrayPeakKw ?? ""} /><span>{t("kw")}</span></div></label><label className="field">{t("panelTilt")}<div className="input-suffix"><input name="panelTiltDegrees" type="number" min="0" max="90" step="1" required defaultValue={config?.adaptiveCharging?.panelTiltDegrees ?? 30} /><span>{t("°")}</span></div></label><label className="field">{t("panelAzimuth")}<div className="input-suffix"><input name="panelAzimuthDegrees" type="number" min="-180" max="180" step="1" required defaultValue={config?.adaptiveCharging?.panelAzimuthDegrees ?? 0} /><span>{t("°")}</span></div></label><label className="field">{t("initialSystemLoss")}<div className="input-suffix"><input name="systemLossPercent" type="number" min="0" max="50" step="1" required defaultValue={config?.adaptiveCharging?.systemLossPercent ?? 14} /><span>{t("%")}</span></div></label><label className="field">{t("maximumOffPeakSOC")}<div className="input-suffix"><input name="targetSocPercent" type="number" min="50" max="100" step="1" required defaultValue={config?.adaptiveCharging?.targetSocPercent ?? 100} /><span>{t("%")}</span></div></label><label className="field">{t("forecastConfidenceMargin")}<div className="input-suffix"><input name="forecastMarginPercent" type="number" min="0" max="50" step="1" required defaultValue={config?.adaptiveCharging?.forecastMarginPercent ?? 10} /><span>{t("%")}</span></div></label><label className="field">{t("usableBatteryCapacity")}<div className="input-suffix"><input name="usableCapacityKwh" type="number" min="0.1" step="0.1" required defaultValue={config?.batteryCapabilities?.usableCapacityKwh ?? ""} /><span>{t("kwh")}</span></div></label><label className="field">{t("maximumChargePower")}<div className="input-suffix"><input name="maximumChargeWatts" type="number" min="50" step="1" required defaultValue={config?.batteryCapabilities?.maximumChargeWatts ?? ""} /><span>{t("w")}</span></div></label><label className="field">{t("roundTripEfficiency")}<div className="input-suffix"><input name="roundTripEfficiencyPercent" type="number" min="50" max="100" step="1" required defaultValue={Math.round((config?.batteryCapabilities?.roundTripEfficiency ?? 0.9) * 100)} /><span>{t("%")}</span></div></label></div><div className="form-footer"><button className="button primary" type="submit" disabled={busy !== null || !config}>{busy === "adaptive-config" ? "Saving…" : "Review and save"}</button>{adaptiveResult ? <p className={`inline-save-result ${adaptiveResult.ok ? "success" : "failure"}`} role={adaptiveResult.ok ? "status" : "alert"}>{adaptiveResult.message}</p> : null}</div></form>
        <form className="panel automation-settings-form" key={`guard:${JSON.stringify(guard)}`} onSubmit={submitGuard}><div className="section-heading"><div><p className="eyebrow">{t("breakerProtection")}</p><h2>{t("demandGuardConfiguration")}</h2><p className="section-copy">{t("demandGuardPausesBatteryChargingBeforeGridImportReachesTec2102")}</p></div></div><label className="automation-toggle"><input name="enabled" type="checkbox" defaultChecked={guard?.enabled === true} /><span><strong>{t("enableDemandGuard")}</strong><small>{t("permitStandbyAndAutoModeChangesWhenProtectingBreakerHeadc1d5bc")}</small></span></label><label className="automation-toggle compact"><input name="dashboardWarningEnabled" type="checkbox" defaultChecked={guard?.dashboardWarningEnabled !== false} /><span><strong>{t("showBreakerRiskWarning")}</strong><small>{t("surfaceApproachingInterventionsInGlobalStatus")}</small></span></label><div className="automation-form-grid guard"><label className="field">{t("breakerLimit")}<div className="input-suffix"><input name="breakerAmps" type="number" min="1" max="400" step="1" required defaultValue={guard?.conditions?.breakerAmps ?? 40} /><span>{t("a")}</span></div></label><label className="field">{t("reservedHeadroom")}<div className="input-suffix"><input name="reserveAmps" type="number" min="0" max="200" step="1" required defaultValue={guard?.conditions?.reserveAmps ?? 5} /><span>{t("a")}</span></div></label><label className="field">{t("restoreBelow")}<div className="input-suffix"><input name="restoreBelowAmps" type="number" min="1" max="400" step="1" required defaultValue={guard?.conditions?.restoreBelowAmps ?? 30} /><span>{t("a")}</span></div></label><label className="field">{t("restoreDelay")}<div className="input-suffix"><input name="restoreDelaySeconds" type="number" min="0" max="86400" step="30" required defaultValue={guard?.conditions?.restoreDelaySeconds ?? 300} /><span>{t("sec")}</span></div></label></div><div className="form-footer"><button className="button primary" type="submit" disabled={busy !== null}>{busy === "guard-config" ? "Saving…" : "Save Demand Guard"}</button>{guardResult ? <p className={`inline-save-result ${guardResult.ok ? "success" : "failure"}`} role={guardResult.ok ? "status" : "alert"}>{guardResult.message}</p> : null}</div></form></section> : null}

      {confirmation ? <ConfirmationDialog confirmation={confirmation} close={() => setConfirmation(null)} /> : null}
    </main>
  );
}
