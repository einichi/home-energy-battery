const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const ACTIVE_REFRESH_MS = 15_000;
const INACTIVE_REFRESH_MS = 5 * 60_000;
const POWER_TREND_MS = 30 * 60_000;
const SOC_TREND_MS = 3 * 60 * 60_000;

// Frontend state is intentionally kept in one small object. The app has no build
// step, so avoiding framework state makes it easier to inspect in a browser.
const state = {
  status: null,
  schedules: [],
  refreshTimer: null,
  controlsInitialized: false,
  config: null,
  language: "en",
  settingsLoadedForView: false,
  lastDiscovery: null,
  discoveryPollTimer: null,
  trendHistory: {},
  trendHover: {},
  historyMode: false,
  historyHorizonMs: null,
  automationRules: [],
};

const TREND_CONFIG = {
  // Each graph declares its own horizon and scaling preferences. Power readings
  // are short-lived, while state of charge changes slowly and gets a longer view.
  batteryPower: {
    canvas: "#batteryPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#127c78",
    fill: "rgba(18, 124, 120, 0.14)",
    includeZero: true,
    signed: true,
  },
  batterySoc: {
    canvas: "#batterySocTrend",
    horizonMs: SOC_TREND_MS,
    color: "#127c78",
    fill: "rgba(18, 124, 120, 0.12)",
    min: 0,
    max: 100,
  },
  solarPower: {
    canvas: "#solarPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#d8872c",
    fill: "rgba(216, 135, 44, 0.14)",
    includeZero: true,
  },
  houseDemandPower: {
    canvas: "#houseDemandPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#127c78",
    fill: "rgba(18, 124, 120, 0.13)",
    includeZero: true,
  },
  fuelCellPower: {
    canvas: "#fuelCellPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#7c3aed",
    fill: "rgba(124, 58, 237, 0.13)",
    includeZero: true,
    max: 800,
  },
  gridExportPower: {
    canvas: "#gridExportPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#16a34a",
    fill: "rgba(22, 163, 74, 0.13)",
    includeZero: true,
  },
  gridImportPower: {
    canvas: "#gridImportPowerTrend",
    horizonMs: POWER_TREND_MS,
    color: "#dc2626",
    fill: "rgba(220, 38, 38, 0.13)",
    includeZero: true,
  },
};

