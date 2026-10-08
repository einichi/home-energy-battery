import { useRef, useState } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { updateConfig } from "../../api/queries";
import { useEnergyStatus } from "../../hooks/useEnergyStatus";
import { useSystemAdmin } from "../../hooks/useSystemAdmin";
import { formatDateTimesInText } from "../../core/format";
import { useTranslation } from "react-i18next";
import type { SaveSettings } from "./sections/types.js";
import { EquipmentSettings } from "./sections/EquipmentSettings.js";
import { RateSettings } from "./sections/RateSettings.js";
import { NotificationSettings } from "./sections/NotificationSettings.js";
import { DataSettings } from "./sections/DataSettings.js";
import { Preferences } from "./sections/Preferences.js";

const sections = [
  {
    id: "equipment",
    label: "Equipment",
    description: "Installed devices and addresses",
  },
  {
    id: "rates",
    label: "Rates & emissions",
    description: "Electricity and Ene-Farm assumptions",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Email delivery and event triggers",
  },
  {
    id: "data",
    label: "Data & backups",
    description: "Retention, storage, and recovery",
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "Refresh and dashboard visibility",
  },
] as const;

type SectionId = (typeof sections)[number]["id"];

export function SystemPage() {
  const { t } = useTranslation("system");
  const { section } = useParams();
  const selected = sections.some((item) => item.id === section)
    ? (section as SectionId)
    : null;
  const { config, status, replaceConfig } = useEnergyStatus();
  const admin = useSystemAdmin();
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  if (!selected) return <Navigate to="/system/equipment" replace />;
  const save: SaveSettings = async (patch, message) => {
    if (!config)
      return { ok: false, message: "Configuration is not available." };
    // Prevent overlapping full-config saves from clobbering each other.
    if (savingRef.current) return { ok: false, message: "A save is already in progress." };
    savingRef.current = true;
    setBusy(true);
    try {
      const next = await updateConfig({ ...config, ...patch });
      replaceConfig({ ...next, runtime: next.runtime ?? config.runtime });
      return { ok: true, message };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Save failed",
      };
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="page system-page" aria-busy={busy}>
      <header className="page-heading">
        <div>
          <p className="eyebrow">
            {t("administer")}
          </p>
          <h1>
            {t("system")}
          </h1>
        </div>
      </header>
      {admin.error ? (
        <div className="status-banner" data-severity="critical">
          {"" + t("systemData") + " "}
          {formatDateTimesInText(admin.error)}
        </div>
      ) : null}
      <nav className="system-navigation" aria-label={t("systemSections")}>
        {sections.map((item) => (
          <NavLink key={item.id} to={`/system/${item.id}`}>
            <strong>{t(item.label)}</strong>
            <span>{t(item.description)}</span>
          </NavLink>
        ))}
      </nav>
      {!config ? (
        <div className="panel automation-empty">
          {t("loadingSystemConfiguration")}
        </div>
      ) : selected === "equipment" ? (
        <EquipmentSettings config={config} status={status} save={save} />
      ) : selected === "rates" ? (
        <RateSettings config={config} save={save} />
      ) : selected === "notifications" && admin.notifications ? (
        <NotificationSettings
          initial={admin.notifications}
          setView={(view) => admin.setNotifications(view)}
          simulator={config.runtime?.externalIoDisabled === true}
        />
      ) : selected === "data" ? (
        <DataSettings config={config} admin={admin} save={save} />
      ) : selected === "preferences" ? (
        <Preferences config={config} save={save} />
      ) : (
        <div className="panel automation-empty">
          {t("loadingSection")}
        </div>
      )}
    </main>
  );
}
