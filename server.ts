#!/usr/bin/env node
import { createApplication } from "./lib/create-application.js";

const application = createApplication();
await application.start();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await application.stop();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

// A partially compliant device can make the vendored ECHONET library throw from
// inside its UDP callback (e.g. a Get_SNA property-map response), which cannot be
// caught at the call site. Log and keep serving rather than crashing.
process.on("uncaughtException", (error) => {
  console.error("uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
});
