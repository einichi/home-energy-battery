import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { OverviewPage } from "../features/overview/OverviewPage";
import { EnergyPage } from "../features/energy/EnergyPage";
import { BatteryPage } from "../features/battery/BatteryPage";
import { AutomationPage } from "../features/automation/AutomationPage";
import { PlaceholderPage } from "../features/shared/PlaceholderPage";

const legacyGraphMetrics: Record<string, string> = {
  solarPower: "solar",
  houseDemandPower: "demand",
  gridImportPower: "import",
  gridExportPower: "export",
  batteryPower: "battery",
  batterySoc: "soc",
  fuelCellPower: "ene-farm",
  fuelCellHotWater: "hot-water",
};

function LegacyGraphRedirect() {
  const { legacyMetric = "" } = useParams();
  const metric = legacyGraphMetrics[legacyMetric];
  return <Navigate to={metric ? `/energy?metric=${metric}` : "/energy"} replace />;
}

export function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="energy" element={<EnergyPage />} />
          <Route path="graphs/:legacyMetric" element={<LegacyGraphRedirect />} />
          <Route path="solar" element={<Navigate to="/energy?metric=solar" replace />} />
          <Route path="demand" element={<Navigate to="/energy?metric=demand" replace />} />
          <Route path="grid" element={<Navigate to="/energy?metric=import" replace />} />
          <Route path="grid-import" element={<Navigate to="/energy?metric=import" replace />} />
          <Route path="grid-export" element={<Navigate to="/energy?metric=export" replace />} />
          <Route path="battery-power" element={<Navigate to="/energy?metric=battery" replace />} />
          <Route path="battery-soc" element={<Navigate to="/energy?metric=soc" replace />} />
          <Route path="ene-farm" element={<Navigate to="/energy?metric=ene-farm" replace />} />
          <Route path="circuits" element={<Navigate to="/energy#circuits" replace />} />
          <Route path="battery" element={<BatteryPage />} />
          <Route path="battery/schedules" element={<BatteryPage view="schedules" />} />
          <Route path="battery/backup" element={<BatteryPage view="backup" />} />
          <Route path="automation" element={<AutomationPage />} />
          <Route path="insights" element={<PlaceholderPage eyebrow="Understand" title="Insights" description="Energy, cost, carbon, and forecast performance." />} />
          <Route path="system" element={<PlaceholderPage eyebrow="Administer" title="System" description="Equipment, rates, notifications, data, and preferences." />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