const I18N = {
  // All visible copy lives here so the language switch can re-render the UI
  // without loading another bundle.
  en: {
    brand: "HOME ENERGY <strong>& BATTERY</strong>",
    navDashboard: "Dashboard",
    navSettings: "Settings",
    liveDashboard: "Live dashboard",
    homeEnergyFlow: "Home energy flow",
    debug: "Debug",
    refresh: "Refresh",
    from: "From",
    to: "To",
    showRange: "Show Range",
    live: "Live",
    trendWidgets: "Power Trends",
    statusWidgets: "Status & Savings",
    batteryPower: "Battery Power",
    stateOfCharge: "State of Charge",
    batteryWorkingStatus: "Battery Working Status",
    operationMode: "Operation Mode",
    chargingProfile: "Charging Profile",
    dischargeLimit: "Discharge Limit",
    solarGeneration: "Solar Generation",
    solarSavings: "Solar Savings",
    offPeakSavings: "Off-Peak Charge Savings",
    houseDemand: "House Demand",
    gridImport: "Grid Import",
    gridExport: "Grid Export",
    fuelCellGeneration: "Ene-Farm Generation",
    fuelCellStatus: "Ene-Farm Status",
    batterySettings: "Battery Settings",
    chargingProfileHelp:
      "Choose the battery behavior profile used by the controller.",
    dischargeLimitHelp: "Minimum charge to keep available for later use.",
    chargeWindow: "osaifu Charge Window",
    chargeWindowHelp:
      "Hours when the battery is allowed to charge in osaifu mode.",
    dischargeWindow: "osaifu Discharge Window",
    dischargeWindowHelp:
      "Hours when the battery is allowed to discharge in osaifu mode.",
    directAction: "Direct Action",
    directActionHelp:
      "Send an immediate battery command. Energy target is optional for charge and discharge.",
    set: "Set",
    run: "Run",
    targetWh: "target Wh",
    deviceAddresses: "Device Addresses",
    preferences: "Preferences",
    preferencesRates: "Preferences & Rates",
    dataDiscovery: "Data & Discovery",
    dataRetention: "Data Retention",
    language: "Language",
    updateInterval: "Update interval (seconds)",
    savePreferences: "Save Preferences",
    preferencesSaved: "Preferences saved",
    electricityRates: "Electricity Rates",
    rateMode: "Rate Mode",
    rateModeSimple: "Simple",
    rateModeOffPeak: "Off-Peak",
    rateModeMulti: "Multi-Rate",
    simpleRate: "Rate (yen/kWh)",
    standardRate: "Standard rate (yen/kWh)",
    offPeakRate: "Off-peak rate (yen/kWh)",
    offPeakSavingsEnabled: "Calculate off-peak battery charging savings",
    addRateBand: "Add rate band",
    removeRateBand: "Remove",
    rateBandLabel: "Label",
    rateBandStart: "Start",
    rateBandEnd: "End",
    rateBandPrice: "Yen/kWh",
    saveRates: "Save Rates",
    historyRetention: "History Retention",
    retentionDays: "Keep samples for days",
    saveRetention: "Save Retention",
    trimHistoryNow: "Trim history now",
    historyTrimmed: "History trimmed",
    installedEquipment: "Installed Equipment",
    solarEnabled: "Show solar generation",
    fuelCellEnabled: "Show Ene-Farm generation and status",
    battery: "Battery",
    homePowerMeter: "Home power meter",
    solar: "Solar",
    fuelCell: "Ene-Farm",
    utilityMeter: "Utility meter",
    discoverySubnets: "Discovery subnets",
    optional: "optional",
    saveAddresses: "Save Addresses",
    autoDiscovery: "Auto-Discovery",
    scanNetwork: "Scan Network",
    broadcastDiscovery: "Broadcast Discovery",
    activeSubnetScan: "Active Subnet Scan",
    scanning: "Scanning...",
    scanningNearby: "Scanning nearby devices...",
    discoveryStarting: "Starting discovery",
    discoveryBroadcast: "Listening for device announcements",
    discoveryActiveScan: "Scanning subnet addresses",
    discoveryWaiting: "Waiting for device replies",
    discoveryComplete: "Discovery complete",
    discoveryFailed: "Discovery failed",
    discoveryProgressCount: "{scanned} of {total} addresses checked",
    discoveryFoundCount: "{count} devices found",
    discoveryElapsed: "{seconds}s elapsed",
    noDevicesFound: "No devices found.",
    likelyRole: "Likely role",
    services: "Services",
    address: "Address",
    useSuggestedAddresses: "Use Suggested Addresses",
    schedules: "Schedules",
    action: "Action",
    repeat: "Repeat",
    once: "Once",
    daily: "Daily",
    days: "Days",
    daySun: "Sun",
    dayMon: "Mon",
    dayTue: "Tue",
    dayWed: "Wed",
    dayThu: "Thu",
    dayFri: "Fri",
    daySat: "Sat",
    time: "Time",
    createSchedule: "Create Schedule",
    when: "When",
    details: "Details",
    status: "Status",
    everyDay: "Every day",
    noSchedules: "No schedules yet.",
    waiting: "Waiting",
    disabled: "Disabled",
    lastRan: "Last ran",
    savedAddresses: "Saved device addresses",
    suggestedLoaded: "Suggested addresses loaded. Save to apply them.",
    chooseProfile: "Choose a charging profile first.",
    chooseScheduleTime: "Choose a schedule time.",
    scheduleCreated: "Schedule created",
    serviceOnline: "Service online",
    historicalData: "Historical data",
    backgroundRefresh: "Background refresh",
    readFailed: "Read failed",
    readingDevices: "Reading devices",
    unavailable: "Unavailable",
    today: "Today",
    selectedRange: "Selected range",
    notSet: "Not set",
    now: "now",
    minAgo: "30m ago",
    hourAgo: "3h ago",
    timeAxis: "Time",
    wattsAxis: "Power (W)",
    percentAxis: "Charge (%)",
    profileOsaifu: "osaifu",
    profileEco: "eco",
    profileBackup: "backup",
    operationAuto: "auto",
    operationStandby: "standby",
    operationRapid: "rapid charge",
    operationCharge: "charging",
    operationDischarge: "discharging",
    startHour: "Start hour",
    endHour: "End hour",
    percent: "Percent",
    charging: "charging",
    discharging: "discharging",
    standby: "standby",
    auto: "auto",
    generating: "generating",
    stopped: "stopped",
    starting: "starting",
    stopping: "stopping",
    rapid_charging: "rapid charging",
    on: "on",
    off: "off",
    chargeAction: "Charge with optional target Wh",
    dischargeAction: "Discharge with optional target Wh",
    setAutoAction: "Set operation auto",
    setStandbyAction: "Set operation standby",
    setRapidAction: "Set operation rapid charge",
    setChargeAction: "Set operation charging",
    setDischargeAction: "Set operation discharging",
    setProfileAction: "Set charging profile",
    setLimitAction: "Set discharge limit",
    setChargeWindowAction: "Set charge window",
    setDischargeWindowAction: "Set discharge window",
    setOperationModeAction: "Set operation mode",
    automationRules: "Automation Rules",
    backupDemandGuard: "Charging Demand Guard",
    backupGuardEnabled: "Enable charging demand guard",
    breakerAmps: "Breaker amps",
    reserveAmps: "Reserve amps",
    batteryChargeEstimate: "Maximum battery charge watts",
    restoreBelowAmps: "Restore below amps",
    restoreDelay: "Restore delay seconds",
    saveAutomation: "Save Automation",
    automationSaved: "Automation saved",
    automationNoRules: "No automation rules saved.",
  },
  ja: {
    brand: "ホームエネルギー <strong>& バッテリー</strong>",
    navDashboard: "ダッシュボード",
    navSettings: "設定",
    liveDashboard: "ライブ表示",
    homeEnergyFlow: "家庭内の電力フロー",
    debug: "デバッグ",
    refresh: "更新",
    from: "開始",
    to: "終了",
    showRange: "範囲を表示",
    live: "ライブ",
    trendWidgets: "電力トレンド",
    statusWidgets: "状態と節約額",
    batteryPower: "蓄電池の電力",
    stateOfCharge: "蓄電池残量",
    batteryWorkingStatus: "蓄電池の動作状態",
    operationMode: "運転モード",
    chargingProfile: "充電プロファイル",
    dischargeLimit: "放電下限",
    solarGeneration: "太陽光発電",
    solarSavings: "太陽光の節約額",
    offPeakSavings: "夜間充電の節約額",
    houseDemand: "家庭内消費",
    gridImport: "買電",
    gridExport: "売電",
    fuelCellGeneration: "エネファーム発電",
    fuelCellStatus: "エネファーム状態",
    batterySettings: "蓄電池設定",
    chargingProfileHelp:
      "コントローラーが使う蓄電池の動作プロファイルを選びます。",
    dischargeLimitHelp: "あとで使うために残しておく最低残量です。",
    chargeWindow: "おサイフ充電時間帯",
    chargeWindowHelp: "おサイフモードで充電を許可する時間帯です。",
    dischargeWindow: "おサイフ放電時間帯",
    dischargeWindowHelp: "おサイフモードで放電を許可する時間帯です。",
    directAction: "即時操作",
    directActionHelp:
      "蓄電池にすぐ実行する指示を送ります。充電・放電では目標電力量を任意で指定できます。",
    set: "設定",
    run: "実行",
    targetWh: "目標Wh",
    deviceAddresses: "機器アドレス",
    preferences: "表示設定",
    preferencesRates: "表示・料金設定",
    dataDiscovery: "データと自動検出",
    dataRetention: "保存期間",
    language: "言語",
    updateInterval: "更新間隔（秒）",
    savePreferences: "表示設定を保存",
    preferencesSaved: "表示設定を保存しました",
    electricityRates: "電気料金",
    rateMode: "料金モード",
    rateModeSimple: "シンプル",
    rateModeOffPeak: "夜間料金",
    rateModeMulti: "複数料金",
    simpleRate: "料金 (円/kWh)",
    standardRate: "通常料金 (円/kWh)",
    offPeakRate: "夜間料金 (円/kWh)",
    offPeakSavingsEnabled: "夜間充電の節約額を計算する",
    addRateBand: "料金帯を追加",
    removeRateBand: "削除",
    rateBandLabel: "ラベル",
    rateBandStart: "開始",
    rateBandEnd: "終了",
    rateBandPrice: "円/kWh",
    saveRates: "料金を保存",
    historyRetention: "電力使用データの保存期間",
    retentionDays: "保存日数",
    saveRetention: "保存期間設定を保存",
    trimHistoryNow: "データを今すぐトリム",
    historyTrimmed: "履歴をトリムしました",
    installedEquipment: "設置済み設備",
    solarEnabled: "太陽光発電を表示",
    fuelCellEnabled: "エネファーム発電・状態を表示",
    battery: "蓄電池",
    homePowerMeter: "家庭内電力メーター",
    solar: "太陽光",
    fuelCell: "エネファーム",
    utilityMeter: "スマートメーター",
    discoverySubnets: "検出サブネット",
    optional: "任意",
    saveAddresses: "アドレスを保存",
    autoDiscovery: "自動検出",
    scanNetwork: "ネットワークをスキャン",
    broadcastDiscovery: "ブロードキャスト検出",
    activeSubnetScan: "サブネット能動スキャン",
    scanning: "スキャン中...",
    scanningNearby: "近くの機器をスキャン中...",
    discoveryStarting: "自動検出を開始中",
    discoveryBroadcast: "機器からの応答を待機中",
    discoveryActiveScan: "サブネット内のアドレスをスキャン中",
    discoveryWaiting: "機器からの返信を待機中",
    discoveryComplete: "自動検出が完了しました",
    discoveryFailed: "自動検出に失敗しました",
    discoveryProgressCount: "{scanned} / {total} アドレス確認済み",
    discoveryFoundCount: "{count} 台検出",
    discoveryElapsed: "{seconds}秒経過",
    noDevicesFound: "機器が見つかりませんでした。",
    likelyRole: "推定される役割",
    services: "サービス数",
    address: "アドレス",
    useSuggestedAddresses: "推奨アドレスを使う",
    schedules: "スケジュール",
    action: "操作",
    repeat: "繰り返し",
    once: "1回のみ",
    daily: "毎日",
    days: "曜日",
    daySun: "日",
    dayMon: "月",
    dayTue: "火",
    dayWed: "水",
    dayThu: "木",
    dayFri: "金",
    daySat: "土",
    time: "時刻",
    createSchedule: "スケジュール作成",
    when: "実行日時",
    details: "詳細",
    status: "状態",
    everyDay: "毎日",
    noSchedules: "スケジュールはまだありません。",
    waiting: "待機中",
    disabled: "無効",
    lastRan: "前回実行",
    savedAddresses: "機器アドレスを保存しました",
    suggestedLoaded: "推奨アドレスを読み込みました。保存すると反映されます。",
    chooseProfile: "充電プロファイルを選んでください。",
    chooseScheduleTime: "スケジュール時刻を選んでください。",
    scheduleCreated: "スケジュールを作成しました",
    serviceOnline: "サービス稼働中",
    historicalData: "履歴データ",
    backgroundRefresh: "バックグラウンド更新",
    readFailed: "読み取り失敗",
    readingDevices: "機器を読み取り中",
    unavailable: "取得不可",
    today: "今日",
    selectedRange: "選択範囲",
    notSet: "未設定",
    now: "現在",
    minAgo: "30分前",
    hourAgo: "3時間前",
    timeAxis: "時間",
    wattsAxis: "電力 (W)",
    percentAxis: "充電率 (%)",
    profileOsaifu: "おサイフ",
    profileEco: "eco",
    profileBackup: "バックアップ",
    operationAuto: "自動",
    operationStandby: "待機",
    operationRapid: "急速充電",
    operationCharge: "充電",
    operationDischarge: "放電",
    startHour: "開始時刻",
    endHour: "終了時刻",
    percent: "パーセント",
    charging: "充電中",
    discharging: "放電中",
    standby: "待機中",
    auto: "自動",
    generating: "発電中",
    stopped: "停止中",
    starting: "起動中",
    stopping: "停止処理中",
    rapid_charging: "急速充電中",
    on: "オン",
    off: "オフ",
    chargeAction: "目標Whを指定して充電",
    dischargeAction: "目標Whを指定して放電",
    setAutoAction: "運転モードを自動にする",
    setStandbyAction: "運転モードを待機にする",
    setRapidAction: "運転モードを急速充電にする",
    setChargeAction: "運転モードを充電にする",
    setDischargeAction: "運転モードを放電にする",
    setProfileAction: "充電プロファイルを設定",
    setLimitAction: "放電下限を設定",
    setChargeWindowAction: "充電時間帯を設定",
    setDischargeWindowAction: "放電時間帯を設定",
    setOperationModeAction: "運転モードを設定",
    automationRules: "自動化ルール",
    backupDemandGuard: "ブレーカー落ちガード",
    backupGuardEnabled: "ブレーカー落ちガードを有効化",
    breakerAmps: "ブレーカー容量(A)",
    reserveAmps: "余裕(A)",
    batteryChargeEstimate: "蓄電池の最大充電電力(W)",
    restoreBelowAmps: "復帰しきい値(A)",
    restoreDelay: "復帰待機秒数",
    saveAutomation: "自動化を保存",
    automationSaved: "自動化を保存しました",
    automationNoRules: "自動化ルールはありません。",
  },
};
const DAY_KEYS = [
  "daySun",
  "dayMon",
  "dayTue",
  "dayWed",
  "dayThu",
  "dayFri",
  "daySat",
];

