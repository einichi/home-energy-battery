#!/usr/bin/env node
import { main, shutdown } from "./lib/application.js";

await main();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await shutdown();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
