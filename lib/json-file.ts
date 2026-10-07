import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Read a JSON file, returning `fallback` when the file does not exist. */
export async function readJsonFile(file: string, fallback: unknown): Promise<unknown> {
  try {
    const text = await readFile(file, "utf8");
    try {
      return JSON.parse(text);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed to parse JSON from ${file}: ${message}`, { cause });
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

/** Write a JSON file atomically, optionally forcing a permission mode. */
export async function writeJsonFileAtomic(file: string, value: unknown, mode: number | null = null): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  await rename(temporary, file);
  if (mode) await chmod(file, mode);
}