function t(key) {
  return I18N[state.language]?.[key] ?? I18N.en[key] ?? key;
}

function template(key, values) {
  return t(key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

function setLanguage(language) {
  // Swap text in-place. Controls are regenerated where option labels depend on
  // the active language, but device values are left untouched.
  state.language = ["en", "ja"].includes(language) ? language : "en";
  document.documentElement.lang = state.language;
  document.title =
    state.language === "ja"
      ? "ホームエネルギー & バッテリー"
      : "HOME ENERGY & BATTERY";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const value = t(el.dataset.i18n);
    if (value.includes("<")) el.innerHTML = value;
    else el.textContent = value;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-mode-label]").forEach((el) => {
    const value = el.dataset.modeLabel;
    const key = value
      ? `profile${value.replace(/^./, (c) => c.toUpperCase())}`
      : "";
    el.textContent = key ? t(key) : "";
  });
  $("#languageSelect").value = state.language;
  populateActionOptions();
  schedulePayloadFields($("#scheduleAction")?.value ?? "vendor-profile");
  if (state.schedules.length) renderSchedules(state.schedules);
  const serviceKey = $("#serviceState")?.dataset.stateKey;
  if (serviceKey) setServiceState(serviceKey);
  if (state.status) renderDashboard(state.status, { recordTrend: false });
  drawAllTrends();
}

function displayValue(value) {
  return t(value) || value;
}

function setServiceState(key) {
  const el = $("#serviceState");
  if (!el) return;
  el.dataset.stateKey = key;
  el.textContent = t(key);
}

