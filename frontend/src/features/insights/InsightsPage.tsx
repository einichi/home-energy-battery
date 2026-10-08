import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { EneFarmReport, EnergyReport, EnergyReportBucket } from "../../api/contracts";
import { EnergyPeriodSections } from "../../components/EnergyPeriodSections";
import { formatCurrency, formatDate, formatDateTimesInText, formatEnergy, formatNumber, formatPercent, formatPower } from "../../core/format";
import { useReports } from "../../hooks/useReports";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import type { ReportBucket } from "../../hooks/useReports";
import { useTranslation } from "react-i18next";

type Domain = "energy" | "circuits" | "ene-farm" | "costs" | "carbon";
type Preset = "3d" | "7d" | "30d" | "90d" | "12m" | "custom";

function rangeFor(preset: Preset) {
  const end = new Date();
  const start = new Date(end);
  if (preset === "3d") start.setDate(start.getDate() - 3);
  if (preset === "7d") start.setDate(start.getDate() - 7);
  if (preset === "30d") start.setDate(start.getDate() - 30);
  if (preset === "90d") start.setDate(start.getDate() - 90);
  if (preset === "12m") start.setFullYear(start.getFullYear() - 1);
  return { start, end };
}

function localDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function yen(value?: number | null) {
  return Number.isFinite(value) ? formatCurrency(value) : "Unavailable";
}

function number(value?: number | null, suffix = "") {
  return Number.isFinite(value) ? `${formatNumber(value)}${suffix}` : "Unavailable";
}

function Coverage({ bucket }: { bucket?: EnergyReportBucket | null }) {
  const { t } = useTranslation("insights");
  const values = Object.values(bucket?.dataQuality ?? {}).map((item) => item.coveragePercent).filter((item): item is number => Number.isFinite(item));
  if (!values.length) return <span>{t("coverageUnavailable")}</span>;
  return <span>{"" + t("lowestMetricCoverage") + " "}{formatPercent(Math.min(...values))}</span>;
}

function Trend({ report }: { report: EnergyReport }) {
  const { t } = useTranslation("insights");
  const rows = report.buckets;
  const width = 900;
  const height = 250;
  const pad = 34;
  const values = rows.flatMap((row) => [row.branchDemandKwh, row.solarGenerationKwh, row.gridImportKwh]).filter((value): value is number => Number.isFinite(value));
  const max = Math.max(1, ...values);
  const x = (index: number) => pad + (rows.length <= 1 ? 0 : index / (rows.length - 1) * (width - pad * 2));
  const y = (value: number) => height - pad - value / max * (height - pad * 2);
  const segments = (key: keyof EnergyReportBucket) => {
    const result: string[] = [];
    let current: string[] = [];
    rows.forEach((row, index) => {
      if (Number(row.sampleCount ?? 0) > 0 && Number.isFinite(row[key])) {
        current.push(`${x(index)},${y(Number(row[key]))}`);
      } else if (current.length) {
        result.push(current.join(" "));
        current = [];
      }
    });
    if (current.length) result.push(current.join(" "));
    return result;
  };
  const series = [
    { key: "branchDemandKwh" as const, className: "series-demand", label: "demand" },
    { key: "solarGenerationKwh" as const, className: "series-solar", label: "solar" },
    { key: "gridImportKwh" as const, className: "series-grid", label: "grid import" },
  ];
  return <div className="insights-chart-wrap"><svg className="insights-chart" role="img" aria-label={t("energyUseSolarGenerationAndGridImportByReportingPeriod")} viewBox={`0 0 ${width} ${height}`}>
    {[0, .5, 1].map((tick) => <g key={tick}><line x1={pad} x2={width - pad} y1={y(max * tick)} y2={y(max * tick)} /><text x={pad - 8} y={y(max * tick) + 4}>{number(max * tick)}</text></g>)}
    {series.flatMap((item) => segments(item.key).map((points, index) => <polyline key={`${item.key}-${index}`} className={item.className} points={points} />))}
    {rows.flatMap((row, index) => Number(row.sampleCount ?? 0) > 0 ? series.filter((item) => Number.isFinite(row[item.key])).map((item) => <circle key={`${row.key}-${item.key}`} className={item.className} cx={x(index)} cy={y(Number(row[item.key]))} r="4"><title>{row.label}: {t(item.label)} {formatEnergy(Number(row[item.key]))}</title></circle>) : [])}
  </svg><div className="chart-legend" aria-label={t("chartLegend")}><span className="demand">{t("demand")}</span><span className="solar">{t("solar")}</span><span className="grid">{t("gridImport")}</span></div></div>;
}

