import { useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig, DatabaseBackupsView } from "../../../api/contracts";
import { createDatabaseBackup, deleteDatabaseBackup, restoreDatabaseBackup, trimHistory } from "../../../api/system";
import type { useSystemAdmin } from "../../../hooks/useSystemAdmin";
import { useTranslation } from "react-i18next";
import type { Result, SaveSettings } from "./types.js";
import { ResultMessage } from "./ResultMessage.js";
import { optionalNumber, positiveNumberOr, bytes, duration } from "./form-utils.js";

export function DataSettings({
  config,
  admin,
  save,
}: {
  config: AppConfig;
  admin: ReturnType<typeof useSystemAdmin>;
  save: SaveSettings;
}) {
  const { t } = useTranslation("system");
  const [result, setResult] = useState<Result>(null);
  const [retentionResult, setRetentionResult] = useState<Result>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    detail: string;
    action: () => Promise<void>;
  } | null>(null);
  const retention = config.retention ?? {};
  const operation = admin.backups?.operation;
  const act = async (
    action: () => Promise<DatabaseBackupsView>,
    message: string,
  ) => {
    admin.setBackups((current) => ({
      backups: current?.backups ?? [],
      schemaVersion: current?.schemaVersion,
      operation: { busy: true, phase: "preparing", percent: 0, error: null },
    }));
    try {
      admin.setBackups(await action());
      admin.refresh();
      setResult({ ok: true, message });
    } catch (error) {
      admin.refresh();
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : "Operation failed",
      });
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = {
      rawTelemetryDays: positiveNumberOr(data.get("raw"), retention.rawTelemetryDays),
      intervalAggregatesDays: optionalNumber(data.get("interval")),
      dailyAggregatesDays: optionalNumber(data.get("daily")),
      adaptiveChargingHistoryDays: optionalNumber(data.get("adaptive")),
      automationEventDays: optionalNumber(data.get("automation")),
      commandReceiptDays: optionalNumber(data.get("commands")),
      notificationDeliveryDays: positiveNumberOr(data.get("notifications"), retention.notificationDeliveryDays),
      automaticMaintenance: data.has("automatic"),
    };
    const intent = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "data-intent",
    );
    if (intent === "trim") {
      setConfirm({
        title: "Run retention maintenance now?",
        detail:
          "Records older than the values shown in this form will be removed. Existing backups are not affected.",
        action: async () => {
          try {
            const response = (await trimHistory(next)) as unknown as {
              deleted?: Record<string, number>;
            };
            const deleted = Object.values(response.deleted ?? {}).reduce(
              (sum, value) => sum + Number(value || 0),
              0,
            );
            admin.refresh();
            setRetentionResult({
              ok: true,
              message: `Retention maintenance completed. ${deleted} records removed.`,
            });
          } catch (error) {
            setRetentionResult({
              ok: false,
              message:
                error instanceof Error ? error.message : "Maintenance failed",
            });
          }
        },
      });
    } else
      setRetentionResult(
        await save({ retention: next }, "Retention policy saved."),
      );
  };
  return (
    <div className="system-stack">
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              {t("storageHealth")}
            </h2>
          </div>
          <button className="quiet-button" onClick={admin.refresh}>
            {t("refresh")}
          </button>
        </div>
        <dl className="system-stat-grid">
          <div>
            <dt>
              {t("databaseSize")}
            </dt>
            <dd>{bytes(admin.stats?.sizeBytes)}</dd>
          </div>
          <div>
            <dt>
              {t("recordedHistory")}
            </dt>
            <dd>{duration(admin.stats?.daysRecorded)}</dd>
          </div>
          <div>
            <dt>
              {t("rawSamples")}
            </dt>
            <dd>
              {admin.stats?.sampleCount?.toLocaleString() ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              {t("30MinuteAggregates")}
            </dt>
            <dd>
              {admin.stats?.rollups?.interval?.toLocaleString() ??
                "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              {t("dailyAggregates")}
            </dt>
            <dd>
              {admin.stats?.rollups?.daily?.toLocaleString() ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>
              {t("schema")}
            </dt>
            <dd>
              {admin.stats?.schemaVersion
                ? `v${admin.stats.schemaVersion}`
                : "Unavailable"}
            </dd>
          </div>
        </dl>
      </section>
      <form
        className="panel system-form"
        key={JSON.stringify(retention)}
        onSubmit={submit}
      >
        <div className="section-heading">
          <div>
            <h2>
              {t("retention")}
            </h2>
            <p>
              {t("blankAggregateFieldsMeanKeepIndefinitely")}
            </p>
          </div>
        </div>
        <div className="automation-form-grid">
          <label className="field">
            {t("rawTelemetryDays")}
            <input
              name="raw"
              type="number"
              min="1"
              defaultValue={retention.rawTelemetryDays ?? ""}
            />
          </label>
          <label className="field">
            {t("30MinuteAggregateDays")}
            <input
              name="interval"
              type="number"
              min="1"
              defaultValue={retention.intervalAggregatesDays ?? ""}
            />
          </label>
          <label className="field">
            {t("dailyAggregateDays")}
            <input
              name="daily"
              type="number"
              min="1"
              defaultValue={retention.dailyAggregatesDays ?? ""}
            />
          </label>
          <label className="field">
            {t("adaptiveHistoryDays")}
            <input
              name="adaptive"
              type="number"
              min="1"
              defaultValue={retention.adaptiveChargingHistoryDays ?? ""}
            />
          </label>
          <label className="field">
            {t("automationEventDays")}
            <input
              name="automation"
              type="number"
              min="1"
              defaultValue={retention.automationEventDays ?? ""}
            />
          </label>
          <label className="field">
            {t("commandReceiptDays")}
            <input
              name="commands"
              type="number"
              min="1"
              defaultValue={retention.commandReceiptDays ?? ""}
            />
          </label>
          <label className="field">
            {t("notificationDeliveryDays")}
            <input
              name="notifications"
              type="number"
              min="1"
              defaultValue={retention.notificationDeliveryDays ?? ""}
            />
          </label>
        </div>
        <label className="automation-toggle compact">
          <input
            name="automatic"
            type="checkbox"
            defaultChecked={retention.automaticMaintenance !== false}
          />
          <span>
            <strong>
              {t("runMaintenanceAutomatically")}
            </strong>
          </span>
        </label>
        <div className="form-footer">
          <button className="button primary">
            {t("saveRetention")}
          </button>
          <button className="quiet-button" data-intent="trim">
            {t("runMaintenanceNow")}
          </button>
          <ResultMessage result={retentionResult} />
        </div>
      </form>
      <section className="panel system-form">
        <div className="section-heading">
          <div>
            <h2>
              {t("databaseBackups")}
            </h2>
            <p>
              {t("createRecoverableSnapshotsBeforeMaterialConfigurationOrSe1c55b")}
            </p>
          </div>
          <button
            className="button primary"
            disabled={operation?.busy}
            onClick={() =>
              void act(
                createDatabaseBackup,
                "Backup created and inventory refreshed.",
              )
            }
          >
            {t("createBackup")}
          </button>
        </div>
        {operation?.busy || operation?.phase === "failed" ? (
          <div
            className="database-operation"
            role={operation.phase === "failed" ? "alert" : "status"}
          >
            <div>
              <strong>{operation.phase ?? "Working"}</strong>
              <span>
                {operation.error ??
                  `${Math.round(operation.percent ?? 0)}% complete`}
              </span>
            </div>
            <progress max="100" value={operation.percent ?? 0} />
          </div>
        ) : null}
        <div className="backup-list">
          {admin.backups?.backups.length ? (
            admin.backups.backups.map((backup) => (
              <article key={backup.filename}>
                <div>
                  <strong>{backup.filename}</strong>
                  <small>
                    {t("{size} {schemaLabel}{version} · {compatibility}", {
                      size: bytes(backup.sizeBytes),
                      schemaLabel: t("schemaV"),
                      version: backup.schemaVersion ?? "?",
                      compatibility: t(backup.compatible ? "compatible" : "not restorable by this version"),
                    })}
                  </small>
                </div>
                <div className="button-row">
                  <button
                    className="quiet-button"
                    disabled={operation?.busy || !backup.compatible}
                    onClick={() =>
                      setConfirm({
                        title: "Restore this database backup?",
                        detail:
                          "The application will pause background work, create a safety backup, replace the active database, validate it, restart local services, and refresh this inventory.",
                        action: () =>
                          act(
                            () => restoreDatabaseBackup(backup.filename),
                            "Backup restored and database state refreshed.",
                          ),
                      })
                    }
                  >
                    {t("restore")}
                  </button>
                  <button
                    className="danger-button"
                    disabled={operation?.busy}
                    onClick={() =>
                      setConfirm({
                        title: "Delete this backup?",
                        detail:
                          "This removes only the selected backup file and cannot be undone.",
                        action: () =>
                          act(
                            () => deleteDatabaseBackup(backup.filename),
                            "Backup deleted and inventory refreshed.",
                          ),
                      })
                    }
                  >
                    {t("delete")}
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p>
              {t("noDatabaseBackupsAreAvailable")}
            </p>
          )}
        </div>
        <ResultMessage result={result} />
      </section>
      {confirm ? (
        <div className="modal-backdrop">
          <section
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="data-confirm-title"
          >
            <h2 id="data-confirm-title">{confirm.title}</h2>
            <p>{confirm.detail}</p>
            <div className="button-row">
              <button className="quiet-button" onClick={() => setConfirm(null)}>
                {t("cancel")}
              </button>
              <button
                className="button primary"
                onClick={() => {
                  const action = confirm.action;
                  setConfirm(null);
                  void action();
                }}
              >
                {t("continue")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