function actionLabel(action) {
  return (
    {
      "vendor-profile": t("setProfileAction"),
      "discharge-limit": t("setLimitAction"),
      "osaifu-charge-window": t("setChargeWindowAction"),
      "osaifu-discharge-window": t("setDischargeWindowAction"),
      charge: t("chargeAction"),
      discharge: t("dischargeAction"),
      "set-mode": t("setOperationModeAction"),
    }[action] ?? action
  );
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  // Small JSON helper used by every form and polling loop.
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setText(selector, value) {
  $(selector).textContent = value ?? "--";
}

function metricValue(item, fallback = "--") {
  if (!item) return fallback;
  if (item.human) return item.human;
  if (item.value !== undefined && item.unit)
    return `${item.value} ${item.unit}`;
  if (item.value !== undefined) return String(item.value);
  return item.raw ?? fallback;
}

function numericValue(item) {
  return Number(item?.value ?? 0);
}

function watts(value) {
  return Number.isFinite(value) ? `${Math.round(value)} W` : "-- W";
}

function yen(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat(state.language === "ja" ? "ja-JP" : "en-US", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function localDateTimeValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function rangeLabel(summary, fallbackKey) {
  if (!summary?.start || !summary?.end) return t(fallbackKey);
  return `${new Date(summary.start).toLocaleString()} - ${new Date(summary.end).toLocaleString()}`;
}

function resetTrendHistory() {
  state.trendHistory = {};
}

function parseOsaifuWindow(setting) {
  // Prefer decoded fields from the server, but fall back to raw 0xSS00EE00 so
  // selectors still populate when only a raw vendor value is available.
  const decoded = setting?.decoded ?? {};
  const start = Number(
    decoded.start_hour ??
      decoded.startHour ??
      decoded.charge_start_hour ??
      decoded.discharge_start_hour,
  );
  const end = Number(
    decoded.end_hour ??
      decoded.endHour ??
      decoded.charge_end_hour ??
      decoded.discharge_end_hour,
  );
  if (Number.isInteger(start) && Number.isInteger(end)) {
    return { start, end };
  }
  const raw = setting?.raw;
  if (typeof raw === "string" && /^0x[0-9a-fA-F]{8}$/.test(raw)) {
    const hex = raw.slice(2);
    return {
      start: Number.parseInt(hex.slice(0, 2), 16),
      end: Number.parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

function populateActionOptions() {
  const actionOptions = [
    ["vendor-profile", "setProfileAction"],
    ["discharge-limit", "setLimitAction"],
    ["osaifu-charge-window", "setChargeWindowAction"],
    ["osaifu-discharge-window", "setDischargeWindowAction"],
    ["charge", "chargeAction"],
    ["discharge", "dischargeAction"],
    ["set-mode", "setOperationModeAction"],
  ];
  const directOptions = [
    ["charge", "chargeAction"],
    ["discharge", "dischargeAction"],
    ["set-mode:auto", "setAutoAction"],
    ["set-mode:standby", "setStandbyAction"],
    ["set-mode:rapid", "setRapidAction"],
    ["set-mode:charge", "setChargeAction"],
    ["set-mode:discharge", "setDischargeAction"],
  ];
  const fill = (selector, options) => {
    const select = $(selector);
    if (!select) return;
    const selected = select.value || options[0][0];
    select.innerHTML = options
      .map(([value, key]) => `<option value="${value}">${t(key)}</option>`)
      .join("");
    if (options.some(([value]) => value === selected)) select.value = selected;
  };
  fill("#scheduleAction", actionOptions);
  fill("#directAction", directOptions);
}

function pushTrend(name, value, time = Date.now()) {
  // Trends are kept client-side for live mode. Historical mode repopulates this
  // same structure from samples loaded from disk.
  const config = TREND_CONFIG[name];
  if (!config || !Number.isFinite(value)) return;
  const history = state.trendHistory[name] ?? [];
  history.push({ time, value });
  const horizonMs =
    state.historyMode && state.historyHorizonMs
      ? state.historyHorizonMs
      : config.horizonMs;
  const cutoff = time - horizonMs;
  state.trendHistory[name] = history.filter((point) => point.time >= cutoff);
  drawTrend(name);
}

function drawAllTrends() {
  Object.keys(TREND_CONFIG).forEach(drawTrend);
}

function drawTrend(name) {
  // Canvas keeps the UI dependency-free. The chart is deliberately simple:
  // gridlines, min/max labels, a time axis, filled area, and current point.
  const config = TREND_CONFIG[name];
  const canvas = $(config.canvas);
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  if (
    canvas.width !== Math.round(width * dpr) ||
    canvas.height !== Math.round(height * dpr)
  ) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = state.trendHistory[name] ?? [];
  const pad = { top: 10, right: 8, bottom: 28, left: 48 };
  const chartWidth = Math.max(1, width - pad.left - pad.right);
  const chartHeight = Math.max(1, height - pad.top - pad.bottom);
  const unit = name === "batterySoc" ? "%" : "W";

  ctx.strokeStyle = "#dbe5ef";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i += 1) {
    const y = pad.top + (chartHeight * i) / 2;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  const values = points.map((point) => point.value);
  let min = config.min ?? (points.length ? Math.min(...values) : 0);
  let max =
    config.max ??
    (points.length ? Math.max(...values) : config.signed ? 1000 : 100);
  if (config.includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (config.signed) {
    const abs = Math.max(Math.abs(min), Math.abs(max), 1);
    min = -abs;
    max = abs;
  }
  if (min === max) {
    const padValue = Math.max(1, Math.abs(max) * 0.1);
    min -= padValue;
    max += padValue;
  }

  ctx.fillStyle = "#64748b";
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(max)}${unit}`, pad.left - 5, pad.top);
  ctx.fillText(
    `${Math.round(min)}${unit}`,
    pad.left - 5,
    pad.top + chartHeight,
  );

  ctx.save();
  ctx.translate(9, pad.top + chartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(unit === "%" ? t("percentAxis") : t("wattsAxis"), 0, 0);
  ctx.restore();

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const horizonMs =
    state.historyMode && state.historyHorizonMs
      ? state.historyHorizonMs
      : config.horizonMs;
  const firstLabel = points[0]?.time
    ? new Date(points[0].time).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : state.historyMode
      ? t("selectedRange")
      : config.horizonMs === SOC_TREND_MS
        ? t("hourAgo")
        : t("minAgo");
  const lastLabel = points[points.length - 1]?.time
    ? new Date(points[points.length - 1].time).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : t("now");
  ctx.fillText(firstLabel, pad.left, height - 14);
  ctx.textAlign = "right";
  ctx.fillText(lastLabel, width - pad.right, height - 14);
  ctx.textAlign = "center";
  ctx.fillText(t("timeAxis"), pad.left + chartWidth / 2, height - 3);

  if (!points.length) return;

  const now = points[points.length - 1].time;
  const start = now - horizonMs;
  const range = max - min;
  const xFor = (time) => pad.left + ((time - start) / horizonMs) * chartWidth;
  const yFor = (value) =>
    pad.top + chartHeight - ((value - min) / range) * chartHeight;

  if (min < 0 && max > 0) {
    const zeroY = yFor(0);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.28)";
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(width - pad.right, zeroY);
    ctx.stroke();
  }

  const plotted = points.map((point) => ({
    x: xFor(point.time),
    y: yFor(point.value),
  }));
  if (plotted.length === 1) {
    plotted.unshift({ x: pad.left, y: plotted[0].y });
  }

  ctx.beginPath();
  ctx.moveTo(plotted[0].x, height - pad.bottom);
  for (const point of plotted) ctx.lineTo(point.x, point.y);
  ctx.lineTo(plotted[plotted.length - 1].x, height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = config.fill;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(plotted[0].x, plotted[0].y);
  for (const point of plotted.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.strokeStyle = config.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const last = plotted[plotted.length - 1];
  ctx.fillStyle = config.color;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fill();

  const hover = state.trendHover[name];
  if (hover && Number.isFinite(hover.time) && Number.isFinite(hover.value)) {
    const hoverX = xFor(hover.time);
    const hoverY = yFor(hover.value);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hoverX, pad.top);
    ctx.lineTo(hoverX, height - pad.bottom);
    ctx.stroke();
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(hoverX, hoverY, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ensureTrendTooltip() {
  let tooltip = $("#trendTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "trendTooltip";
    tooltip.className = "trend-tooltip hidden";
    document.body.append(tooltip);
  }
  return tooltip;
}

function handleTrendPointer(name, event) {
  const config = TREND_CONFIG[name];
  const canvas = $(config.canvas);
  const points = state.trendHistory[name] ?? [];
  if (!canvas || !points.length) return;
  const rect = canvas.getBoundingClientRect();
  const pad = { top: 10, right: 8, bottom: 28, left: 48 };
  const chartWidth = Math.max(1, rect.width - pad.left - pad.right);
  const horizonMs =
    state.historyMode && state.historyHorizonMs
      ? state.historyHorizonMs
      : config.horizonMs;
  const now = points[points.length - 1].time;
  const start = now - horizonMs;
  const x = Math.max(
    pad.left,
    Math.min(rect.width - pad.right, event.clientX - rect.left),
  );
  const targetTime = start + ((x - pad.left) / chartWidth) * horizonMs;
  const nearest = points.reduce(
    (best, point) =>
      Math.abs(point.time - targetTime) < Math.abs(best.time - targetTime)
        ? point
        : best,
    points[0],
  );
  state.trendHover[name] = nearest;
  drawTrend(name);
  const tooltip = ensureTrendTooltip();
  const unit = name === "batterySoc" ? "%" : "W";
  tooltip.textContent = `${new Date(nearest.time).toLocaleString()} · ${Math.round(nearest.value)} ${unit}`;
  tooltip.style.left = `${Math.min(window.innerWidth - 260, event.clientX + 12)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY + 12)}px`;
  tooltip.classList.remove("hidden");
}

function clearTrendPointer(name) {
  delete state.trendHover[name];
  drawTrend(name);
  $("#trendTooltip")?.classList.add("hidden");
}

function setBar(selector, percent) {
  const el = $(selector);
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setPowerBar(selector, watts, maxWatts = 3000) {
  const el = $(selector);
  if (!el) return;
  const percent = Math.max(-100, Math.min(100, (watts / maxWatts) * 100));
  el.style.width = `${Math.abs(percent)}%`;
  el.style.marginLeft = percent < 0 ? `${50 - Math.abs(percent) / 2}%` : "50%";
  el.classList.toggle("negative", percent < 0);
}

function selectHourOptions(select) {
  select.innerHTML = "";
  const current = document.createElement("option");
  current.value = "";
  current.textContent = "--";
  select.append(current);
  for (let i = 0; i < 24; i += 1) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = `${String(i).padStart(2, "0")}:00`;
    select.append(option);
  }
}

function hourOptions() {
  return Array.from(
    { length: 24 },
    (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}:00</option>`,
  ).join("");
}

function operationModeOptions() {
  return `
    <option value="auto">${t("operationAuto")}</option>
    <option value="standby">${t("operationStandby")}</option>
    <option value="rapid">${t("operationRapid")}</option>
    <option value="charge">${t("operationCharge")}</option>
    <option value="discharge">${t("operationDischarge")}</option>
  `;
}

function rateBandRow(band = {}, index = 0) {
  return `
    <div class="rate-band-row" data-rate-band="${index}">
      <label><span>${t("rateBandLabel")}</span><input data-rate-field="label" value="${band.label ?? ""}" /></label>
      <label><span>${t("rateBandStart")}</span><input data-rate-field="start" type="time" value="${band.start ?? "00:00"}" /></label>
      <label><span>${t("rateBandEnd")}</span><input data-rate-field="end" type="time" value="${band.end ?? "00:00"}" /></label>
      <label><span>${t("rateBandPrice")}</span><input data-rate-field="yenPerKwh" type="number" min="0" step="0.01" value="${band.yenPerKwh ?? ""}" /></label>
      <button class="ghost remove-rate-band" type="button">${t("removeRateBand")}</button>
    </div>
  `;
}

function renderRateBands(bands = []) {
  const el = $("#rateBands");
  if (!el) return;
  const source = bands.length
    ? bands
    : [
        {
          start: "00:00",
          end: "07:00",
          yenPerKwh: $("#offPeakRate")?.value || 25,
          label: "Off-peak",
        },
      ];
  el.innerHTML = source.map(rateBandRow).join("");
}

function collectRateBands() {
  return $$("#rateBands .rate-band-row")
    .map((row) => {
      const field = (name) =>
        row.querySelector(`[data-rate-field="${name}"]`)?.value ?? "";
      return {
        label: field("label"),
        start: field("start") || "00:00",
        end: field("end") || "00:00",
        yenPerKwh: Number(field("yenPerKwh")),
      };
    })
    .filter((band) => Number.isFinite(band.yenPerKwh));
}

function defaultOffPeakBands(standardRate, offPeakRate) {
  return [
    {
      start: "00:00",
      end: "07:00",
      yenPerKwh: Number(offPeakRate || 0),
      label: "Off-peak",
    },
    {
      start: "07:00",
      end: "00:00",
      yenPerKwh: Number(standardRate || 0),
      label: "Standard",
    },
  ];
}

function defaultMultiBands(offPeakRate) {
  return [
    {
      start: "00:00",
      end: "07:00",
      yenPerKwh: Number(offPeakRate || 0),
      label: "Off-peak",
    },
  ];
}

function rateModeFromConfig(config = {}) {
  if (["simple", "offPeak", "multi"].includes(config.rateMode))
    return config.rateMode;
  if (config.offPeakSavingsEnabled === true)
    return (config.rateBands ?? []).length > 2 ? "multi" : "offPeak";
  return "simple";
}

function currentRateMode() {
  return (
    document.querySelector('input[name="rateMode"]:checked')?.value ?? "simple"
  );
}

function updateRateModeVisibility(mode = currentRateMode()) {
  $$("[data-rate-mode-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.rateModePanel !== mode);
  });
}

function buildRateConfigBody() {
  const mode = currentRateMode();
  if (mode === "simple") {
    const rate = Number($("#simpleRate").value || 0);
    return {
      rateMode: "simple",
      standardRateYenPerKwh: rate,
      offPeakRateYenPerKwh: rate,
      offPeakSavingsEnabled: false,
      rateBands: [
        { start: "00:00", end: "00:00", yenPerKwh: rate, label: "Simple" },
      ],
    };
  }
  if (mode === "offPeak") {
    const standardRate = Number($("#standardRate").value || 0);
    const offPeakRate = Number($("#offPeakRate").value || 0);
    return {
      rateMode: "offPeak",
      standardRateYenPerKwh: standardRate,
      offPeakRateYenPerKwh: offPeakRate,
      offPeakSavingsEnabled: true,
      rateBands: defaultOffPeakBands(standardRate, offPeakRate),
    };
  }
  const bands = collectRateBands();
  const rates = bands.map((band) => band.yenPerKwh).filter(Number.isFinite);
  const standardRate = Number(
    $("#multiStandardRate").value || Math.max(...rates, 0),
  );
  const offPeakRate = Math.min(...rates, standardRate);
  return {
    rateMode: "multi",
    standardRateYenPerKwh: standardRate,
    offPeakRateYenPerKwh: offPeakRate,
    offPeakSavingsEnabled: true,
    rateBands: bands.length ? bands : defaultMultiBands(offPeakRate),
  };
}

function defaultAutomationRule(config = {}) {
  return {
    name: "Charging demand guard",
    type: "backup-demand-guard",
    enabled: false,
    conditions: {
      source: "houseDemandW",
      breakerAmps: config.automation?.breakerAmps ?? 40,
      breakerVoltage: config.automation?.breakerVoltage ?? 100,
      reserveAmps: config.automation?.reserveAmps ?? 5,
      batteryChargingEstimateW: 1000,
      restoreBelowAmps: Math.max(
        1,
        (config.automation?.breakerAmps ?? 40) - 10,
      ),
      restoreDelaySeconds: 300,
    },
    action: "set-mode",
    payload: { mode: "standby" },
    restoreAction: "set-mode",
    restorePayload: { mode: "auto" },
    cooldownSeconds: 300,
  };
}

function updateAutomationControls(rules = state.automationRules) {
  const rule =
    rules.find((item) => item.type === "backup-demand-guard") ??
    defaultAutomationRule(state.config ?? {});
  $("#automationEnabled").checked = rule.enabled === true;
  $("#automationBreakerAmps").value = rule.conditions?.breakerAmps ?? "";
  $("#automationReserveAmps").value = rule.conditions?.reserveAmps ?? "";
  $("#automationBatteryEstimate").value =
    rule.conditions?.batteryChargingEstimateW ?? "";
  $("#automationRestoreBelow").value = rule.conditions?.restoreBelowAmps ?? "";
  $("#automationRestoreDelay").value =
    rule.conditions?.restoreDelaySeconds ?? "";
  const status = rule.lastResult
    ? `${new Date(rule.lastResult.at).toLocaleString()} · ${rule.lastResult.error || rule.lastResult.skipped || rule.lastResult.kind || "ok"}`
    : rule.id
      ? rule.enabled
        ? t("waiting")
        : t("disabled")
      : t("automationNoRules");
  $("#automationStatus").textContent = status;
}

async function refreshAutomationRules() {
  state.automationRules = await api("/api/automation-rules");
  updateAutomationControls(state.automationRules);
  return state.automationRules;
}

function updateControls(data) {
  // Settings are hydrated only when entering the Settings page so sliders/selects
  // do not jump around while the user is editing them.
  const mode = data.settings?.mode?.decoded?.mode;
  const selected = document.querySelector(
    `input[name="mode"][value="${mode}"]`,
  );
  if (selected) selected.checked = true;

  const dischargeLimitData = data.settings?.discharge_limit?.decoded
    ? data.settings.discharge_limit
    : data.settings?.discharge_limit?.lastKnown;
  const limit = dischargeLimitData?.decoded?.percent;
  if (Number.isInteger(limit)) {
    $("#limitValue").value = String(limit);
    $("#limitOutput").textContent = `${limit}%`;
  }

  const chargeData = data.settings?.osaifu_charge_window?.decoded
    ? data.settings.osaifu_charge_window
    : data.settings?.osaifu_charge_window?.lastKnown;
  const charge = parseOsaifuWindow(chargeData);
  if (charge) {
    $("#chargeStart").value = String(charge.start);
    $("#chargeEnd").value = String(charge.end);
  } else {
    $("#chargeStart").value = "";
    $("#chargeEnd").value = "";
  }

  const dischargeData = data.settings?.osaifu_discharge_window?.decoded
    ? data.settings.osaifu_discharge_window
    : data.settings?.osaifu_discharge_window?.lastKnown;
  const discharge = parseOsaifuWindow(dischargeData);
  if (discharge) {
    $("#dischargeStart").value = String(discharge.start);
    $("#dischargeEnd").value = String(discharge.end);
  } else {
    $("#dischargeStart").value = "";
    $("#dischargeEnd").value = "";
  }
}

function updateConfigControls(config) {
  state.config = config;
  setLanguage(config.language ?? "en");
  applyFeatureVisibility(config);
  $("#updateIntervalSeconds").value = config.updateIntervalSeconds ?? 15;
  $("#configBatteryHost").value = config.batteryHost ?? "";
  $("#configMeterHost").value = config.meterHost ?? "";
  $("#configSolarHost").value = config.solarHost ?? "";
  $("#configFuelCellHosts").value = (config.fuelCellHosts ?? []).join(",");
  $("#configSmartMeterHost").value = config.smartMeterHost ?? "";
  $("#configDiscoverySubnets").value = (config.discoverySubnets ?? []).join(
    ",",
  );
  $("#configSolarEnabled").checked = config.solarEnabled !== false;
  $("#configFuelCellEnabled").checked = config.fuelCellEnabled !== false;
  const rateMode = rateModeFromConfig(config);
  const modeInput = document.querySelector(
    `input[name="rateMode"][value="${rateMode}"]`,
  );
  if (modeInput) modeInput.checked = true;
  $("#simpleRate").value = config.standardRateYenPerKwh ?? "";
  $("#standardRate").value = config.standardRateYenPerKwh ?? "";
  $("#offPeakRate").value = config.offPeakRateYenPerKwh ?? "";
  $("#multiStandardRate").value = config.standardRateYenPerKwh ?? "";
  $("#historyRetentionDays").value = config.historyRetentionDays ?? "";
  renderRateBands(
    rateMode === "multi"
      ? (config.rateBands ?? [])
      : defaultMultiBands(config.offPeakRateYenPerKwh ?? 25),
  );
  updateRateModeVisibility(rateMode);
  updateAutomationControls();
  $("#configSolarHost").disabled = config.solarEnabled === false;
  $("#configFuelCellHosts").disabled = config.fuelCellEnabled === false;
}

function applyFeatureVisibility(features = {}) {
  // Hide optional equipment/widgets for homes without solar, fuel cell, or
  // off-peak savings calculations enabled.
  const solarEnabled = features.solarEnabled !== false;
  const fuelCellEnabled = features.fuelCellEnabled !== false;
  const featureRateMode = features.rateMode ?? state.config?.rateMode;
  const offPeakSavingsEnabled =
    featureRateMode !== "simple" && featureRateMode !== undefined
      ? true
      : features.offPeakSavingsEnabled === true ||
        state.config?.offPeakSavingsEnabled === true;
  $$('[data-feature="solar"]').forEach((el) =>
    el.classList.toggle("hidden", !solarEnabled),
  );
  $$('[data-feature="fuel-cell"]').forEach((el) =>
    el.classList.toggle("hidden", !fuelCellEnabled),
  );
  $$('[data-feature="off-peak-savings"]').forEach((el) =>
    el.classList.toggle("hidden", !offPeakSavingsEnabled),
  );
}

function strongestFuelCellWatts(fuelCells) {
  const values = fuelCells
    .map((cell) => Number(cell.instant_power?.value))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function renderDashboard(data, options = {}) {
  // The server returns raw and decoded data together. The dashboard uses decoded
  // values, while the Debug menu exposes the full payload for reverse engineering.
  const recordTrend = options.recordTrend ?? true;
  state.status = data;
  applyFeatureVisibility(data.features ?? state.config ?? {});
  const now = Date.now();
  setText("#batteryPower", watts(data.energy?.battery?.instant_power?.value));
  setText(
    "#batterySoc",
    Number.isFinite(data.energy?.battery?.remaining_percent?.value)
      ? `${data.energy.battery.remaining_percent.value}%`
      : "--%",
  );
  setText(
    "#batteryWorking",
    displayValue(data.energy?.battery?.working_status?.human),
  );
  setText(
    "#operationMode",
    displayValue(data.energy?.battery?.operation_mode?.human),
  );
  const profile = data.settings?.mode?.decoded?.mode;
  setText(
    "#vendorProfile",
    profile
      ? displayValue(`profile${profile.replace(/^./, (c) => c.toUpperCase())}`)
      : "--",
  );
  const dischargeLimitData = data.settings?.discharge_limit?.decoded
    ? data.settings.discharge_limit
    : data.settings?.discharge_limit?.lastKnown;
  setText(
    "#dischargeLimitWidget",
    dischargeLimitData?.decoded?.human ??
      (data.settings?.discharge_limit?.available === false
        ? t("unavailable")
        : "--"),
  );
  const solarEnabled = data.features?.solarEnabled !== false;
  const fuelCellEnabled = data.features?.fuelCellEnabled !== false;
  setText(
    "#solarPower",
    solarEnabled ? metricValue(data.energy?.solar?.instant_power) : "-- W",
  );

  const batteryWatts = numericValue(data.energy?.battery?.instant_power);
  const soc = numericValue(data.energy?.battery?.remaining_percent);
  const dischargeLimit = Number(dischargeLimitData?.decoded?.percent ?? 0);
  const solarWatts = solarEnabled
    ? numericValue(data.energy?.solar?.instant_power)
    : Number.NaN;
  const houseDemandWatts = data.meter?.house_demand_power?.value;
  const gridImportWatts = data.meter?.grid_import_power?.value;
  const gridExportWatts = data.meter?.grid_export_power?.value;
  $("#batterySocGauge").style.setProperty(
    "--value",
    Math.max(0, Math.min(100, soc)),
  );
  setBar("#dischargeLimitBar", dischargeLimit);
  setText(
    "#houseDemandPower",
    Number.isFinite(houseDemandWatts)
      ? `${houseDemandWatts} W`
      : data.meter?.configured
        ? t("unavailable")
        : t("notSet"),
  );
  setText(
    "#gridImportPower",
    Number.isFinite(gridImportWatts)
      ? `${gridImportWatts} W`
      : data.meter?.configured
        ? t("unavailable")
        : t("notSet"),
  );
  setText(
    "#gridExportPower",
    Number.isFinite(gridExportWatts)
      ? `${gridExportWatts} W`
      : data.meter?.configured
        ? t("unavailable")
        : t("notSet"),
  );

  const fuelCells = fuelCellEnabled ? (data.energy?.fuel_cells ?? []) : [];
  const fuelCellWatts = fuelCellEnabled
    ? strongestFuelCellWatts(fuelCells)
    : Number.NaN;
  const fuelStatuses = [
    ...new Set(
      fuelCells.map((cell) => cell.generation_status?.human).filter(Boolean),
    ),
  ];
  setText(
    "#fuelCellPower",
    Number.isFinite(fuelCellWatts) ? `${fuelCellWatts} W` : "-- W",
  );
  setText("#fuelCellStatus", fuelStatuses.map(displayValue).join(", ") || "--");
  setText("#solarSavings", yen(Number(data.savings?.solarSavingYen)));
  setText("#offPeakSavings", yen(Number(data.savings?.offPeakSavingYen)));
  setText(
    "#solarSavingsPeriod",
    state.historyMode ? rangeLabel(data.savings, "selectedRange") : t("today"),
  );
  setText(
    "#offPeakSavingsPeriod",
    state.historyMode ? rangeLabel(data.savings, "selectedRange") : t("today"),
  );

  if (recordTrend) {
    pushTrend("batteryPower", batteryWatts, now);
    pushTrend("batterySoc", soc, now);
    pushTrend("solarPower", solarWatts, now);
    pushTrend("houseDemandPower", Number(houseDemandWatts), now);
    pushTrend("gridExportPower", Number(gridExportWatts), now);
    pushTrend("gridImportPower", Number(gridImportWatts), now);
    pushTrend("fuelCellPower", Number(fuelCellWatts), now);
  } else {
    drawAllTrends();
  }

  $("#rawJson").textContent = JSON.stringify(data, null, 2);
}

function renderInitialStatus(data) {
  renderDashboard(data);
}

function renderHistory(history) {
  // Historical mode uses persisted samples instead of live polling. It pauses the
  // refresh timer until the user presses Live again.
  state.historyMode = true;
  clearTimeout(state.refreshTimer);
  resetTrendHistory();
  const samples = history.samples ?? [];
  if (samples.length > 1) {
    state.historyHorizonMs = Math.max(
      60_000,
      new Date(samples[samples.length - 1].timestamp).getTime() -
        new Date(samples[0].timestamp).getTime(),
    );
  } else {
    state.historyHorizonMs = POWER_TREND_MS;
  }
  for (const sample of samples) {
    const time = new Date(sample.timestamp).getTime();
    pushTrend("batteryPower", Number(sample.batteryPowerW), time);
    pushTrend("batterySoc", Number(sample.stateOfChargePercent), time);
    pushTrend("solarPower", Number(sample.solarPowerW), time);
    pushTrend("houseDemandPower", Number(sample.houseDemandW), time);
    pushTrend("gridExportPower", Number(sample.gridExportW), time);
    pushTrend("gridImportPower", Number(sample.gridImportW), time);
    pushTrend("fuelCellPower", Number(sample.fuelCellPowerW), time);
  }
  const latest = samples[samples.length - 1] ?? {};
  const syntheticStatus = {
    ...(state.status ?? {}),
    features: state.config ?? state.status?.features ?? {},
    savings: history.summary,
    energy: {
      ...(state.status?.energy ?? {}),
      battery: {
        ...(state.status?.energy?.battery ?? {}),
        instant_power: { value: latest.batteryPowerW, unit: "W" },
        remaining_percent: { value: latest.stateOfChargePercent, unit: "%" },
      },
      solar: { instant_power: { value: latest.solarPowerW, unit: "W" } },
      fuel_cells: [
        { instant_power: { value: latest.fuelCellPowerW, unit: "W" } },
      ],
    },
    meter: {
      ...(state.status?.meter ?? {}),
      configured: true,
      house_demand_power: { value: latest.houseDemandW, unit: "W" },
      grid_import_power: { value: latest.gridImportW, unit: "W" },
      grid_export_power: { value: latest.gridExportW, unit: "W" },
    },
  };
  renderDashboard(syntheticStatus, { recordTrend: false });
  $("#rawJson").textContent = JSON.stringify(history, null, 2);
  setServiceState("historicalData");
}

function schedulePayloadFields(action) {
  // Schedule payloads mirror the same action names used by immediate buttons, so
  // the server can execute scheduled and manual actions through one code path.
  const el = $("#schedulePayload");
  const modeOptions = `
    <label>${t("chargingProfile")}
      <select data-payload="mode">
        <option value="osaifu">${t("profileOsaifu")}</option>
        <option value="eco">${t("profileEco")}</option>
        <option value="backup">${t("profileBackup")}</option>
      </select>
    </label>`;
  const operationOptions = `
    <label>${t("operationMode")}
      <select data-payload="mode">${operationModeOptions()}</select>
    </label>`;
  const windowFields = `
    <label>${t("startHour")}
      <select data-payload="startHour">${hourOptions()}</select>
    </label>
    <label>${t("endHour")}
      <select data-payload="endHour">${hourOptions()}</select>
    </label>`;
  const targetField = `
    <label>${t("targetWh")}
      <input data-payload="targetWh" type="number" min="0" placeholder="${t("optional")}" />
    </label>`;
  const limitField = `
    <label>${t("percent")}
      <select data-payload="percent">
        ${Array.from({ length: 11 }, (_, i) => `<option value="${i * 10}">${i * 10}%</option>`).join("")}
      </select>
    </label>`;

  if (action === "vendor-profile") el.innerHTML = modeOptions;
  else if (action === "set-mode") el.innerHTML = operationOptions;
  else if (action === "discharge-limit") el.innerHTML = limitField;
  else if (action.includes("window")) el.innerHTML = windowFields;
  else el.innerHTML = targetField;
}

function collectPayload() {
  const payload = {};
  document.querySelectorAll("[data-payload]").forEach((input) => {
    if (input.value !== "") payload[input.dataset.payload] = input.value;
  });
  return payload;
}

function scheduleWhen(schedule) {
  if (schedule.repeat === "daily") return `${t("daily")} ${schedule.time}`;
  return new Date(schedule.runAt).toLocaleString();
}

function scheduleDays(schedule) {
  const days =
    Array.isArray(schedule.days) && schedule.days.length
      ? schedule.days
      : [0, 1, 2, 3, 4, 5, 6];
  if (days.length === 7) return t("everyDay");
  return days
    .sort((a, b) => a - b)
    .map((day) => t(DAY_KEYS[day]))
    .join(", ");
}

function renderSchedules(schedules) {
  state.schedules = schedules;
  const rows = $("#scheduleRows");
  rows.innerHTML = "";
  if (!schedules.length) {
    rows.innerHTML = `<tr><td colspan="5">${t("noSchedules")}</td></tr>`;
    return;
  }
  for (const schedule of schedules) {
    const tr = document.createElement("tr");
    const status = schedule.lastResult
      ? schedule.lastResult.ok
        ? `${t("lastRan")} ${new Date(schedule.lastResult.at).toLocaleString()}`
        : schedule.lastResult.error
      : schedule.enabled
        ? t("waiting")
        : t("disabled");
    tr.innerHTML = `
      <td>${scheduleWhen(schedule)}</td>
      <td>${actionLabel(schedule.action)}</td>
      <td>${schedule.repeat === "daily" ? scheduleDays(schedule) : ""}<br><code>${JSON.stringify(schedule.payload)}</code></td>
      <td>${status}</td>
      <td><button class="delete" data-delete="${schedule.id}">Delete</button></td>
    `;
    rows.append(tr);
  }
}

function setPage(page) {
  $$(".page").forEach((el) => el.classList.remove("active-page"));
  $(`#${page}Page`).classList.add("active-page");
  $$(".nav-button").forEach((button) =>
    button.classList.toggle("active", button.dataset.page === page),
  );
  $$("[data-dashboard-only]").forEach((el) =>
    el.classList.toggle("hidden", page !== "dashboard"),
  );
  if (page === "settings") {
    hydrateSettingsView();
  }
}

function refreshInterval() {
  const configuredMs =
    Math.max(5, Number(state.config?.updateIntervalSeconds ?? ACTIVE_REFRESH_MS / 1000)) *
    1000;
  return document.visibilityState === "visible"
    ? configuredMs
    : Math.max(configuredMs, INACTIVE_REFRESH_MS);
}

function scheduleNextRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refreshAll, refreshInterval());
}

async function refreshStatus() {
  if (state.historyMode) return;
  setServiceState("readingDevices");
  try {
    renderDashboard(await api("/api/status"));
    setServiceState(
      document.visibilityState === "visible"
        ? "serviceOnline"
        : "backgroundRefresh",
    );
  } catch (err) {
    setServiceState("readFailed");
    toast(err.message);
  }
}

async function refreshSchedules() {
  renderSchedules(await api("/api/schedules"));
}

async function refreshAll() {
  if (state.historyMode) return;
  await Promise.allSettled([refreshStatus()]);
  scheduleNextRefresh();
}

async function initialLoad() {
  setServiceState("readingDevices");
  const [statusResult, configResult] = await Promise.allSettled([
    api("/api/status"),
    api("/api/config"),
    refreshSchedules(),
    refreshAutomationRules(),
  ]);
  if (statusResult.status === "fulfilled") {
    renderInitialStatus(statusResult.value);
    setServiceState("serviceOnline");
  } else {
    setServiceState("readFailed");
    toast(statusResult.reason.message);
  }
  if (configResult.status === "fulfilled")
    updateConfigControls(configResult.value);
  scheduleNextRefresh();
}

async function hydrateSettingsView() {
  if (state.settingsLoadedForView) return;
  state.settingsLoadedForView = true;
  try {
    updateConfigControls(await api("/api/config"));
  } catch (err) {
    toast(err.message);
  }
  try {
    updateControls(await api("/api/status"));
  } catch (err) {
    toast(err.message);
  }
  try {
    await refreshAutomationRules();
  } catch (err) {
    toast(err.message);
  }
}

async function mutate(path, body, success) {
  try {
    await api(path, { method: "POST", body });
    toast(success);
    await refreshAll();
  } catch (err) {
    toast(err.message);
  }
}

function initForms() {
  ["#chargeStart", "#chargeEnd", "#dischargeStart", "#dischargeEnd"].forEach(
    (selector) => selectHourOptions($(selector)),
  );
  populateActionOptions();
  $("#limitValue").addEventListener("input", () => {
    $("#limitOutput").textContent = `${$("#limitValue").value}%`;
  });
  $("#refreshBtn").addEventListener("click", refreshAll);
  const now = new Date();
  $("#historyEnd").value = localDateTimeValue(now);
  $("#historyStart").value = localDateTimeValue(
    new Date(now.getTime() - 30 * 60_000),
  );
  $("#historyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const params = new URLSearchParams({
      start: new Date($("#historyStart").value).toISOString(),
      end: new Date($("#historyEnd").value).toISOString(),
    });
    try {
      renderHistory(await api(`/api/history?${params}`));
    } catch (err) {
      toast(err.message);
    }
  });
  $("#liveBtn").addEventListener("click", async () => {
    state.historyMode = false;
    state.historyHorizonMs = null;
    resetTrendHistory();
    await refreshStatus();
    scheduleNextRefresh();
  });
  for (const name of Object.keys(TREND_CONFIG)) {
    const canvas = $(TREND_CONFIG[name].canvas);
    canvas?.addEventListener("pointermove", (event) =>
      handleTrendPointer(name, event),
    );
    canvas?.addEventListener("pointerleave", () => clearTrendPointer(name));
  }
  $$(".nav-button").forEach((button) =>
    button.addEventListener("click", () => setPage(button.dataset.page)),
  );
  ["#configSolarEnabled", "#configFuelCellEnabled"].forEach((selector) => {
    $(selector).addEventListener("change", () => {
      const features = {
        solarEnabled: $("#configSolarEnabled").checked,
        fuelCellEnabled: $("#configFuelCellEnabled").checked,
      };
      $("#configSolarHost").disabled = !features.solarEnabled;
      $("#configFuelCellHosts").disabled = !features.fuelCellEnabled;
      applyFeatureVisibility(features);
    });
  });

  $("#deviceConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      batteryHost: $("#configBatteryHost").value,
      meterHost: $("#configMeterHost").value,
      solarHost: $("#configSolarHost").value,
      solarEnabled: $("#configSolarEnabled").checked,
      fuelCellHosts: $("#configFuelCellHosts").value,
      fuelCellEnabled: $("#configFuelCellEnabled").checked,
      smartMeterHost: $("#configSmartMeterHost").value,
      discoverySubnets: $("#configDiscoverySubnets").value,
      meterEoj: state.config?.meterEoj,
      rateMode: state.config?.rateMode,
      standardRateYenPerKwh: state.config?.standardRateYenPerKwh,
      offPeakRateYenPerKwh: state.config?.offPeakRateYenPerKwh,
      offPeakSavingsEnabled: state.config?.offPeakSavingsEnabled,
      rateBands: state.config?.rateBands,
      historyRetentionDays: state.config?.historyRetentionDays,
      automation: state.config?.automation,
      language: state.language,
    };
    try {
      const config = await api("/api/config", { method: "PUT", body });
      updateConfigControls(config);
      toast(t("savedAddresses"));
      await refreshStatus();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#rateConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          ...buildRateConfigBody(),
        },
      });
      updateConfigControls(config);
      toast(t("saveRates"));
      if (!state.historyMode) await refreshStatus();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#rateBands").addEventListener("click", (event) => {
    if (!event.target.classList.contains("remove-rate-band")) return;
    event.target.closest(".rate-band-row")?.remove();
  });

  $("#addRateBandBtn").addEventListener("click", () => {
    const bands = collectRateBands();
    bands.push({
      start: "23:00",
      end: "07:00",
      yenPerKwh: Number($("#multiStandardRate").value || 0),
      label: "Custom",
    });
    renderRateBands(bands);
  });

  $$('input[name="rateMode"]').forEach((input) => {
    input.addEventListener("change", () =>
      updateRateModeVisibility(input.value),
    );
  });

  $("#historyConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          historyRetentionDays: $("#historyRetentionDays").value,
        },
      });
      updateConfigControls(config);
      toast(t("saveRetention"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#trimHistoryBtn").addEventListener("click", async () => {
    try {
      const result = await api("/api/history/trim", {
        method: "POST",
        body: { retentionDays: $("#historyRetentionDays").value },
      });
      toast(`${t("historyTrimmed")}: ${result.deleted}`);
    } catch (err) {
      toast(err.message);
    }
  });

  $("#preferencesForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextLanguage = $("#languageSelect").value;
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: {
          ...(state.config ?? {}),
          language: nextLanguage,
          updateIntervalSeconds: $("#updateIntervalSeconds").value,
        },
      });
      updateConfigControls(config);
      if (!state.historyMode) scheduleNextRefresh();
      toast(t("preferencesSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#languageSelect").addEventListener("change", async () => {
    const nextLanguage = $("#languageSelect").value;
    setLanguage(nextLanguage);
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: { ...(state.config ?? {}), language: nextLanguage },
      });
      updateConfigControls(config);
    } catch (err) {
      toast(err.message);
    }
  });

  async function startDiscovery(mode, button) {
    const buttons = [$("#broadcastDiscoverBtn"), $("#activeScanBtn")];
    buttons.forEach((item) => {
      item.disabled = true;
    });
    button.textContent = t("scanning");
    $("#discoveryResults").innerHTML = "";
    renderDiscoveryProgress({
      status: "running",
      phase: "starting",
      total: 0,
      scanned: 0,
      found: 0,
      createdAt: new Date().toISOString(),
    });
    try {
      const job = await api("/api/discovery/jobs", {
        method: "POST",
        body: { timeout: 6, mode, subnets: $("#configDiscoverySubnets").value },
      });
      await pollDiscoveryJob(job.id);
    } catch (err) {
      renderDiscoveryProgress({
        status: "failed",
        phase: "failed",
        error: err.message,
      });
      $("#discoveryResults").innerHTML = "";
      toast(err.message);
    } finally {
      buttons.forEach((item) => {
        item.disabled = false;
      });
      $("#broadcastDiscoverBtn").textContent = t("broadcastDiscovery");
      $("#activeScanBtn").textContent = t("activeSubnetScan");
    }
  }

  $("#broadcastDiscoverBtn").addEventListener("click", () =>
    startDiscovery("broadcast", $("#broadcastDiscoverBtn")),
  );
  $("#activeScanBtn").addEventListener("click", () =>
    startDiscovery("active", $("#activeScanBtn")),
  );

  $("#automationRuleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const existing = state.automationRules.find(
      (rule) => rule.type === "backup-demand-guard",
    );
    const body = {
      ...(existing ?? defaultAutomationRule(state.config ?? {})),
      enabled: $("#automationEnabled").checked,
      conditions: {
        source: "houseDemandW",
        breakerAmps: $("#automationBreakerAmps").value,
        breakerVoltage: state.config?.automation?.breakerVoltage ?? 100,
        reserveAmps: $("#automationReserveAmps").value,
        batteryChargingEstimateW: $("#automationBatteryEstimate").value,
        restoreBelowAmps: $("#automationRestoreBelow").value,
        restoreDelaySeconds: $("#automationRestoreDelay").value,
      },
      action: "set-mode",
      payload: { mode: "standby" },
      restoreAction: "set-mode",
      restorePayload: { mode: "auto" },
    };
    try {
      if (existing)
        await api(`/api/automation-rules/${existing.id}`, {
          method: "PATCH",
          body,
        });
      else await api("/api/automation-rules", { method: "POST", body });
      await refreshAutomationRules();
      toast(t("automationSaved"));
    } catch (err) {
      toast(err.message);
    }
  });

  $("#modeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const mode = new FormData(event.currentTarget).get("mode");
    if (!mode) return toast(t("chooseProfile"));
    mutate(
      "/api/settings/vendor-profile",
      { mode },
      `${t("setProfileAction")}: ${displayValue(`profile${mode.replace(/^./, (c) => c.toUpperCase())}`)}`,
    );
  });

  $("#limitForm").addEventListener("submit", (event) => {
    event.preventDefault();
    mutate(
      "/api/settings/discharge-limit",
      { percent: $("#limitValue").value },
      t("setLimitAction"),
    );
  });

  $("#chargeWindowForm").addEventListener("submit", (event) => {
    event.preventDefault();
    mutate(
      "/api/settings/osaifu-charge-window",
      {
        startHour: $("#chargeStart").value,
        endHour: $("#chargeEnd").value,
      },
      t("setChargeWindowAction"),
    );
  });

  $("#dischargeWindowForm").addEventListener("submit", (event) => {
    event.preventDefault();
    mutate(
      "/api/settings/osaifu-discharge-window",
      {
        startHour: $("#dischargeStart").value,
        endHour: $("#dischargeEnd").value,
      },
      t("setDischargeWindowAction"),
    );
  });

  $("#directActionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $("#directAction").value;
    if (value.startsWith("set-mode:")) {
      const mode = value.split(":")[1];
      mutate(
        "/api/actions/set-mode",
        { mode },
        `${t("setOperationModeAction")}: ${displayValue(mode)}`,
      );
      return;
    }
    mutate(
      `/api/actions/${value}`,
      { targetWh: $("#targetWh").value },
      actionLabel(value),
    );
  });

  $("#scheduleAction").addEventListener("change", () =>
    schedulePayloadFields($("#scheduleAction").value),
  );
  $("#scheduleRepeat").addEventListener("change", () => {
    $("#scheduleTime").type =
      $("#scheduleRepeat").value === "daily" ? "time" : "datetime-local";
    $("#scheduleDays").classList.toggle(
      "disabled",
      $("#scheduleRepeat").value !== "daily",
    );
  });
  $("#scheduleDays").classList.add("disabled");
  schedulePayloadFields($("#scheduleAction").value);

  $("#scheduleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = $("#scheduleAction").value;
    const repeat = $("#scheduleRepeat").value;
    const timeValue = $("#scheduleTime").value;
    if (!timeValue) return toast(t("chooseScheduleTime"));
    const body = {
      name: action,
      action,
      repeat,
      payload: collectPayload(),
      days: collectScheduleDays(),
    };
    if (repeat === "daily") body.time = timeValue;
    else body.runAt = new Date(timeValue).toISOString();
    try {
      await api("/api/schedules", { method: "POST", body });
      toast(t("scheduleCreated"));
      await refreshSchedules();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#scheduleRows").addEventListener("click", async (event) => {
    const id = event.target.dataset.delete;
    if (!id) return;
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    await refreshSchedules();
  });

  document.addEventListener("visibilitychange", () => {
    scheduleNextRefresh();
    if (document.visibilityState === "visible") refreshStatus();
  });
  window.addEventListener("resize", drawAllTrends);
}

