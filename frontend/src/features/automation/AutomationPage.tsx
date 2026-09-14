import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  createAwayPeriod,
  deleteAwayPeriod,
  endAwayPeriod,
  extendAwayPeriod,
  recalculateAdaptiveCharging,
  resumeAdaptiveCharging,
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
  CommandReceipt,
} from "../../api/contracts";
import { updateConfig } from "../../api/queries";
import { formatEnergy, formatPercent, formatPower, metricValue } from "../../core/format";
import { useAutomation } from "../../hooks/useAutomation";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { T, useI18n } from "../../i18n";

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

function formatDateTime(value?: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value?: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

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
    { label: "Off-peak electricity pricing", ready: Boolean(config && config.rateMode !== "simple"), detail: "One discounted off-peak window is enough; a multi-rate plan is optional.", action: "Open rate settings", href: "/ui/system/rates" },
    { label: "Solar generation", ready: config?.solarEnabled !== false, detail: "Solar production must be available for the next-day forecast.", action: "Open equipment settings", href: "/ui/system/equipment" },
    { label: "House demand", ready: config?.smartCosmoEnabled !== false, detail: "Whole-home demand history is required to predict consumption.", action: "Open equipment settings", href: "/ui/system/equipment" },
    { label: "Home location", ready: Number.isFinite(Number(adaptive?.latitude)) && Number.isFinite(Number(adaptive?.longitude)), detail: "Latitude and longitude drive sunrise and weather forecasts.", action: "Review planning settings", href: "#adaptive-settings" },
    { label: "Solar array", ready: Number(adaptive?.arrayPeakKw) > 0, detail: "Array peak capacity is required to scale the solar forecast.", action: "Review planning settings", href: "#adaptive-settings" },
    { label: "Battery capacity and charge power", ready: Number(config?.batteryCapabilities?.usableCapacityKwh) > 0 && Number(config?.batteryCapabilities?.maximumChargeWatts) > 0, detail: "Usable capacity and maximum charging power bound the plan.", action: "Review planning settings", href: "#adaptive-settings" },
  ];
}

function masterState(adaptive: AdaptiveChargingStatus | null, checks: Prerequisite[]) {
  if (!adaptive) return { label: "Loading", tone: "neutral", detail: "Reading automation status." };
  if (checks.some((item) => !item.ready)) return { label: "Needs setup", tone: "warning", detail: `${checks.filter((item) => !item.ready).length} prerequisites still need attention.` };
  if (!adaptive.enabled) return { label: "Paused", tone: "neutral", detail: "Adaptive Charging is configured but disabled." };
  if (adaptive.paused) return { label: "Paused", tone: "warning", detail: adaptive.pausedUntil ? `Paused until ${formatDateTime(adaptive.pausedUntil)}.` : "Paused by an operational override." };
  if (!adaptive.available) return { label: "Degraded", tone: "critical", detail: adaptive.reason ?? "Automation cannot currently produce a safe plan." };
  if (adaptive.batteryModel?.status === "learning") return { label: "Learning", tone: "info", detail: "The plan is active while the battery model gathers enough evidence to calibrate itself." };
  return { label: "Running", tone: "positive", detail: "Automation is available and monitoring the active plan." };
}

function nextAction(adaptive: AdaptiveChargingStatus | null, checks: Prerequisite[]) {
  if (!adaptive) return { title: "Reading the current plan", reason: "Waiting for automation status." };
  const firstMissing = checks.find((item) => !item.ready);
  if (firstMissing) return { title: `Complete ${firstMissing.label.toLowerCase()} setup`, reason: firstMissing.detail };
  if (!adaptive.enabled) return { title: "Enable Adaptive Charging when ready", reason: "No automated battery charging will be scheduled while it is disabled." };
  if (adaptive.paused) return { title: adaptive.pausedUntil ? `Resume after ${formatDateTime(adaptive.pausedUntil)}` : "Resume Adaptive Charging", reason: adaptive.reason ?? "A manual or safety override currently owns battery operation." };
  if (adaptive.owner === "adaptiveCharging" && adaptive.activeSlot) return { title: `Charge until ${formatTime(adaptive.activeSlot.end ?? adaptive.activeSlot.windowEnd)}`, reason: adaptive.plan?.reason ?? `The active discounted window is working toward ${formatPercent(adaptive.activeSlot.targetSocPercent)} state of charge.` };
  const now = Date.now();
  const slot = adaptive.plan?.slots?.find((item) => new Date(item.end).getTime() > now);
  if (slot) return { title: `Charge ${formatTime(slot.start)}–${formatTime(slot.end)}`, reason: `Planned during a discounted window${slot.targetSocPercent == null ? "." : ` to work toward ${formatPercent(slot.targetSocPercent)} state of charge.`}` };
  return { title: "No grid charging is currently planned", reason: adaptive.warning ?? adaptive.plan?.reason ?? "Forecast demand and local generation do not require a charging window yet." };
}

