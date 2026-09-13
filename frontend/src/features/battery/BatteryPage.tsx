import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { NavLink } from "react-router-dom";
import { useCommandLifecycle } from "../../app/providers";
import {
  createSchedule,
  deleteSchedule,
  getBackupPreparation,
  getCommandReceipts,
  getDeviceCommand,
  getSchedules,
  setBackupPreparation,
  startBatteryAction,
  updateSchedule,
} from "../../api/battery";
import type { BatteryAction } from "../../api/battery";
import type { BackupPreparation, BatterySchedule, CommandReceipt } from "../../api/contracts";
import type { DeviceCommand } from "../../api/commands";
import { CombinedEnergyChart } from "../../components/CombinedEnergyChart";
import type { TimelineOverlay } from "../../components/CombinedEnergyChart";
import { withLatestStatus } from "../../core/energy";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useHistoryRange } from "../../hooks/useHistoryRange";
import { formatPower, formatSoc } from "../../core/format";

type ReviewCommand = DeviceCommand & {
  action: BatteryAction | "backup-start" | "backup-end";
  payload: Record<string, unknown>;
};

const terminalPhases = new Set(["succeeded", "failed", "timed-out", "mismatched"]);
const actionLabels: Record<string, string> = {
  "vendor-profile": "Charging profile",
  "discharge-limit": "Reserve limit",
  "osaifu-charge-window": "Charge window",
  "osaifu-discharge-window": "Discharge window",
  "set-mode": "Operation mode",
  charge: "Manual charge",
  discharge: "Manual discharge",
};
const sourceLabels: Record<string, string> = {
  manual: "Manual control",
  schedule: "Battery schedule",
  "adaptive-charging": "Adaptive Charging",
  "charging-demand-guard": "Demand Guard",
  "backup-preparation": "Disaster Prep / 停電対策",
};

type EverydaySettings = {
  profile: string;
  reserve: number;
  chargeStart: number;
  chargeEnd: number;
  dischargeStart: number;
  dischargeEnd: number;
};

function sentence(value: unknown) {
  return String(value ?? "unknown").replaceAll("_", " ").replaceAll("-", " ");
}

function requestSummary(receipt: CommandReceipt) {
  const values = Object.entries(receipt.request ?? {}).map(([key, value]) => `${sentence(key)} ${String(value)}`);
  return values.length ? values.join(" · ") : "No additional value";
}

