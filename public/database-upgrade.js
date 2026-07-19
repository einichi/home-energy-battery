const $ = (selector) => document.querySelector(selector);
const phases = {
  "awaiting-decision": "Awaiting your decision",
  preparing: "Preparing backup",
  copying: "Copying database",
  validating: "Validating snapshot",
  compressing: "Compressing with Zstandard",
  migrating: "Applying database migration",
  starting: "Starting application",
  complete: "Upgrade complete",
  failed: "Upgrade failed",
  newer: "Database version is not supported",
  invalid: "Database could not be inspected",
};
function bytes(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let number = Number(value); let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return `${number.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function render(status) {
  $("#sourceVersion").textContent = status.sourceVersion == null ? "New" : `Version ${status.sourceVersion}`;
  $("#targetVersion").textContent = `Version ${status.targetVersion}`;
  $("#databaseSize").textContent = bytes(status.databaseBytes);
  $("#backupDirectory").textContent = status.backupDirectory ?? "--";
  const waiting = status.state === "awaiting-decision";
  const failed = ["failed", "newer", "invalid"].includes(status.state);
  $("#decisionContent").hidden = !waiting;
  $("#progressContent").hidden = waiting || failed;
  $("#errorContent").hidden = !failed;
  $("#retryButton").hidden = !status.required || ["newer", "invalid"].includes(status.state);
  $("#skipAfterFailureButton").hidden = !status.required || ["newer", "invalid"].includes(status.state);
  if (failed) $("#errorMessage").textContent = status.error ?? "Unknown database error";
  if (!waiting && !failed) {
    const percent = Math.max(0, Math.min(100, Number(status.percent ?? 0)));
    $("#phaseLabel").textContent = phases[status.phase] ?? status.phase;
    $("#progressBar").style.width = `${percent}%`;
    $("#progressPercent").textContent = `${percent}%`;
    $("#progressCounts").textContent = status.unit === "bytes"
      ? `${bytes(status.processed)} / ${bytes(status.total)}`
      : status.total ? `${Number(status.processed).toLocaleString()} / ${Number(status.total).toLocaleString()} ${status.unit ?? ""}` : "";
    $("#progressDetail").textContent = status.backup?.filename ? `Backup: ${status.backup.filename}` : "";
  }
  if (status.applicationReady || status.state === "complete") window.location.replace("/");
}
async function decide(backup) {
  $("#backupButton").disabled = true; $("#skipButton").disabled = true;
  const response = await fetch("/api/database-upgrade/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ backup }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  render(body);
}
$("#backupButton").addEventListener("click", () => decide(true).catch((error) => alert(error.message)));
$("#skipButton").addEventListener("click", () => decide(false).catch((error) => alert(error.message)));
$("#retryButton").addEventListener("click", () => decide(true).catch((error) => alert(error.message)));
$("#skipAfterFailureButton").addEventListener("click", () => decide(false).catch((error) => alert(error.message)));
async function poll() {
  try { const response = await fetch("/api/database-upgrade/status", { cache: "no-store" }); render(await response.json()); }
  catch (error) { $("#errorMessage").textContent = error.message; }
  setTimeout(poll, 500);
}
poll();