function EnergyInsights({ report }: { report: EnergyReport }) {
  const { t } = useTranslation("insights");
  const totals = report.totals;
  const observed = report.buckets.filter((row) => Number(row.sampleCount ?? 0) > 0);
  const unobservedCount = report.buckets.length - observed.length;
  const prior = observed.length > 1 ? observed.at(-2) : null;
  const latest = observed.at(-1);
  return <>
    <section className="insight-kpis" aria-label={t("energyOutcomes")}><article className="panel"><span>{t("circuitsTotal")}</span><strong>{formatEnergy(totals.branchDemandKwh)}</strong><small>{t("recordedOverSelectedPeriod")}</small></article><article className="panel"><span>{t("gridImport")}</span><strong>{formatEnergy(totals.gridImportKwh)}</strong><small>{formatEnergy(totals.gridExportKwh)} {" " + t("exported") + ""}</small></article><article className="panel"><span>{t("solarContribution")}</span><strong>{formatEnergy(totals.solarGenerationKwh)}</strong><small>{formatPercent(totals.solarCoveragePercent)} {" " + t("ofDemandGenerated") + ""}</small></article></section>
    <section className="panel insight-comparison"><div className="section-heading"><div><h2>{t("periodComparison")}</h2></div><Coverage bucket={latest} /></div>{observed.length ? <Trend report={report} /> : <p className="automation-empty">{t("noObservedReportPeriodsAreAvailable")}</p>}<div className="comparison-note"><strong>{latest?.label ?? t("latestPeriod")}</strong><span>{Number.isFinite(latest?.branchDemandDeltaPercent) ? t("valueDemandVersusThePreviousPeriod", { value: `${latest!.branchDemandDeltaPercent! > 0 ? "+" : ""}${number(latest!.branchDemandDeltaPercent, "%")}` }) : prior ? t("aComparableDemandDeltaIsUnavailable") : t("addAnotherCompletePeriodToCompareDemand")}</span></div></section>
    <section className="panel report-table"><div className="section-heading"><div><h2>{t("energyDetail")}</h2><p>{t("observedPeriodsOnly")}</p></div>{unobservedCount ? <span className="sample-count">{unobservedCount} {" " + t("noDataPeriodsOmitted") + ""}</span> : null}</div><div className="table-scroll" tabIndex={0}><table><thead><tr><th>{t("period")}</th><th>{t("circuitsTotal")}</th><th>{t("change")}</th><th>{t("solar")}</th><th>{t("import")}</th><th>{t("export")}</th><th>{t("eneFarm")}</th><th>{t("peak")}</th></tr></thead><tbody>{observed.map((row) => <tr key={row.key}><th>{row.label}</th><td>{formatEnergy(row.branchDemandKwh)}</td><td>{Number.isFinite(row.branchDemandDeltaPercent) ? number(row.branchDemandDeltaPercent, "%") : "—"}</td><td>{formatEnergy(row.solarGenerationKwh)}</td><td>{formatEnergy(row.gridImportKwh)}</td><td>{formatEnergy(row.gridExportKwh)}</td><td>{formatEnergy(row.fuelCellKwh)}</td><td>{formatPower(row.peakDemandW ?? null)}</td></tr>)}</tbody></table></div></section>
  </>;
}

function EneFarmInsights({ report }: { report: EneFarmReport }) {
  const { t } = useTranslation("insights");
  const totals = report.totals;
  return <><section className="insight-kpis" aria-label={t("eneFarmOutcomes")}><article className="panel"><span>{t("electricityGenerated")}</span><strong>{formatEnergy(totals.generatedKwh)}</strong><small>{number(totals.operatingSeconds ? totals.operatingSeconds / 3600 : null, t("hOperating"))}</small></article><article className="panel"><span>{t("gasUsed")}</span><strong>{number(totals.gasM3, " m³")}</strong><small>{number(totals.electricalYieldKwhPerM3, t("kwhMYield"))}</small></article></section><section className="panel report-table"><div className="section-heading"><div><h2>{t("eneFarmDetail")}</h2><p>{t("recordedOperationAndGenerationByReportingPeriod")}</p></div></div><div className="table-scroll" tabIndex={0}><table><thead><tr><th>{t("period")}</th><th>{t("generated")}</th><th>{t("gas")}</th><th>{t("yield")}</th><th>{t("operating")}</th><th>{t("starts")}</th></tr></thead><tbody>{report.buckets.map((row) => <tr key={row.key}><th>{row.label}</th><td>{formatEnergy(row.generatedKwh)}</td><td>{number(row.gasM3, " m³")}</td><td>{number(row.electricalYieldKwhPerM3, " kWh/m³")}</td><td>{number(row.operatingSeconds ? row.operatingSeconds / 3600 : null, " h")}</td><td>{row.startCount ?? "—"}</td></tr>)}</tbody></table></div></section></>;
}