async function runBatteryAction(action: BatteryAction, payload: Record<string, unknown>) {
  const started = await startBatteryAction(action, payload);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const receipt = await getDeviceCommand(started.commandId);
    if (terminalPhases.has(receipt.state)) {
      if (receipt.state !== "succeeded") {
        const error = new Error(receipt.error ?? receipt.message ?? `The command ${sentence(receipt.state)}.`) as Error & { commandState?: string };
        error.commandState = receipt.state;
        throw error;
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const error = new Error("The command did not reach a verified result within 60 seconds.") as Error & { commandState?: string };
  error.commandState = "timed-out";
  throw error;
}

function CommandDialog({ command, close, completed }: {
  command: ReviewCommand;
  close: () => void;
  completed: () => Promise<void>;
}) {
  const { state, dispatch } = useCommandLifecycle();
  const [liveReceipt, setLiveReceipt] = useState<CommandReceipt | null>(null);
  const active = state.phase !== "idle" ? state.command.id === command.id : false;
  const phase = active ? state.phase : "confirming";
  const pending = ["sending", "acknowledged", "verifying"].includes(phase);
  const run = async () => {
    dispatch({ type: "send" });
    try {
      if (command.action === "backup-start" || command.action === "backup-end") {
        const result = command.action === "backup-start"
        ? await setBackupPreparation(true, command.payload.allowDemandGuard !== false)
        : await setBackupPreparation(false);
        dispatch({ type: "observe", phase: "succeeded", at: result.lastResult?.at ?? new Date().toISOString() });
      } else {
        const started = await startBatteryAction(command.action, command.payload);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const receipt = await getDeviceCommand(started.commandId);
          setLiveReceipt(receipt);
          if (terminalPhases.has(receipt.state)) {
            dispatch({
              type: "observe",
              phase: receipt.state as "succeeded" | "failed" | "timed-out" | "mismatched",
              message: receipt.error ?? receipt.message ?? undefined,
              at: receipt.completedAt ?? undefined,
            });
            break;
          }
          if (["sending", "acknowledged", "verifying"].includes(receipt.state)) {
            dispatch({ type: "observe", phase: receipt.state as "sending" | "acknowledged" | "verifying" });
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!terminalPhases.has((await getDeviceCommand(started.commandId)).state)) {
          dispatch({ type: "observe", phase: "timed-out", message: "The command did not reach a terminal result within 60 seconds." });
        }
      }
      await completed();
    } catch (reason) {
      const error = reason as Error & { commandState?: string };
      if (error.commandState === "timed-out") dispatch({ type: "timeout", error: error.message });
      else if (error.commandState === "mismatched") dispatch({ type: "mismatch", expected: "requested state", actual: error.message });
      else dispatch({ type: "fail", error: error.message });
      await completed();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="command-dialog panel" role="dialog" aria-modal="true" aria-labelledby="command-title">
        <p className="eyebrow">Physical device command</p>
        <h2 id="command-title">{command.label}</h2>
        <dl className="command-review">
          <div><dt>Target</dt><dd>Storage battery</dd></div>
          <div><dt>Requested change</dt><dd>{requestSummary({ request: command.payload } as CommandReceipt)}</dd></div>
        </dl>
        <p className="impact-note">{command.impact}</p>
        {phase === "confirming" ? (
          <div className="button-row dialog-actions">
            <button className="button secondary" type="button" onClick={close}>Cancel</button>
            <button className="button primary" type="button" onClick={() => void run()}>Send command</button>
          </div>
        ) : (
          <>
            <ol className="command-progress" aria-live="polite">
              {[
                ["sending", "Request sent"],
                ["acknowledged", "Device acknowledged"],
                ["verified", "Fresh readback verified"],
                ["recorded", "Activity recorded"],
              ].map(([step, label]) => {
                const eventTypes = new Set(liveReceipt?.events.map((event) => event.type) ?? []);
                const complete = step === "sending" ? eventTypes.has("sending")
                  : step === "acknowledged" ? eventTypes.has("acknowledged")
                    : step === "verified" ? phase === "succeeded"
                      : terminalPhases.has(phase);
                return <li key={step} data-state={complete ? "complete" : terminalPhases.has(phase) ? "muted" : "pending"}>{label}</li>;
              })}
            </ol>
            {phase === "succeeded" ? <p className="command-result success" role="status">Command completed and device state was verified.</p> : null}
            {phase === "failed" || phase === "timed-out" ? <p className="command-result failure" role="alert">{state.phase === phase ? state.error : "Command failed"}</p> : null}
            {phase === "mismatched" ? <p className="command-result failure" role="alert">The device acknowledged the request, but readback did not match. {state.phase === "mismatched" ? state.actual : null}</p> : null}
            {!pending ? <button className="button" type="button" onClick={close}>Close receipt</button> : null}
          </>
        )}
      </section>
    </div>
  );
}

function hourOptions() {
  return Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>);
}

function scheduleNextAt(schedule: BatterySchedule, now = new Date()) {
  if (!schedule.enabled) return null;
  if (schedule.repeat === "once") {
    const value = new Date(schedule.runAt ?? "");
    return Number.isFinite(value.getTime()) && value > now ? value : null;
  }
  if (!/^\d{2}:\d{2}$/.test(schedule.time ?? "")) return null;
  const [hour, minute] = (schedule.time ?? "").split(":").map(Number);
  const days = schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (days.includes(candidate.getDay()) && candidate > now) return candidate;
  }
  return null;
}

function schedulePreviousAt(schedule: BatterySchedule, now = new Date()) {
  if (!schedule.enabled) return null;
  if (schedule.repeat === "once") {
    const value = new Date(schedule.runAt ?? "");
    return Number.isFinite(value.getTime()) && value <= now && value.getTime() >= now.getTime() - 86_400_000 ? value : null;
  }
  if (!/^\d{2}:\d{2}$/.test(schedule.time ?? "")) return null;
  const [hour, minute] = (schedule.time ?? "").split(":").map(Number);
  const days = schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  for (let offset = 0; offset >= -7; offset -= 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (days.includes(candidate.getDay()) && candidate <= now && candidate.getTime() >= now.getTime() - 86_400_000) return candidate;
  }
  return null;
}

function scheduleRecurrence(schedule: BatterySchedule) {
  if (schedule.repeat === "once") return `Once · ${new Date(schedule.runAt ?? "").toLocaleString()}`;
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  return `${days.length === 7 ? "Every day" : days.map((day) => labels[day]).join(", ")} · ${schedule.time}`;
}

function scheduleOccurrencesForDay(schedule: BatterySchedule, day: Date) {
  if (!schedule.enabled) return [];
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  if (schedule.repeat === "once") {
    const occurrence = new Date(schedule.runAt ?? "");
    return Number.isFinite(occurrence.getTime()) && occurrence >= dayStart && occurrence < dayEnd ? [occurrence] : [];
  }
  if (!/^\d{2}:\d{2}$/.test(schedule.time ?? "")) return [];
  const days = schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(dayStart.getDay())) return [];
  const [hour, minute] = (schedule.time ?? "").split(":").map(Number);
  const occurrence = new Date(dayStart);
  occurrence.setHours(hour, minute, 0, 0);
  return [occurrence];
}