function demandGuard(rules: AutomationRule[]) {
  return rules.find((item) => item.type === "backup-demand-guard") ?? null;
}

function Timeline({ items = [] }: { items?: AdaptiveTimelineItem[] }) {
  const { text } = useI18n();
  if (!items.length) return <div className="automation-empty" role="status"><T text={"No plan timeline is available yet. Complete setup or recalculate after forecast data becomes available."} /></div>;
  const start = new Date(items[0].start).getTime();
  const end = new Date(items.at(-1)?.end ?? items[0].end).getTime();
  const duration = Math.max(1, end - start);
  return (
    <div className="automation-timeline" aria-label={text("Today and tonight automation plan")}>
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
      <div className="automation-timeline-legend"><span data-tone="charge"><T text={"Planned charging"} /></span><span data-tone="discount"><T text={"Discounted period"} /></span><span data-tone="away"><T text={"Away assumptions"} /></span><span data-tone="observe"><T text={"Forecast only"} /></span></div>
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
  const rows = useMemo<ActivityRow[]>(() => [
    ...(adaptive?.log ?? []).map((entry) => ({ at: entry.at, kind: entry.kind ?? "info", actor: "Adaptive Charging", message: entry.message ?? "No detail recorded", result: activityResult(entry.kind) })),
    ...(guard?.log ?? []).map((entry) => ({ at: entry.at, kind: entry.kind ?? "info", actor: "Demand Guard", message: entry.message ?? "No detail recorded", result: activityResult(entry.kind) })),
    ...receipts.filter((receipt) => automationReceiptSources.has(receipt.source)).map((receipt) => ({ at: receipt.completedAt ?? receipt.requestedAt, kind: receipt.state, actor: receiptActor(receipt.source), message: receipt.message ?? `${receipt.action.replaceAll("-", " ")} requested`, result: receiptResult(receipt) })),
  ].sort((left, right) => new Date(right.at ?? 0).getTime() - new Date(left.at ?? 0).getTime()).slice(0, 16), [adaptive?.log, guard?.log, receipts]);

  return (
    <section className="panel automation-activity" aria-labelledby="automation-activity-heading">
      <div className="section-heading"><div><p className="eyebrow"><T text={"Audit trail"} /></p><h2 id="automation-activity-heading"><T text={"Recent activity"} /></h2></div></div>
      {rows.length ? <div className="table-scroll"><table><thead><tr><th><T text={"Severity"} /></th><th><T text={"Time"} /></th><th><T text={"Actor"} /></th><th><T text={"Action and reason"} /></th><th><T text={"Result"} /></th></tr></thead><tbody>{rows.map((entry, index) => <tr key={`${entry.at}:${entry.actor}:${index}`}><td><span className="event-severity" data-kind={entry.kind}>{entry.kind}</span></td><td>{formatDateTime(entry.at)}</td><td>{entry.actor}</td><td>{entry.message}</td><td>{entry.result}</td></tr>)}</tbody></table></div> : <p className="automation-empty"><T text={"No automation activity has been recorded yet."} /></p>}
    </section>
  );
}

function ConfirmationDialog({ confirmation, close }: { confirmation: NonNullable<Confirmation>; close: () => void }) {
  const [busy, setBusy] = useState(false);
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
      <section className="command-dialog panel" role="dialog" aria-modal="true" aria-labelledby="automation-confirm-title">
        <p className="eyebrow"><T text={"Review automation change"} /></p>
        <h2 id="automation-confirm-title">{confirmation.title}</h2>
        <p className="impact-note">{confirmation.impact}</p>
        <div className="button-row dialog-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={close}><T text={"Cancel"} /></button>
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
  const { text } = useI18n();
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
        <div><p className="eyebrow"><T text={"Occupancy context"} /></p><h2 id="away-summary-heading"><T text={"Away schedule"} /></h2></div>
        <span className="automation-status-pill" data-tone={away.state === "away" ? "warning" : "positive"}>{away.state === "away" ? "Away" : "Home"}</span>
      </div>
      <p className="section-copy"><T text={"Away periods reduce forecast demand assumptions and queue a fresh charging plan. They do not directly control household equipment."} /></p>
      {away.active ? <div className="away-active"><div><strong><T text={"Away now"} /></strong><span><T text={"Expected home "} />{formatDateTime(away.active.until)}</span></div><div className="button-row"><button className="quiet-button" type="button" disabled={busy !== null} onClick={() => edit(away.active as AwayPeriod, "extend")}><T text={"Extend"} /></button><button className="button primary" type="button" disabled={busy !== null} onClick={() => void onBackHome(away.active as AwayPeriod)}><T text={"Back home"} /></button></div></div> : null}
      <form className="away-form" onSubmit={(event) => void submit(event)}>
        <div className="section-heading away-form-heading"><div><h3>{draft.mode === "edit" ? "Edit Away period" : draft.mode === "extend" ? "Extend Away period" : draft.source === "manual" ? "Away now" : "Schedule Away period"}</h3><p>{draft.source === "manual" ? "Confirm when you expect to return before starting Away mode." : "The plan will use lower demand assumptions for this period."}</p></div>{draft.mode !== "create" || draft.source === "manual" ? <button className="text-button" type="button" onClick={reset}><T text={"Cancel"} /></button> : null}</div>
        <div className="away-form-grid">
          <label className="field"><T text={"From"} /><input aria-label={text("Away from")} type="datetime-local" required disabled={draft.mode === "extend"} value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} /></label>
          <label className="field"><T text={"Until"} /><input aria-label={text("Away until")} type="datetime-local" required value={draft.until} onChange={(event) => setDraft((current) => ({ ...current, until: event.target.value }))} /></label>
          <div className="away-form-actions"><button className="quiet-button" type="button" disabled={busy !== null || away.active !== null} onClick={beginNow}><T text={"Away now"} /></button><button className="button primary" type="submit" disabled={busy !== null}>{busy === "away" ? "Saving…" : draft.mode === "edit" ? "Save period" : draft.mode === "extend" ? "Save extension" : draft.source === "manual" ? "Start Away period" : "Add period"}</button></div>
        </div>
      </form>
      {result ? <p className={`inline-save-result ${result.ok ? "success" : "failure"}`} role={result.ok ? "status" : "alert"}>{result.message}</p> : null}
      <div className="away-period-list">
        <h3><T text={"Upcoming periods"} /></h3>
        {away.periods.filter((period) => period.status !== "active").length ? away.periods.filter((period) => period.status !== "active").map((period) => <article key={period.id}><div><strong>{formatDateTime(period.from)}</strong><span><T text={"Until "} />{formatDateTime(period.until)} · {period.source === "manual" ? "Started manually" : "Scheduled"}</span></div><div className="button-row">{deleteCandidate?.id === period.id ? <><span className="delete-prompt"><T text={"Remove this period?"} /></span><button className="quiet-button" type="button" onClick={() => setDeleteCandidate(null)}><T text={"Keep"} /></button><button className="button danger" type="button" disabled={busy !== null} onClick={() => void onDelete(period).then(() => setDeleteCandidate(null))}><T text={"Remove"} /></button></> : <><button className="quiet-button" type="button" disabled={busy !== null} onClick={() => edit(period, "edit")}><T text={"Edit"} /></button><button className="quiet-button danger" type="button" disabled={busy !== null} onClick={() => setDeleteCandidate(period)}><T text={"Delete"} /></button></>}</div></article>) : <p className="automation-empty compact"><T text={"No future Away periods are scheduled."} /></p>}
      </div>
      <p className="panel-note"><T text={"Normal demand assumptions resume after the return time plus a "} />{away.returnBufferMinutes ?? 30}<T text={"-minute buffer."} /></p>
    </section>
  );
}

