import { Link, NavLink, Outlet } from "react-router-dom";
import { HealthCenter } from "./HealthCenter";
import { useTheme } from "../app/providers";
import { formatDateTimesInText } from "../core/format";
import { useEnergyStatus } from "../hooks/useEnergyStatus";
import { useTranslation } from "react-i18next";

const navigation = [
  { to: "/", label: "Overview", short: "Home", glyph: "⌂" },
  { to: "/reports", label: "Reports", short: "Reports", glyph: "↗" },
  { to: "/battery", label: "Battery", short: "Battery", glyph: "▰" },
  { to: "/automation", label: "Automation", short: "Auto", glyph: "◇" },
  { to: "/system", label: "System", short: "Settings", glyph: "⚙" },
];
const mobileNavigation = [
  { to: "/", label: "Overview", short: "Home", glyph: "⌂" },
  { to: "/reports", label: "Reports", short: "Reports", glyph: "↗" },
  { to: "/battery", label: "Battery", short: "Battery", glyph: "▰" },
  { to: "/automation", label: "Automation", short: "Auto", glyph: "◇" },
  { to: "/system", label: "System", short: "Settings", glyph: "⚙" },
];

function ThemeControl({ mobile = false }: { mobile?: boolean }) {
  const { preference, setPreference } = useTheme();
  const { t } = useTranslation("common");
  return (
    <label className={`theme-control${mobile ? " mobile-theme-control" : ""}`}>
      <span>{t(mobile ? "Mobile appearance" : "Appearance")}</span>
      <select aria-label={t(mobile ? "Mobile appearance" : "Appearance")} value={preference} onChange={(event) => setPreference(event.target.value as typeof preference)}>
        <option value="system">{t("system")}</option>
        <option value="light">{t("light")}</option>
        <option value="dark">{t("dark")}</option>
      </select>
    </label>
  );
}

function Navigation({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation("common");
  return (
    <nav className={mobile ? "mobile-navigation" : "primary-navigation"} aria-label={t("primary")}>
      {(mobile ? mobileNavigation : navigation).map(({ to, label, short, glyph }) => {
        return <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive ? "active" : undefined}>
          <span className="nav-glyph" aria-hidden="true">{glyph}</span>
          <span>{t(mobile ? short : label)}</span>
        </NavLink>;
      })}
    </nav>
  );
}

export function AppShell() {
  const { config, status } = useEnergyStatus();
  const { t } = useTranslation("common");
  const simulated = config?.runtime?.simulatedDevices === true;
  const strategy = status?.batteryStrategy;
  const showOperationalBanner = strategy?.kind === "backup-preparation" || strategy?.manualOverride?.active;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t("skipToMainContent")}</a>
      {simulated ? (
        <div className="simulation-banner" role="status">
          {" " + t("simulatedEnvironmentNoProductionDevicesExternalIODisable5d5280") + " "}</div>
      ) : null}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">↯</span>
          <span>{t("homeEnergy")}</span>
        </div>
        <Navigation />
        <div className="sidebar-footer">
          <HealthCenter />
          <ThemeControl />
        </div>
      </aside>
      <div className="application">
        <header className="mobile-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">↯</span>
            <span>{t("homeEnergy")}</span>
          </div>
          <HealthCenter />
          <ThemeControl mobile />
        </header>
        {showOperationalBanner ? (
          <div className="operational-banner" role="status">
            <strong>{t(strategy.title)}</strong>
            <span>{formatDateTimesInText(t(strategy.description))}</span>
            <Link to={strategy.kind === "backup-preparation" ? "/battery/backup" : "/battery"}>{t("reviewBattery")}</Link>
          </div>
        ) : null}
        {status?.statusRefreshPaused ? (
          <div className="operational-banner" data-severity="warning" role="status">
            <strong>{t("liveReadingsPaused")}</strong>
            <span>{t("theLatestValuesRemainVisibleWhileValue", { value: status.statusRefreshPausedReason ?? "equipment discovery is running" })}</span>
            <Link to="/system/equipment">{t("reviewEquipment")}</Link>
          </div>
        ) : null}
        <div id="main-content" tabIndex={-1}><Outlet /></div>
      </div>
      <Navigation mobile />
    </div>
  );
}