function ScheduleCalendar({ schedules, conflicts }: { schedules: BatterySchedule[]; conflicts: Set<string> }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(today);
    date.setDate(date.getDate() + offset);
    return date;
  });
  const occurrenceCount = days.reduce((total, day) => total + schedules.reduce(
    (dayTotal, schedule) => dayTotal + scheduleOccurrencesForDay(schedule, day).length,
    0,
  ), 0);

  return (
    <section className="schedule-calendar" aria-labelledby="schedule-calendar-heading">
      <div className="section-heading">
        <div><p className="eyebrow">Calendar</p><h3 id="schedule-calendar-heading">Seven-day plan</h3></div>
        <span className="sample-count">{occurrenceCount} planned {occurrenceCount === 1 ? "change" : "changes"}</span>
      </div>
      <div className="schedule-calendar-scroll">
        <div className="schedule-calendar-grid">
          {days.map((day) => {
            const occurrences = schedules.flatMap((schedule) => scheduleOccurrencesForDay(schedule, day).map((at) => ({ schedule, at })))
              .sort((left, right) => left.at.getTime() - right.at.getTime());
            return (
              <article className="schedule-calendar-day" key={day.toISOString()}>
                <header><strong>{day.toLocaleDateString([], { weekday: "short" })}</strong><span>{day.toLocaleDateString([], { month: "short", day: "numeric" })}</span></header>
                <ol>
                  {occurrences.map(({ schedule, at }) => <li key={`${schedule.id}:${at.toISOString()}`} data-conflict={conflicts.has(schedule.id) || undefined}><time dateTime={at.toISOString()}>{at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><strong>{schedule.name}</strong><span>{actionLabels[schedule.action] ?? sentence(schedule.action)}</span></li>)}
                  {!occurrences.length ? <li className="schedule-calendar-empty">No changes</li> : null}
                </ol>
              </article>
            );
          })}
        </div>
      </div>
      <p className="calendar-note">Enabled schedules appear here. Conflicting times are highlighted and explained in the schedule list below.</p>
    </section>
  );
}

function recurringWindow(startHour: number, endHour: number, label: string, tone: "charge" | "discharge", now = new Date()): TimelineOverlay[] {
  const overlays: TimelineOverlay[] = [];
  for (let offset = -1; offset <= 0; offset += 1) {
    const start = new Date(now);
    start.setDate(now.getDate() + offset);
    start.setHours(startHour, 0, 0, 0);
    const end = new Date(start);
    end.setHours(endHour, 0, 0, 0);
    if (endHour <= startHour) end.setDate(end.getDate() + 1);
    overlays.push({ start: start.toISOString(), end: end.toISOString(), label, tone });
  }
  return overlays;
}