function formatWh(value?: number | null) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} Wh` : "—";
}

function signedEnergy(value?: number | null) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)} kWh`;
}

function PerformanceView({ adaptive }: { adaptive: AdaptiveChargingStatus | null }) {
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
      const predictedKwh = Number(outcome.medianW) * hours / 1000;
      const actualKwh = Number(outcome.actualKwh);
      return { ...outcome, start, end, predictedKwh, actualKwh, errorKwh: actualKwh - predictedKwh };
    }).filter((outcome) => Number.isFinite(outcome.start.getTime()) && Number.isFinite(outcome.end.getTime()) && Number.isFinite(outcome.predictedKwh) && Number.isFinite(outcome.actualKwh));
  }, [adaptive?.fuelCellForecastOutcomes]);
  const solarMae = solarOutcomes.map((outcome) => Math.abs(Number(outcome.errorKwh))).filter(Number.isFinite);
  const fuelMae = fuelOutcomes.map((outcome) => Math.abs(outcome.errorKwh));

  return (
    <section className="automation-view-stack" aria-label="Automation performance">
      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow"><T text={"Current planning evidence"} /></p><h2><T text={"Forecast and control performance"} /></h2><p className="section-copy"><T text={"Planning values are estimates. Outcome rows distinguish forecasts from recorded or partially estimated results."} /></p></div></div>
        <div className="performance-domain-grid">
          <article><span><T text={"Solar forecast"} /></span><strong>{formatEnergy(plan?.predictedSolarKwh)}</strong><small><T text={"Estimated for the current horizon · "} />{solarOutcomes.length} <T text={" completed days"} /></small></article>
          <article><span><T text={"Demand forecast"} /></span><strong>{formatEnergy(plan?.predictedDemandKwh)}</strong><small><T text={"Estimated from "} />{demandDays} <T text={" valid historical days"} /></small></article>
          <article><span><T text={"Battery plan"} /></span><strong>{formatEnergy(plan?.plannedChargeKwh)}</strong><small><T text={"Estimated grid charge · "} />{windowOutcomes.length} <T text={" completed windows"} /></small></article>
          <article><span><T text={"Ene-Farm forecast"} /></span><strong>{formatEnergy(plan?.predictedFuelCellKwh)}</strong><small><T text={"Estimated contribution · "} />{fuelOutcomes.length} <T text={" completed intervals"} /></small></article>
        </div>
      </section>
      <section className="performance-detail-grid">
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow"><T text={"Solar"} /></p><h2><T text={"Forecast outcomes"} /></h2></div><span className="quality-label">{adaptive?.solarForecastAccuracy?.learned ? "Calibrated estimate" : "Learning estimate"}</span></div><dl className="performance-summary"><div><dt><T text={"Evidence"} /></dt><dd>{adaptive?.solarForecastAccuracy?.sampleCount ?? 0} <T text={" days"} /></dd></div><div><dt><T text={"Mean absolute error"} /></dt><dd>{solarMae.length ? formatEnergy(solarMae.reduce((sum, value) => sum + value, 0) / solarMae.length) : "—"}</dd></div></dl>{solarOutcomes.length ? <div className="table-scroll"><table><thead><tr><th><T text={"Date"} /></th><th><T text={"Issued estimate"} /></th><th><T text={"Planning estimate"} /></th><th><T text={"Recorded generation"} /></th><th><T text={"Error"} /></th></tr></thead><tbody>{[...solarOutcomes].reverse().slice(0, 8).map((outcome, index) => <tr key={`${outcome.targetDate}:${index}`}><td>{outcome.targetDate ?? "—"}</td><td>{formatEnergy(outcome.predictedKwh)}</td><td>{formatEnergy(outcome.planningKwh)}</td><td>{formatEnergy(outcome.actualKwh)}</td><td>{signedEnergy(outcome.errorKwh)}</td></tr>)}</tbody></table></div> : <p className="automation-empty compact"><T text={"No completed solar forecast days yet."} /></p>}</article>
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow"><T text={"Demand"} /></p><h2><T text={"Historical model"} /></h2></div><span className="quality-label"><T text={"Estimated"} /></span></div><dl className="performance-summary"><div><dt><T text={"Recorded days"} /></dt><dd>{plan?.demandHistory?.recordedDayCount ?? 0}</dd></div><div><dt><T text={"Valid days"} /></dt><dd>{plan?.demandHistory?.validDayCount ?? 0}</dd></div><div><dt><T text={"Recent comparisons"} /></dt><dd>{plan?.demandHistory?.recentComparableDayCount ?? 0}</dd></div><div><dt><T text={"Seasonal comparisons"} /></dt><dd>{plan?.demandHistory?.seasonalComparableDayCount ?? 0}</dd></div></dl><p className="panel-note"><T text={"The current API exposes demand-model evidence and the active estimate, but not a separate settled demand-error series."} /></p></article>
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow"><T text={"Battery"} /></p><h2><T text={"Charging-window outcomes"} /></h2></div><span className="quality-label"><T text={"Recorded + estimated"} /></span></div>{windowOutcomes.length ? <div className="table-scroll"><table><thead><tr><th><T text={"Window"} /></th><th><T text={"Planned"} /></th><th><T text={"Delivered"} /></th><th><T text={"SOC"} /></th><th><T text={"Result"} /></th></tr></thead><tbody>{windowOutcomes.slice(0, 8).map((outcome, index) => <tr key={`${outcome.key}:${index}`}><td>{formatDateTime(outcome.windowStart)}<small>{outcome.label ?? "Discounted"}</small></td><td>{formatWh(outcome.plannedWh)}</td><td>{formatWh(outcome.deliveredWh)}{Number(outcome.estimatedDeliveryWh) > 0 ? <small>{formatWh(outcome.estimatedDeliveryWh)} <T text={" boundary estimate"} /></small> : null}</td><td>{formatPercent(outcome.startSocPercent)} → {formatPercent(outcome.endSocPercent)}</td><td>{outcome.socTargetReached ? "Target reached" : Number(outcome.unmetWh) > 0 ? `${formatWh(outcome.unmetWh)} short` : "Completed"}</td></tr>)}</tbody></table></div> : <p className="automation-empty compact"><T text={"No completed charging windows yet."} /></p>}</article>
        <article className="panel performance-evidence"><div className="section-heading"><div><p className="eyebrow"><T text={"Ene-Farm"} /></p><h2><T text={"Forecast outcomes"} /></h2></div><span className="quality-label"><T text={"Estimated vs recorded"} /></span></div><dl className="performance-summary"><div><dt><T text={"Completed intervals"} /></dt><dd>{fuelOutcomes.length}</dd></div><div><dt><T text={"Mean absolute error"} /></dt><dd>{fuelMae.length ? formatEnergy(fuelMae.reduce((sum, value) => sum + value, 0) / fuelMae.length) : "—"}</dd></div></dl>{fuelOutcomes.length ? <div className="table-scroll"><table><thead><tr><th><T text={"Interval"} /></th><th><T text={"Median estimate"} /></th><th><T text={"Recorded output"} /></th><th><T text={"Error"} /></th><th><T text={"Plan influence"} /></th></tr></thead><tbody>{fuelOutcomes.slice(0, 8).map((outcome, index) => <tr key={`${outcome.targetStart}:${index}`}><td>{formatTime(outcome.start.toISOString())}–{formatTime(outcome.end.toISOString())}</td><td>{formatEnergy(outcome.predictedKwh)}</td><td>{formatEnergy(outcome.actualKwh)}</td><td>{signedEnergy(outcome.errorKwh)}</td><td>{outcome.influence ?? "—"}</td></tr>)}</tbody></table></div> : <p className="automation-empty compact"><T text={"No completed Ene-Farm forecast intervals yet."} /></p>}</article>
      </section>
      <section className="panel model-progress"><div className="section-heading"><div><p className="eyebrow"><T text={"Battery learning"} /></p><h2><T text={"Model evidence"} /></h2></div><span className="quality-label">{adaptive?.batteryModel?.status ?? "Unavailable"} <T text={" · v"} />{adaptive?.batteryModel?.version ?? "—"}</span></div><dl><div><dt><T text={"Charge observations"} /></dt><dd>{adaptive?.batteryModel?.charge?.acceptedObservationCount ?? 0}</dd></div><div><dt><T text={"Discharge observations"} /></dt><dd>{adaptive?.batteryModel?.discharge?.acceptedObservationCount ?? 0}</dd></div><div><dt><T text={"Charge-power samples"} /></dt><dd>{adaptive?.batteryModel?.power?.sampleCount ?? 0}</dd></div><div><dt><T text={"Charging sessions"} /></dt><dd>{adaptive?.batteryModel?.power?.sessionCount ?? 0}</dd></div></dl></section>
    </section>
  );
}

