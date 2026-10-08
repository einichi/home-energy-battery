import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "../components/AppShell";
import { ErrorBoundary } from "../components/ErrorBoundary";

const OverviewPage = lazy(() => import("../features/overview/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const BatteryPage = lazy(() => import("../features/battery/BatteryPage").then((module) => ({ default: module.BatteryPage })));
const AutomationPage = lazy(() => import("../features/automation/AutomationPage").then((module) => ({ default: module.AutomationPage })));
const ReportsPage = lazy(() => import("../features/insights/InsightsPage").then((module) => ({ default: module.ReportsPage })));
const SystemPage = lazy(() => import("../features/system/SystemPage").then((module) => ({ default: module.SystemPage })));

export function App() {
  const { t } = useTranslation("common");
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="page"><div className="panel fatal-state" role="status">{t("loadingSection")}</div></div>}><Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="battery" element={<BatteryPage />} />
          <Route path="battery/schedules" element={<BatteryPage view="schedules" />} />
          <Route path="battery/backup" element={<BatteryPage view="backup" />} />
          <Route path="automation" element={<AutomationPage />} />
          <Route path="system" element={<Navigate to="/system/equipment" replace />} />
          <Route path="system/:section" element={<SystemPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes></Suspense>
    </ErrorBoundary>
  );
}
