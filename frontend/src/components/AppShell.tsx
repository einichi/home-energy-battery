import { NavLink, Outlet } from "react-router-dom";
import { HealthCenter } from "./HealthCenter";
import { useTheme } from "../app/providers";
import { useEnergyStatus } from "../hooks/useEnergyStatus";

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
  return (
    <label className={`theme-control${mobile ? " mobile-theme-control" : ""}`}>
      <span>{mobile ? "Mobile appearance" : "Appearance"}</span>
      <select aria-label={mobile ? "Mobile appearance" : "Appearance"} value={preference} onChange={(event) => setPreference(event.target.value as typeof preference)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function Navigation({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={mobile ? "mobile-navigation" : "primary-navigation"} aria-label="Primary">
      {navigation.map(({ to, label, short, glyph }) => (
        <NavLink key={to} to={to} end={to === "/"}>
          <span className="nav-glyph" aria-hidden="true">{glyph}</span>
          <span>{mobile ? short : label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { config, status } = useEnergyStatus();
  const simulated = config?.runtime?.simulatedDevices === true;
  const strategy = status?.batteryStrategy;
  const showOperationalBanner = strategy?.kind === "backup-preparation" || strategy?.manualOverride?.active;
  return (
    <div className="app-shell">
      {simulated ? (
        <div className="simulation-banner" role="status">
          Simulated environment · No production devices · External I/O disabled
        </div>
      ) : null}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">↯</span>
          <span>Home Energy</span>
        </div>
        <Navigation />
        <div className="sidebar-footer">
          <HealthCenter />
          <ThemeControl />
          <a className="legacy-link" href="/">Current interface <span aria-hidden="true">↗</span></a>
        </div>
      </aside>
      <div className="application">
        <header className="mobile-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">↯</span>
            <span>Home Energy</span>
          </div>
          <HealthCenter />
          <ThemeControl mobile />
        </header>
        {showOperationalBanner ? (
          <div className="operational-banner" role="status">
            <strong>{strategy.title}</strong>
            <span>{strategy.description}</span>
            <a href={strategy.kind === "backup-preparation" ? "/ui/battery/backup" : "/ui/battery"}>Review battery →</a>
          </div>
        ) : null}
        <Outlet />
      </div>
      <Navigation mobile />
    </div>
  );
}