function CostInsights({ report, eneFarm }: { report: EnergyReport; eneFarm: EneFarmReport }) {
  const { t } = useTranslation("insights");
  const { config } = useEnergyStatus();
  const totals = report.totals;
  const latest = report.buckets.filter((row) => Number(row.sampleCount ?? 0) > 0).at(-1);
  const tariff = config?.rateMode === "multi"
    ? `${config.rateBands?.length ?? 0} configured time bands`
    : `${formatCurrency(config?.standardRateYenPerKwh)} standard · ${formatCurrency(config?.offPeakRateYenPerKwh)} off-peak per kWh`;
  return <>
    <section className="insight-kpis" aria-label="Cost and savings outcomes">
      <article className="panel estimated"><span>{t("estimatedTotalSavings")}</span><strong>{yen((totals.solarSavingYen ?? 0) + (totals.totalOffPeakSavingYen ?? 0))}</strong><small>{t("solarPlusOffPeakEstimate")}</small></article>
      <article className="panel estimated"><span>{t("solarSavings")}</span><strong>{yen(totals.solarSavingYen)}</strong><small>{t("avoidedGridPurchaseEstimate")}</small></article>
      <article className="panel estimated"><span>{t("gridUseOffPeak")}</span><strong>{yen(totals.gridOffPeakSavingYen)}</strong><small>{t("discountedHouseholdGridUse")}</small></article>
      <article className="panel estimated"><span>{t("batteryChargingOffPeak")}</span><strong>{yen(totals.batteryOffPeakSavingYen)}</strong><small>{t("savingsAttributedToDiscountedCharging")}</small></article>
    </section>
    <section className="panel insight-method"><div className="section-heading"><div><h2>{t("tariffBasisAndCoverage")}</h2><p>{t("theseAreEstimatesNotBilledAmounts")}</p></div><Coverage bucket={latest} /></div><dl><div><dt>{t("configuredTariff")}</dt><dd>{tariff}</dd></div><div><dt>{t("eneFarmMarginalGasCost")}</dt><dd>{yen(eneFarm.totals.estimatedGasCost?.marginalCostYen)} · {t("excludesUnrelatedHouseholdGasUse")}</dd></div><div><dt>{t("calculation")}</dt><dd>{t("observedEnergyIsValuedAgainstTheConfiguredStandardAndDis44c527")}</dd></div></dl><Link className="text-link" to="/system/rates">{t("reviewRateConfiguration")}</Link></section>
  </>;
}

function CarbonInsights({ energy, eneFarm }: { energy: EnergyReport; eneFarm: EneFarmReport }) {
  const { t } = useTranslation("insights");
  return <>
    <section className="insight-kpis" aria-label="Carbon outcomes">
      <article className="panel estimated"><span>{t("solarAvoidedGridEmissions")}</span><strong>{number(energy.totals.co2SavingKg, " kg-CO₂")}</strong><small>{t("basedOnTheConfiguredGridEmissionsFactor")}</small></article>
      <article className="panel estimated"><span>{t("eneFarmAvoidedGridEmissions")}</span><strong>{number(eneFarm.totals.carbon?.avoidedGridCo2Kg, " kg-CO₂")}</strong><small>{t("electricityGenerationComparisonOnly")}</small></article>
      <article className="panel estimated"><span>{t("eneFarmDirectGasEmissions")}</span><strong>{number(eneFarm.totals.carbon?.directGasCo2Kg, " kg-CO₂")}</strong><small>{t("estimatedFromRecordedGasUse")}</small></article>
      <article className="panel estimated"><span>{t("eneFarmElectricityOnlyBalance")}</span><strong>{number(eneFarm.totals.carbon?.electricityOnlyBalanceKg, " kg-CO₂")}</strong><small>{t("avoidedGridEmissionsMinusDirectGas")}</small></article>
    </section>
    <section className="panel insight-method"><h2>{t("carbonDefinition")}</h2><p>{t("theEneFarmBalanceCoversElectricityGenerationAndDirectFue1ed7bd")}</p><Link className="text-link" to="/system/rates">{t("reviewEmissionsAssumptions")}</Link></section>
  </>;
}

