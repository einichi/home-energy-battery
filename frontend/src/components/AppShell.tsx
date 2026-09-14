import { NavLink, Outlet } from "react-router-dom";
import { HealthCenter } from "./HealthCenter";
import { useTheme } from "../app/providers";
import { useEnergyStatus } from "../hooks/useEnergyStatus";
import { T, useI18n } from "../i18n";

const navigation = [
  { to: "/", label: "Overview", short: "Home", glyph: "⌂" },
  { to: "/energy", label: "Energy", short: "Energy", glyph: "⌁" },
  { to: "/battery", label: "Battery", short: "Battery", glyph: "▰" },
  { to: "/automation", label: "Automation", short: "Auto", glyph: "◇" },
  { to: "/insights", label: "Insights", short: "Insights", glyph: "↗" },
  { to: "/system", label: "System", short: "More", glyph: "⚙" },
];

function ThemeControl({ mobile = false }: { mobile?: boolean }) {
  const { preference, setPreference } = useTheme();
  const { text } = useI18n();
  return (
    <label className={`theme-control${mobile ? " mobile-theme-control" : ""}`}>
      <span>{text(mobile ? "Mobile appearance" : "Appearance")}</span>
      <select aria-label={text(mobile ? "Mobile appearance" : "Appearance")} value={preference} onChange={(event) => setPreference(event.target.value as typeof preference)}>
        <option value="system"><T text={"System"} /></option>
        <option value="light"><T text={"Light"} /></option>
        <option value="dark"><T text={"Dark"} /></option>
      </select>
    </label>
  );
}

function Navigation({ mobile = false }: { mobile?: boolean }) {
  const { text } = useI18n();
  return (
    <nav className={mobile ? "mobile-navigation" : "primary-navigation"} aria-label={text("Primary")}>
      {navigation.map(({ to, label, short, glyph }) => (
        <NavLink key={to} to={to} end={to === "/"}>
          <span className="nav-glyph" aria-hidden="true">{glyph}</span>
          <span>{text(mobile ? short : label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { config, status } = useEnergyStatus();
  const { text } = useI18n();
  const simulated = config?.runtime?.simulatedDevices === true;
  const strategy = status?.batteryStrategy;
  const showOperationalBanner = strategy?.kind === "backup-preparation" || strategy?.manualOverride?.active;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content"><T text={"Skip to main content"} /></a>
      {simulated ? (
        <div className="simulation-banner" role="status">
          <T text={" Simulated environment · No production devices · External I/O disabled "} /></div>
      ) : null}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">↯</span>
          <span><T text={"Home Energy"} /></span>
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
            <span><T text={"Home Energy"} /></span>
          </div>
          <HealthCenter />
          <ThemeControl mobile />
        </header>
        {showOperationalBanner ? (
          <div className="operational-banner" role="status">
            <strong>{text(strategy.title)}</strong>
            <span>{text(strategy.description)}</span>
            <a href={strategy.kind === "backup-preparation" ? "/ui/battery/backup" : "/ui/battery"}><T text={"Review battery →"} /></a>
          </div>
        ) : null}
        <div id="main-content" tabIndex={-1}><Outlet /></div>
      </div>
      <Navigation mobile />
    </div>
  );
}