function collectScheduleDays() {
  return Array.from(
    document.querySelectorAll("#scheduleDays input:checked"),
  ).map((input) => Number(input.value));
}

function discoveryPhaseKey(phase) {
  return (
    {
      starting: "discoveryStarting",
      broadcast: "discoveryBroadcast",
      "active-scan": "discoveryActiveScan",
      waiting: "discoveryWaiting",
      complete: "discoveryComplete",
      failed: "discoveryFailed",
    }[phase] ?? "discoveryStarting"
  );
}

function renderDiscoveryProgress(job) {
  // Discovery can be slow on quiet networks, so progress is shown even when only
  // the current phase is known and the scan is effectively indeterminate.
  const progress = $("#discoveryProgress");
  const bar = progress.querySelector(".progress-bar");
  const fill = $("#discoveryProgressFill");
  const total = Number(job.total ?? 0);
  const scanned = Number(job.scanned ?? 0);
  const found = Number(job.found ?? job.result?.discovered?.length ?? 0);
  const percent =
    total > 0
      ? Math.max(0, Math.min(100, Math.round((scanned / total) * 100)))
      : 0;
  const elapsed = job.createdAt
    ? Math.max(
        0,
        Math.round((Date.now() - new Date(job.createdAt).getTime()) / 1000),
      )
    : 0;
  const details = [
    total > 0
      ? template("discoveryProgressCount", { scanned, total })
      : t("scanningNearby"),
    template("discoveryFoundCount", { count: found }),
    template("discoveryElapsed", { seconds: elapsed }),
  ];

  progress.classList.remove("hidden");
  $("#discoveryProgressTitle").textContent = t(discoveryPhaseKey(job.phase));
  $("#discoveryProgressDetail").textContent = details.join(" · ");
  bar.classList.toggle(
    "indeterminate",
    total === 0 && job.status === "running",
  );
  bar.setAttribute("aria-valuenow", String(percent));
  fill.style.width = total > 0 ? `${percent}%` : "";
}

