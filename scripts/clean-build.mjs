import { rm } from "node:fs/promises";

const allowedTargets = new Set(["dist", ".test-dist"]);
const target = process.argv[2];
if (!target || !allowedTargets.has(target)) {
  throw new Error(`Expected one build target: ${[...allowedTargets].join(", ")}`);
}

await rm(new URL(`../${target}/`, import.meta.url), { recursive: true, force: true });