function numberValue(form: FormData, name: string) {
  return Number(form.get(name));
}

export function AutomationPage() {
  const { text } = useI18n();
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
      setPlanResult({ ok: false, message: reason instanceof Error ? reason.message : "Automation action failed" });
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
      setAdaptiveResult({ ok: false, message: reason instanceof Error ? reason.message : "Adaptive Charging settings could not be saved" });
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
      setGuardResult({ ok: false, message: reason instanceof Error ? reason.message : "Demand Guard settings could not be saved" });
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
      setAwayResult({ ok: false, message: reason instanceof Error ? reason.message : "Away period could not be saved" });
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
      setAwayResult({ ok: false, message: reason instanceof Error ? reason.message : "Away period could not be removed" });
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
      setAwayResult({ ok: false, message: reason instanceof Error ? reason.message : "Home state could not be restored" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page automation-page">
      <header className="page-heading"><div><p className="eyebrow"><T text={"Decide"} /></p><h1><T text={"Automation"} /></h1><p><T text={"Understand what the system will do next, why it chose that action, and which protections can intervene."} /></p></div><button className="quiet-button" type="button" onClick={refresh} disabled={loading || manualRefreshing}>{loading ? "Loading…" : manualRefreshing ? "Refreshing…" : "Refresh"}</button></header>
      {error ? <div className="status-banner" data-severity="critical"><T text={"Automation: "} />{error}</div> : null}

      <nav className="automation-tabs" aria-label={text("Automation views")}>{(["plan", "performance", "configuration"] as AutomationView[]).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}>{text(item[0].toUpperCase() + item.slice(1))}</button>)}</nav>

      {view === "plan" ? <>
        <section className="automation-summary-grid" aria-label="Automation summary">
          <article className="panel automation-master"><p className="eyebrow"><T text={"System state"} /></p><div className="automation-master-state"><h2>{state.label}</h2><span data-tone={state.tone} /></div><p>{state.detail}</p></article>
          <article className="panel automation-next"><p className="eyebrow"><T text={"Next action"} /></p><h2>{next.title}</h2><p>{next.reason}</p>{adaptive?.plan?.targetSunset ? <small><T text={"Plan horizon: "} />{formatDateTime(adaptive.plan.targetSunset)}</small> : null}</article>
        </section>

        <section className="panel automation-protections" aria-labelledby="protections-heading"><div className="section-heading"><div><p className="eyebrow"><T text={"Safety"} /></p><h2 id="protections-heading"><T text={"Active protections"} /></h2></div></div><div className="protection-grid"><article><span><T text={"Demand Guard"} /></span><strong>{guard?.enabled ? guard.state?.awaitingRestore ? "Intervening" : "Monitoring" : "Off"}</strong><small>{guard?.enabled ? `${formatPower(headroom)} headroom before intervention` : "Breaker protection is disabled"}</small></article><article><span><T text={"Breaker contract"} /></span><strong>{formatPower(Number.isFinite(breakerWatts) ? breakerWatts : null)}</strong><small>{guard?.conditions?.breakerAmps ?? "—"} <T text={" A at "} />{guard?.conditions?.breakerVoltage ?? "—"} <T text={" V"} /></small></article><article><span><T text={"Current grid import"} /></span><strong>{formatPower(gridImport)}</strong><small>{Number.isFinite(thresholdWatts) ? `Guard threshold ${formatPower(thresholdWatts)}` : "Guard threshold unavailable"}</small></article><article><span><T text={"Disaster Prep priority"} /></span><strong>{status?.batteryStrategy?.kind === "backup-preparation" ? "Active" : "Inactive"}</strong><small>{status?.batteryStrategy?.kind === "backup-preparation" ? "Backup readiness owns the battery; Adaptive Charging can observe but cannot issue commands." : "Adaptive Charging may operate when its plan and safety checks allow."}</small></article><article className="protection-owner"><span><T text={"Operational owner"} /></span><strong>{status?.batteryStrategy?.title ?? "Unavailable"}</strong><small>{status?.batteryStrategy?.description ?? "Waiting for battery strategy"}</small></article></div></section>

        <section className="panel automation-plan" aria-labelledby="automation-plan-heading"><div className="section-heading"><div><p className="eyebrow"><T text={"Today and tonight"} /></p><h2 id="automation-plan-heading"><T text={"Shared automation timeline"} /></h2></div><div className="automation-plan-actions"><span className="sample-count">{adaptive?.plan?.timeline?.length ?? 0} <T text={" intervals"} /></span><button className="quiet-button" type="button" disabled={busy !== null || !adaptive?.enabled || !configurationReady} onClick={() => void runPlanAction("recalculate")}>{busy === "recalculate" ? "Recalculating…" : "Recalculate plan"}</button>{adaptive?.paused ? <button className="button primary" type="button" disabled={busy !== null || !configurationReady} onClick={() => setConfirmation({ title: "Resume Adaptive Charging", impact: "Adaptive Charging will clear the current pause and recalculate its plan. It may resume control of battery charging when the next eligible discounted window begins. Active Disaster Prep still takes priority.", confirmLabel: "Resume automation", run: () => runPlanAction("resume") })}><T text={"Resume"} /></button> : null}</div></div><Timeline items={adaptive?.plan?.timeline} /><div className="selected-windows"><h3><T text={"Selected discounted windows"} /></h3>{adaptive?.plan?.slots?.length ? <div>{adaptive.plan.slots.map((slot, index) => <article key={`${slot.start}:${index}`}><span>{slot.label ?? "Discounted rate"}</span><strong>{formatTime(slot.start)}–{formatTime(slot.end)}</strong><small>{formatWh(slot.targetWh)} <T text={" planned"} />{slot.targetSocPercent == null ? "" : ` · target ${formatPercent(slot.targetSocPercent)}`}</small></article>)}</div> : <p><T text={"No discounted charging window is selected for this plan."} /></p>}</div>{planResult ? <p className={`inline-save-result ${planResult.ok ? "success" : "failure"}`} role={planResult.ok ? "status" : "alert"}>{planResult.message}</p> : null}</section>

        <div className="automation-context-grid"><AwayWorkspace away={away} busy={busy} result={awayResult} onSubmit={mutateAway} onDelete={removeAway} onBackHome={backHome} /><section className="panel automation-assumptions" aria-labelledby="assumptions-heading"><div className="section-heading"><div><p className="eyebrow"><T text={"Planning basis"} /></p><h2 id="assumptions-heading"><T text={"Forecast assumptions"} /></h2></div></div><dl><div><dt><T text={"Current SOC"} /></dt><dd>{formatPercent(adaptive?.plan?.currentSocPercent)}</dd></div><div><dt><T text={"Target SOC"} /></dt><dd>{formatPercent(adaptive?.plan?.targetSocPercent)}</dd></div><div><dt><T text={"Expected sunset SOC"} /></dt><dd>{formatPercent(adaptive?.plan?.expectedSunsetSocPercent)}</dd></div><div><dt><T text={"Forecast confidence"} /></dt><dd>{adaptive?.solarForecastAccuracy?.learned ? `Calibrated · ${adaptive.solarForecastAccuracy.sampleCount ?? 0} days` : `Initial model · ${adaptive?.solarForecastAccuracy?.sampleCount ?? 0} days`}</dd></div><div><dt><T text={"Forecast solar"} /></dt><dd>{formatEnergy(adaptive?.plan?.predictedSolarKwh)}</dd></div><div><dt><T text={"Forecast demand"} /></dt><dd>{formatEnergy(adaptive?.plan?.predictedDemandKwh)}</dd></div><div><dt><T text={"Forecast Ene-Farm"} /></dt><dd>{formatEnergy(adaptive?.plan?.predictedFuelCellKwh)}</dd></div><div><dt><T text={"Forecast surplus"} /></dt><dd>{formatEnergy(adaptive?.plan?.predictedSurplusKwh)}</dd></div></dl></section></div>
        <Activity adaptive={adaptive} guard={guard} receipts={receipts} />
      </> : null}

      {view === "performance" ? <PerformanceView adaptive={adaptive} /> : null}

      {view === "configuration" ? <section className="automation-view-stack" aria-label="Automation configuration"><section className="panel setup-checklist"><div className="section-heading"><div><p className="eyebrow"><T text={"Prerequisites"} /></p><h2><T text={"Setup checklist"} /></h2></div><span className="sample-count">{checks.filter((item) => item.ready).length}/{checks.length} <T text={" ready"} /></span></div><ul>{checks.map((item) => <li key={item.label} data-ready={item.ready}><i aria-hidden="true">{item.ready ? "✓" : "!"}</i><div><strong>{item.label}</strong><span>{item.detail}</span><a href={item.href}>{item.action}<span aria-hidden="true"> →</span></a></div></li>)}</ul></section>
        <form id="adaptive-settings" className="panel automation-settings-form" key={`adaptive:${JSON.stringify(config?.adaptiveCharging)}:${JSON.stringify(config?.batteryCapabilities)}`} onSubmit={submitAdaptive}><div className="section-heading"><div><p className="eyebrow"><T text={"Planning settings"} /></p><h2><T text={"Adaptive Charging configuration"} /></h2><p className="section-copy"><T text={"Changes invalidate the current plan and queue a recalculation."} /></p></div></div><label className="automation-toggle"><input name="enabled" type="checkbox" defaultChecked={config?.adaptiveCharging?.enabled === true} /><span><strong><T text={"Enable Adaptive Charging"} /></strong><small><T text={"Allow the application to select and operate discounted charging windows."} /></small></span></label><div className="automation-form-grid"><label className="field"><T text={"Latitude"} /><input name="latitude" type="number" min="-90" max="90" step="0.000001" required defaultValue={config?.adaptiveCharging?.latitude ?? ""} /></label><label className="field"><T text={"Longitude"} /><input name="longitude" type="number" min="-180" max="180" step="0.000001" required defaultValue={config?.adaptiveCharging?.longitude ?? ""} /></label><label className="field"><T text={"Array peak capacity"} /><div className="input-suffix"><input name="arrayPeakKw" type="number" min="0.1" step="0.1" required defaultValue={config?.adaptiveCharging?.arrayPeakKw ?? ""} /><span><T text={"kW"} /></span></div></label><label className="field"><T text={"Panel tilt"} /><div className="input-suffix"><input name="panelTiltDegrees" type="number" min="0" max="90" step="1" required defaultValue={config?.adaptiveCharging?.panelTiltDegrees ?? 30} /><span>°</span></div></label><label className="field"><T text={"Panel azimuth"} /><div className="input-suffix"><input name="panelAzimuthDegrees" type="number" min="-180" max="180" step="1" required defaultValue={config?.adaptiveCharging?.panelAzimuthDegrees ?? 0} /><span>°</span></div></label><label className="field"><T text={"Initial system loss"} /><div className="input-suffix"><input name="systemLossPercent" type="number" min="0" max="50" step="1" required defaultValue={config?.adaptiveCharging?.systemLossPercent ?? 14} /><span>%</span></div></label><label className="field"><T text={"Maximum off-peak SOC"} /><div className="input-suffix"><input name="targetSocPercent" type="number" min="50" max="100" step="1" required defaultValue={config?.adaptiveCharging?.targetSocPercent ?? 100} /><span>%</span></div></label><label className="field"><T text={"Forecast confidence margin"} /><div className="input-suffix"><input name="forecastMarginPercent" type="number" min="0" max="50" step="1" required defaultValue={config?.adaptiveCharging?.forecastMarginPercent ?? 10} /><span>%</span></div></label><label className="field"><T text={"Usable battery capacity"} /><div className="input-suffix"><input name="usableCapacityKwh" type="number" min="0.1" step="0.1" required defaultValue={config?.batteryCapabilities?.usableCapacityKwh ?? ""} /><span><T text={"kWh"} /></span></div></label><label className="field"><T text={"Maximum charge power"} /><div className="input-suffix"><input name="maximumChargeWatts" type="number" min="50" step="1" required defaultValue={config?.batteryCapabilities?.maximumChargeWatts ?? ""} /><span><T text={"W"} /></span></div></label></div><div className="form-footer"><button className="button primary" type="submit" disabled={busy !== null || !config}>{busy === "adaptive-config" ? "Saving…" : "Review and save"}</button>{adaptiveResult ? <p className={`inline-save-result ${adaptiveResult.ok ? "success" : "failure"}`} role={adaptiveResult.ok ? "status" : "alert"}>{adaptiveResult.message}</p> : null}</div></form>
        <form className="panel automation-settings-form" key={`guard:${JSON.stringify(guard)}`} onSubmit={submitGuard}><div className="section-heading"><div><p className="eyebrow"><T text={"Breaker protection"} /></p><h2><T text={"Demand Guard configuration"} /></h2><p className="section-copy"><T text={"Demand Guard pauses battery charging before grid import reaches the configured breaker margin."} /></p></div></div><label className="automation-toggle"><input name="enabled" type="checkbox" defaultChecked={guard?.enabled === true} /><span><strong><T text={"Enable Demand Guard"} /></strong><small><T text={"Permit Standby and Auto mode changes when protecting breaker headroom."} /></small></span></label><label className="automation-toggle compact"><input name="dashboardWarningEnabled" type="checkbox" defaultChecked={guard?.dashboardWarningEnabled !== false} /><span><strong><T text={"Show breaker-risk warning"} /></strong><small><T text={"Surface approaching interventions in global status."} /></small></span></label><div className="automation-form-grid guard"><label className="field"><T text={"Breaker limit"} /><div className="input-suffix"><input name="breakerAmps" type="number" min="1" max="400" step="1" required defaultValue={guard?.conditions?.breakerAmps ?? 40} /><span><T text={"A"} /></span></div></label><label className="field"><T text={"Reserved headroom"} /><div className="input-suffix"><input name="reserveAmps" type="number" min="0" max="200" step="1" required defaultValue={guard?.conditions?.reserveAmps ?? 5} /><span><T text={"A"} /></span></div></label><label className="field"><T text={"Restore below"} /><div className="input-suffix"><input name="restoreBelowAmps" type="number" min="1" max="400" step="1" required defaultValue={guard?.conditions?.restoreBelowAmps ?? 30} /><span><T text={"A"} /></span></div></label><label className="field"><T text={"Restore delay"} /><div className="input-suffix"><input name="restoreDelaySeconds" type="number" min="0" max="86400" step="30" required defaultValue={guard?.conditions?.restoreDelaySeconds ?? 300} /><span><T text={"sec"} /></span></div></label></div><div className="form-footer"><button className="button primary" type="submit" disabled={busy !== null}>{busy === "guard-config" ? "Saving…" : "Save Demand Guard"}</button>{guardResult ? <p className={`inline-save-result ${guardResult.ok ? "success" : "failure"}`} role={guardResult.ok ? "status" : "alert"}>{guardResult.message}</p> : null}</div></form></section> : null}

      {confirmation ? <ConfirmationDialog confirmation={confirmation} close={() => setConfirmation(null)} /> : null}
    </main>
  );
}