async function pollDiscoveryJob(id) {
  clearTimeout(state.discoveryPollTimer);
  const job = await api(`/api/discovery/jobs/${id}`);
  renderDiscoveryProgress(job);
  if (job.status === "running") {
    await new Promise((resolve) => {
      state.discoveryPollTimer = setTimeout(resolve, 350);
    });
    return pollDiscoveryJob(id);
  }
  if (job.status === "failed")
    throw new Error(job.error || t("discoveryFailed"));
  renderDiscovery(job.result);
  return job.result;
}

function renderDiscovery(result) {
  state.lastDiscovery = result;
  const el = $("#discoveryResults");
  if (!result.discovered.length) {
    el.innerHTML = `<p>${t("noDevicesFound")}</p>`;
    return;
  }
  const rows = result.discovered
    .map(
      (device) => `
    <tr>
      <td>${device.host}</td>
      <td>${device.roles.map(localizeRole).join(", ")}</td>
      <td>${device.instances.length}</td>
    </tr>
  `,
    )
    .join("");
  el.innerHTML = `
    <div class="table-wrap discovery-table">
      <table>
        <thead>
          <tr><th>${t("address")}</th><th>${t("likelyRole")}</th><th>${t("services")}</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <button id="applyDiscoveryBtn" class="ghost" type="button">${t("useSuggestedAddresses")}</button>
  `;
  $("#applyDiscoveryBtn").addEventListener("click", () => {
    updateConfigControls(result.suggestedConfig);
    toast(t("suggestedLoaded"));
  });
}

function localizeRole(role) {
  return (
    {
      Battery: t("battery"),
      "Solar generation": t("solarGeneration"),
      "Home power meter": t("homePowerMeter"),
      "Utility meter": t("utilityMeter"),
      "Ene-Farm": t("fuelCell"),
      "Water heater": state.language === "ja" ? "給湯器" : "Water heater",
      Controller: state.language === "ja" ? "コントローラー" : "Controller",
      "Unknown energy device":
        state.language === "ja"
          ? "不明なエネルギー機器"
          : "Unknown energy device",
    }[role] ?? role
  );
}

initForms();
initialLoad();