export function ReportsPage() {
  const { t, i18n } = useTranslation("insights");
  const locale = i18n.resolvedLanguage === "ja" ? "ja" : "en";
  const [domain, setDomain] = useState<Domain>("energy");
  const [preset, setPreset] = useState<Preset>("30d");
  const [bucket, setBucket] = useState<ReportBucket>("day");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const initialRange = useMemo(() => rangeFor("30d"), []);
  const [customStart, setCustomStart] = useState(localDateValue(initialRange.start));
  const [customEnd, setCustomEnd] = useState(localDateValue(initialRange.end));
  const range = useMemo(() => {
    if (preset !== "custom") return rangeFor(preset);
    const start = new Date(`${customStart}T00:00:00`);
    const end = new Date(`${customEnd}T23:59:59.999`);
    return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= end ? { start, end } : initialRange;
  }, [preset, customStart, customEnd, initialRange]);
  const { energy, eneFarm, loading, error: reportError, refresh } = useReports(range.start, range.end, bucket);
  const error = formatDateTimesInText(reportError);
  const domainLabel = (item: Domain) => item === "energy" ? "Energy" : item === "circuits" ? "Circuits" : item === "costs" ? "Costs & savings" : item === "carbon" ? "Carbon" : "Ene-Farm";
  const hasDomainData = domain === "ene-farm" ? eneFarm : domain === "carbon" ? energy && eneFarm : domain === "circuits" ? true : energy;
  const milliseconds = Math.max(1, range.end.getTime() - range.start.getTime());
  const periodLabel = `${formatDate(range.start)}–${formatDate(range.end)}`;
  const refreshAll = () => { refresh(); setDetailRefresh((value) => value + 1); };
  const details = (sections: Parameters<typeof EnergyPeriodSections>[0]["sections"]) => <EnergyPeriodSections milliseconds={milliseconds} start={range.start.toISOString()} end={range.end.toISOString()} periodLabel={periodLabel} sections={sections} refreshKey={String(detailRefresh)} />;
  return <main className="page insights-page"><header className="page-heading"><div><p className="eyebrow">{t("historicalAnalysis")}</p><h1>{t("reports")}</h1><p>{t("exploreRecordedEnergyEquipmentCostAndCarbonOutcomesAcros888617")}</p></div><button className="quiet-button" type="button" onClick={refreshAll} disabled={loading}>{t(loading ? "Loading…" : "Refresh")}</button></header>{error ? <div className="status-banner" data-severity="critical">{"" + t("reports1b5ae4") + " "}{error}</div> : null}<section className="panel insight-controls" aria-label={t("reportControls")}><div className="segmented-control">{(["energy", "circuits", "ene-farm", "costs", "carbon"] as Domain[]).map((item) => <button key={item} type="button" aria-pressed={domain === item} onClick={() => setDomain(item)}>{t(domainLabel(item))}</button>)}</div><label>{t("period")}<select value={preset} onChange={(event) => setPreset(event.target.value as Preset)}><option value="3d">{t("last3Days")}</option><option value="7d">{t("last7Days")}</option><option value="30d">{t("last30Days")}</option><option value="90d">{t("last90Days")}</option><option value="12m">{t("last12Months")}</option><option value="custom">{t("customDates")}</option></select></label>{domain === "energy" || domain === "ene-farm" ? <label>{t("groupBy")}<select value={bucket} onChange={(event) => setBucket(event.target.value as ReportBucket)}><option value="day">{t("day")}</option><option value="week">{t("week")}</option><option value="month">{t("month")}</option></select></label> : null}{preset === "custom" ? <><label>{t("startDate")}<input type="date" value={customStart} max={customEnd} onChange={(event) => setCustomStart(event.target.value)} /></label><label>{t("endDate")}<input type="date" value={customEnd} min={customStart} onChange={(event) => setCustomEnd(event.target.value)} /></label></> : null}<span lang={locale === "ja" ? "ja" : "en"}>{periodLabel}</span></section>{loading && !hasDomainData ? <div className="panel automation-empty">{t("loadingReportEvidence")}</div> : domain === "energy" && energy ? <><EnergyInsights report={energy} />{details(["history", "balance", "battery"])}</> : domain === "circuits" ? details(["circuits"]) : domain === "costs" && energy && eneFarm ? <CostInsights report={energy} eneFarm={eneFarm} /> : domain === "carbon" && energy && eneFarm ? <CarbonInsights energy={energy} eneFarm={eneFarm} /> : domain === "ene-farm" && eneFarm ? <>{details(["ene-farm"])}<EneFarmInsights report={eneFarm} /></> : !loading ? <div className="panel automation-empty">{t("reportEvidenceIsUnavailableForThisPeriod")}</div> : null}</main>;
}