export function BatteryPage({ view = "status" }: { view?: "status" | "schedules" | "backup" }) {
  const { config, status, loadingState, refresh } = useEnergyStatus();
  const { history: batteryHistory, loading: batteryHistoryLoading, refresh: refreshBatteryHistory } = useHistoryRange(24 * 60 * 60_000);
  const { state, dispatch } = useCommandLifecycle();
  const [receipts, setReceipts] = useState<CommandReceipt[]>([]);
  const [schedules, setSchedules] = useState<BatterySchedule[]>([]);
  const [backup, setBackup] = useState<BackupPreparation | null>(null);
  const [backupAllowDemandGuard, setBackupAllowDemandGuard] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewCommand | null>(null);
  const [profile, setProfile] = useState("eco");
  const [reserve, setReserve] = useState(20);
  const [chargeTarget, setChargeTarget] = useState(500);
  const [chargeStart, setChargeStart] = useState(1);
  const [chargeEnd, setChargeEnd] = useState(5);
  const [dischargeStart, setDischargeStart] = useState(7);
  const [dischargeEnd, setDischargeEnd] = useState(23);
  const everydayBaseline = useRef<EverydaySettings | null>(null);
  const everydayDirtyRef = useRef(false);
  const [everydayDirty, setEverydayDirty] = useState(false);
  const [everydaySaving, setEverydaySaving] = useState(false);
  const [everydayResult, setEverydayResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [scheduleName, setScheduleName] = useState("Battery schedule");
  const [scheduleAction, setScheduleAction] = useState<BatteryAction>("set-mode");
  const [scheduleValue, setScheduleValue] = useState("auto");
  const [scheduleRepeat, setScheduleRepeat] = useState<"daily" | "once">("daily");
  const [scheduleDays, setScheduleDays] = useState([0, 1, 2, 3, 4, 5, 6]);
  const [scheduleTime, setScheduleTime] = useState("02:00");
  const [scheduleRunAt, setScheduleRunAt] = useState("");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleReview, setScheduleReview] = useState(false);

  const loadOperations = useCallback(async () => {
    try {
      const [receiptData, scheduleData, backupData] = await Promise.all([
        getCommandReceipts(), getSchedules(), getBackupPreparation(),
      ]);
      setReceipts(receiptData.receipts);
      setSchedules(scheduleData);
      setBackup(backupData);
      setLoadError(null);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Battery operations could not be loaded");
    }
  }, []);

  // API state initializes and refreshes the editable controls on this operational page.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadOperations(); }, [loadOperations]);
  useEffect(() => {
    if (everydayDirtyRef.current) return;
    const previous = everydayBaseline.current ?? { profile: "eco", reserve: 20, chargeStart: 1, chargeEnd: 5, dischargeStart: 7, dischargeEnd: 23 };
    const settings = status?.settings;
    const currentProfile = settings?.mode?.decoded?.mode ?? settings?.mode?.mode ?? status?.energy?.battery?.vendor_profile?.value;
    const nextProfile = currentProfile ? String(currentProfile) : previous.profile;
    const currentReserve = settings?.discharge_limit?.decoded?.percent;
    const nextReserve = typeof currentReserve === "number" ? currentReserve : previous.reserve;
    const currentCharge = settings?.osaifu_charge_window?.decoded;
    const nextChargeStart = typeof currentCharge?.start_hour === "number" ? currentCharge.start_hour : previous.chargeStart;
    const nextChargeEnd = typeof currentCharge?.end_hour === "number" ? currentCharge.end_hour : previous.chargeEnd;
    const currentDischarge = settings?.osaifu_discharge_window?.decoded;
    const nextDischargeStart = typeof currentDischarge?.start_hour === "number" ? currentDischarge.start_hour : previous.dischargeStart;
    const nextDischargeEnd = typeof currentDischarge?.end_hour === "number" ? currentDischarge.end_hour : previous.dischargeEnd;
    setProfile(nextProfile);
    setReserve(nextReserve);
    setChargeStart(nextChargeStart);
    setChargeEnd(nextChargeEnd);
    setDischargeStart(nextDischargeStart);
    setDischargeEnd(nextDischargeEnd);
    everydayBaseline.current = { profile: nextProfile, reserve: nextReserve, chargeStart: nextChargeStart, chargeEnd: nextChargeEnd, dischargeStart: nextDischargeStart, dischargeEnd: nextDischargeEnd };
  }, [status]);

  const battery = status?.energy?.battery;
  const schedulesDisabled = config?.adaptiveCharging?.enabled === true;
  const chartSamples = useMemo(() => withLatestStatus(batteryHistory.samples, status), [batteryHistory.samples, status]);
  const host = status?.hosts?.battery ?? config?.batteryHost ?? "Configured storage battery";
  const timelineOverlays = useMemo<TimelineOverlay[]>(() => [
    ...recurringWindow(chargeStart, chargeEnd, `Osaifu charge ${chargeStart}:00–${chargeEnd}:00`, "charge"),
    ...recurringWindow(dischargeStart, dischargeEnd, `Osaifu discharge ${dischargeStart}:00–${dischargeEnd}:00`, "discharge"),
    ...(schedulesDisabled ? [] : schedules).flatMap((schedule) => {
      const previous = schedulePreviousAt(schedule);
      return previous ? [{ start: previous.toISOString(), label: schedule.name, tone: "schedule" as const }] : [];
    }),
  ], [chargeStart, chargeEnd, dischargeStart, dischargeEnd, schedules, schedulesDisabled]);
  const conflictingScheduleIds = useMemo(() => {
    const conflicts = new Set<string>();
    if (schedulesDisabled) return conflicts;
    for (let left = 0; left < schedules.length; left += 1) for (let right = left + 1; right < schedules.length; right += 1) {
      const a = schedules[left];
      const b = schedules[right];
      const sameDailyTime = a.enabled && b.enabled && a.repeat === "daily" && b.repeat === "daily" && a.time === b.time
        && (a.days?.length ? a.days : [0, 1, 2, 3, 4, 5, 6]).some((day) => (b.days?.length ? b.days : [0, 1, 2, 3, 4, 5, 6]).includes(day));
      const sameOnceTime = a.enabled && b.enabled && a.repeat === "once" && b.repeat === "once" && a.runAt === b.runAt;
      if (sameDailyTime || sameOnceTime) { conflicts.add(a.id); conflicts.add(b.id); }
    }
    return conflicts;
  }, [schedules, schedulesDisabled]);
  const openReview = (command: Omit<ReviewCommand, "id" | "target">) => {
    const next = { ...command, id: `${command.action}:${Date.now()}`, target: "battery" as const };
    dispatch({ type: "review", command: next });
    setReview(next);
  };
  const closeReview = () => {
    if (["sending", "acknowledged", "verifying"].includes(state.phase)) return;
    dispatch({ type: "reset" });
    setReview(null);
  };
  const completed = async () => {
    refresh();
    refreshBatteryHistory();
    await loadOperations();
  };
  const changeEverydaySetting = (change: () => void) => {
    everydayDirtyRef.current = true;
    change();
    setEverydayDirty(true);
    setEverydayResult(null);
  };
  const saveEverydayControls = async () => {
    const baseline = everydayBaseline.current;
    if (!baseline || !everydayDirty) return;
    const current: EverydaySettings = { profile, reserve, chargeStart, chargeEnd, dischargeStart, dischargeEnd };
    const changes: Array<{ action: BatteryAction; payload: Record<string, unknown> }> = [];
    if (current.profile !== baseline.profile) changes.push({ action: "vendor-profile", payload: { mode: current.profile } });
    if (current.reserve !== baseline.reserve) changes.push({ action: "discharge-limit", payload: { percent: current.reserve } });
    if (current.chargeStart !== baseline.chargeStart || current.chargeEnd !== baseline.chargeEnd) changes.push({ action: "osaifu-charge-window", payload: { startHour: current.chargeStart, endHour: current.chargeEnd } });
    if (current.dischargeStart !== baseline.dischargeStart || current.dischargeEnd !== baseline.dischargeEnd) changes.push({ action: "osaifu-discharge-window", payload: { startHour: current.dischargeStart, endHour: current.dischargeEnd } });
    setEverydaySaving(true);
    setEverydayResult(null);
    try {
      for (const change of changes) await runBatteryAction(change.action, change.payload);
      everydayBaseline.current = current;
      everydayDirtyRef.current = false;
      setEverydayDirty(false);
      setEverydayResult({ ok: true, message: `${changes.length} ${changes.length === 1 ? "change" : "changes"} saved and verified on the battery.` });
      await completed();
    } catch (reason) {
      setEverydayResult({ ok: false, message: reason instanceof Error ? reason.message : "The changes could not be verified." });
      await loadOperations();
    } finally {
      setEverydaySaving(false);
    }
  };
  const schedulePayload = useMemo<Record<string, unknown>>(() => {
    if (scheduleAction === "set-mode" || scheduleAction === "vendor-profile") return { mode: scheduleValue };
    if (scheduleAction === "discharge-limit") return { percent: Number(scheduleValue) || 20 };
    if (scheduleAction === "charge" || scheduleAction === "discharge") return { targetWh: Number(scheduleValue) || 500 };
    if (scheduleAction === "osaifu-discharge-window") return { startHour: dischargeStart, endHour: dischargeEnd };
    return { startHour: chargeStart, endHour: chargeEnd };
  }, [scheduleAction, scheduleValue, chargeStart, chargeEnd, dischargeStart, dischargeEnd]);
  const submitSchedule = async (event: FormEvent) => {
    event.preventDefault();
    if (schedulesDisabled) return;
    if (!scheduleReview) {
      setScheduleReview(true);
      return;
    }
    setScheduleBusy(true);
    try {
      await createSchedule({
        name: scheduleName,
        action: scheduleAction,
        payload: schedulePayload,
        repeat: scheduleRepeat,
        ...(scheduleRepeat === "daily" ? { days: scheduleDays, time: scheduleTime } : { runAt: scheduleRunAt }),
        enabled: true,
      });
      setScheduleReview(false);
      await loadOperations();
    } finally {
      setScheduleBusy(false);
    }
  };

  return (
    <main className="page battery-page">
      <header className="page-heading">
        <div><p className="eyebrow">Operate</p><h1>{view === "status" ? "Battery" : view === "schedules" ? "Battery schedules" : "Disaster Prep / 停電対策"}</h1><p>{view === "status" ? "Status, deliberate controls, and verified outcomes." : view === "schedules" ? "Plan recurring or one-time changes and review execution results." : "Temporarily prioritize stored energy so the battery is ready for an outage."}</p></div>
        <span className="live-state"><i />{status ? `Device ${host}` : sentence(loadingState)}</span>
      </header>
      <nav className="battery-navigation" aria-label="Battery sections"><NavLink to="/battery" end>Status & control</NavLink><NavLink to="/battery/schedules">Schedules</NavLink><NavLink to="/battery/backup">Disaster Prep / 停電対策</NavLink></nav>
      {backup?.active ? <div className="backup-banner" role="status">Disaster Prep / 停電対策 is active · Profile {sentence(backup.currentProfile)}</div> : null}
      {loadError ? <div className="status-banner" role="alert">{loadError}</div> : null}

      {view === "status" ? <>
      <section className="battery-hero panel">
        <div><p className="eyebrow">Current state</p><strong className="battery-soc">{formatSoc(battery?.remaining_percent?.value ?? null)}</strong><p>{sentence(battery?.working_status?.value)} · {formatPower(battery?.instant_power?.value ?? null)}</p></div>
        <dl className="battery-state-grid">
          <div><dt>Verified operation mode</dt><dd>{sentence(battery?.operation_mode?.value)}</dd></div>
          <div><dt>Charging profile</dt><dd>{sentence(profile)}</dd></div>
          <div><dt>Reserve</dt><dd>{reserve}%</dd></div>
          <div><dt>Latest contact</dt><dd>{status?.read_at ? new Date(status.read_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Unavailable"}</dd></div>
        </dl>
      </section>

      <section className="panel strategy-panel">
        <div><p className="eyebrow">Current strategy</p><h2>{status?.batteryStrategy?.title ?? "Determining ownership"}</h2><p>{status?.batteryStrategy?.description ?? "Waiting for current automation and override state."}</p></div>
        {status?.batteryStrategy?.manualOverride?.active ? <strong>{status.batteryStrategy.manualOverride.until ? `Until ${new Date(status.batteryStrategy.manualOverride.until).toLocaleString()}` : "Until changed"}</strong> : <span>No manual override</span>}
      </section>

      <section className="panel battery-timeline-panel">
        <div className="history-toolbar"><div><p className="eyebrow">Last 24 hours</p><h2>Battery power, state of charge, and planned windows</h2></div><button className="quiet-button" type="button" onClick={refreshBatteryHistory}>Refresh</button></div>
        {batteryHistoryLoading && !chartSamples.length ? <div className="chart-empty">Loading battery history…</div> : <CombinedEnergyChart samples={chartSamples} selected={["batteryPowerW", "stateOfChargePercent"]} reservePercent={reserve} overlays={timelineOverlays} label="Last 24 hours of battery power and state of charge with reserve and command windows" />}
      </section>

      <div className="battery-workspace">
        <section className="panel control-panel">
          <div className="section-heading"><div><p className="eyebrow">Everyday controls</p><h2>Profile and reserve</h2></div></div>
          <label className="field"><span>Charging profile</span><select value={profile} onChange={(event) => changeEverydaySetting(() => setProfile(event.target.value))}><option value="eco">Eco</option><option value="osaifu">Osaifu</option><option value="backup">Backup</option></select></label>
          <label className="field"><span>Minimum reserve</span><select value={reserve} onChange={(event) => changeEverydaySetting(() => setReserve(Number(event.target.value)))}>{Array.from({ length: 11 }, (_, step) => <option key={step} value={step * 10}>{step * 10}%</option>)}</select></label>
          <details className="advanced-controls"><summary>Osaifu time windows</summary>
            <div className="window-row"><span>Charge</span><select aria-label="Charge start" value={chargeStart} onChange={(event) => changeEverydaySetting(() => setChargeStart(Number(event.target.value)))}>{hourOptions()}</select><span>to</span><select aria-label="Charge end" value={chargeEnd} onChange={(event) => changeEverydaySetting(() => setChargeEnd(Number(event.target.value)))}>{hourOptions()}</select></div>
            <div className="window-row"><span>Discharge</span><select aria-label="Discharge start" value={dischargeStart} onChange={(event) => changeEverydaySetting(() => setDischargeStart(Number(event.target.value)))}>{hourOptions()}</select><span>to</span><select aria-label="Discharge end" value={dischargeEnd} onChange={(event) => changeEverydaySetting(() => setDischargeEnd(Number(event.target.value)))}>{hourOptions()}</select></div>
          </details>
          <button className="button primary" type="button" disabled={!everydayDirty || everydaySaving} onClick={() => void saveEverydayControls()}>{everydaySaving ? "Saving…" : "Save changes"}</button>
          {everydayResult ? <p className={`inline-save-result ${everydayResult.ok ? "success" : "failure"}`} role={everydayResult.ok ? "status" : "alert"}>{everydayResult.message}</p> : null}
        </section>

        <section className="panel control-panel manual-panel">
          <div className="section-heading"><div><p className="eyebrow">Manual control</p><h2>Direct operation</h2><small>Charge, discharge, Standby, or return to Auto</small></div></div>
          <div className="manual-content"><p className="section-copy">These commands can temporarily supersede the current charging strategy. Each result is acknowledged and read back before success is shown.</p>
          <label className="field"><span>Optional energy target</span><div className="input-suffix"><input type="number" min="0" step="100" value={chargeTarget} onChange={(event) => setChargeTarget(Number(event.target.value))} /><span>Wh</span></div></label>
          <div className="command-grid">
            <button className="button primary" type="button" onClick={() => openReview({ action: "charge", label: "Start manual charging", payload: { targetWh: chargeTarget }, impact: "Manual charging may pause Adaptive Charging and increase grid demand." })}>Charge</button>
            <button className="button" type="button" onClick={() => openReview({ action: "discharge", label: "Start manual discharging", payload: { targetWh: chargeTarget }, impact: "Manual discharging may pause Adaptive Charging and reduce stored backup energy." })}>Discharge</button>
            <button className="button" type="button" onClick={() => openReview({ action: "set-mode", label: "Put battery in Standby", payload: { mode: "standby" }, impact: "Standby stops normal charging and discharging until another strategy changes the mode." })}>Standby</button>
            <button className="button secondary" type="button" onClick={() => openReview({ action: "set-mode", label: "Return battery to Auto", payload: { mode: "auto" }, impact: "Auto returns operation-mode control to the battery after any active override permits it." })}>Return to Auto</button>
          </div>
          </div>
        </section>
      </div>
      </> : null}

      {view === "backup" ?
      <section className="panel backup-panel">
        <div><p className="eyebrow">Operational mode</p><h2>Disaster Prep / 停電対策</h2><p>Temporarily switches the battery to its backup profile so more stored energy is ready for an outage. Adaptive Charging pauses while this mode is active. When stopped, the previous profile is restored and normal automation recalculates before resuming.</p></div>
        <div className="backup-state"><strong>{backup?.active ? "Active" : "Inactive"}</strong><span>{backup?.active ? `Since ${backup.startedAt ? new Date(backup.startedAt).toLocaleString() : "recently"}` : "Normal automation can operate"}</span></div>
        {!backup?.active ? <label className="guard-choice"><input type="checkbox" checked={backupAllowDemandGuard} onChange={(event) => setBackupAllowDemandGuard(event.target.checked)} /><span>Allow Demand Guard to retain breaker protection</span></label> : null}
        <button className={`button${backup?.active ? " secondary" : " primary"}`} type="button" onClick={() => openReview({ action: backup?.active ? "backup-end" : "backup-start", label: backup?.active ? "Stop Disaster Prep" : "Start Disaster Prep", payload: { allowDemandGuard: backupAllowDemandGuard, reserve }, impact: backup?.active ? "Stopping restores the battery profile that was active before Disaster Prep began. Adaptive Charging will then recalculate before normal operation resumes." : `Disaster Prep switches the battery to its backup profile and pauses Adaptive Charging so stored energy is prioritized for an outage. Your ${reserve}% reserve remains unchanged, and Demand Guard will ${backupAllowDemandGuard ? "remain available for breaker protection" : "pause"}. All of these temporary changes are reversed when Disaster Prep is stopped.` })}>{backup?.active ? "Stop" : "Start"}</button>
      </section> : null}

      {view === "schedules" ?
      <section className="panel schedules-panel">
        <div className="section-heading"><div><p className="eyebrow">Planned changes</p><h2>Schedules</h2></div><span className="sample-count">{schedules.length} configured</span></div>
        {schedulesDisabled ? <div className="automation-disabled-note" role="status"><strong>Schedules are disabled while Adaptive Charging is on.</strong><span>Your saved schedules are retained for reference, but they will not run. Turn off Adaptive Charging before creating, enabling, or changing a schedule.</span></div> : null}
        <ScheduleCalendar schedules={schedulesDisabled ? [] : schedules} conflicts={conflictingScheduleIds} />
        <form className="schedule-form" onSubmit={(event) => void submitSchedule(event)}>
          <fieldset className="schedule-form-fields" disabled={schedulesDisabled}>
          <label className="field"><span>Schedule name</span><input value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} required /></label>
          <label className="field"><span>1 · When</span><span className="paired-fields"><select aria-label="Schedule repeat" value={scheduleRepeat} onChange={(event) => setScheduleRepeat(event.target.value as "daily" | "once")}><option value="daily">Daily</option><option value="once">Once</option></select>{scheduleRepeat === "daily" ? <input aria-label="Schedule time" type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} required /> : <input aria-label="Schedule date and time" type="datetime-local" value={scheduleRunAt} onChange={(event) => setScheduleRunAt(event.target.value)} required />}</span></label>
          <label className="field"><span>2 · Action</span><select value={scheduleAction} onChange={(event) => { const action = event.target.value as BatteryAction; setScheduleAction(action); setScheduleValue(action === "vendor-profile" ? "eco" : action === "discharge-limit" ? "20" : action === "charge" || action === "discharge" ? "500" : "auto"); }}><option value="set-mode">Operation mode</option><option value="vendor-profile">Charging profile</option><option value="discharge-limit">Reserve limit</option><option value="osaifu-charge-window">Charge window</option><option value="osaifu-discharge-window">Discharge window</option><option value="charge">Charge</option><option value="discharge">Discharge</option></select></label>
          <label className="field"><span>3 · Value</span>{scheduleAction === "set-mode" ? <select value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} aria-label="Schedule value"><option value="auto">Auto</option><option value="standby">Standby</option><option value="charging">Charging</option><option value="discharging">Discharging</option></select> : scheduleAction === "vendor-profile" ? <select value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} aria-label="Schedule value"><option value="eco">Eco</option><option value="osaifu">Osaifu</option><option value="backup">Backup</option></select> : scheduleAction.includes("window") ? <span className="compact-window">{scheduleAction === "osaifu-charge-window" ? `${chargeStart}:00–${chargeEnd}:00` : `${dischargeStart}:00–${dischargeEnd}:00`}</span> : <input type="number" min="0" step={scheduleAction === "discharge-limit" ? 10 : 100} value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} aria-label="Schedule value" />}</label>
          <button className={`button${scheduleReview ? " primary" : ""}`} disabled={scheduleBusy} type="submit">{scheduleBusy ? "Saving…" : scheduleReview ? "Confirm schedule" : "4 · Review schedule"}</button>
          {scheduleRepeat === "daily" ? <fieldset className="schedule-days"><legend>Run on</legend>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => <label key={label}><input type="checkbox" checked={scheduleDays.includes(day)} onChange={(event) => setScheduleDays((days) => event.target.checked ? [...days, day].sort() : days.filter((item) => item !== day))} /><span>{label}</span></label>)}</fieldset> : null}
          </fieldset>
        </form>
        {scheduleReview ? <div className="schedule-review-note" role="status"><span><strong>Review:</strong> {scheduleName} will run {actionLabels[scheduleAction] ?? sentence(scheduleAction)} with {Object.values(schedulePayload).join(" → ")} {scheduleRepeat === "daily" ? `at ${scheduleTime} on ${scheduleDays.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")}` : `once at ${new Date(scheduleRunAt).toLocaleString()}`}.</span><button className="quiet-button" type="button" onClick={() => setScheduleReview(false)}>Edit</button></div> : null}
        <div className="schedule-list">
          {schedules.map((schedule) => { const next = schedulesDisabled ? null : scheduleNextAt(schedule); return <article key={schedule.id}><div><strong>{schedule.name}</strong><span>{actionLabels[schedule.action] ?? sentence(schedule.action)} · {scheduleRecurrence(schedule)}</span><small>{schedulesDisabled ? "Paused by Adaptive Charging" : `Next run: ${next ? next.toLocaleString() : schedule.enabled ? "No future occurrence" : "Disabled"}`}</small>{schedule.lastResult ? <small data-ok={schedule.lastResult.ok}>{schedule.lastResult.ok ? `Last run succeeded${schedule.lastResult.at ? ` · ${new Date(schedule.lastResult.at).toLocaleString()}` : ""}` : `Last run failed: ${schedule.lastResult.error}`}</small> : null}{conflictingScheduleIds.has(schedule.id) ? <p className="schedule-conflict">Conflicts with another enabled schedule at this time.</p> : null}</div><div className="button-row"><button className="quiet-button" disabled={schedulesDisabled} title={schedulesDisabled ? "Adaptive Charging must be turned off before changing schedule status" : undefined} type="button" onClick={() => void updateSchedule(schedule.id, { enabled: !schedule.enabled }).then(loadOperations)}>{schedule.enabled ? "Disable" : "Enable"}</button><button className="quiet-button danger" type="button" onClick={() => void deleteSchedule(schedule.id).then(loadOperations)}>Delete</button></div></article>; })}
          {!schedules.length ? <p className="empty-copy">No battery schedules are configured.</p> : null}
        </div>
      </section> : null}

      <section className="panel receipts-panel">
        <div className="section-heading"><div><p className="eyebrow">Audit trail</p><h2>Recent command receipts</h2></div><button className="quiet-button" type="button" onClick={() => void loadOperations()}>Refresh</button></div>
        <div className="receipt-list">
          {receipts.map((receipt) => <article key={receipt.commandId}><i data-state={receipt.state} /><div><strong>{actionLabels[receipt.action] ?? sentence(receipt.action)}</strong><span>{requestSummary(receipt)} · {sourceLabels[receipt.source] ?? sentence(receipt.source)}</span><small>{receipt.completedAt || receipt.requestedAt ? new Date(receipt.completedAt ?? receipt.requestedAt ?? "").toLocaleString() : "Time unavailable"}{receipt.durationMs !== null && receipt.durationMs !== undefined ? ` · ${receipt.durationMs} ms` : ""}</small>{receipt.error ? <p className="receipt-error">{receipt.error}</p> : null}</div><b data-state={receipt.state}>{sentence(receipt.state)}</b></article>)}
          {!receipts.length ? <p className="empty-copy">No device commands have been recorded since command receipts were enabled.</p> : null}
        </div>
      </section>
      {review ? <CommandDialog command={review} close={closeReview} completed={completed} /> : null}
    </main>
  );
}
