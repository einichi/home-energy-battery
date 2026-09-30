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
