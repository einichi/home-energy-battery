import type { AppConfig } from "../../../api/contracts";

export type Result = { ok: boolean; message: string } | null;
export type SaveSettings = (patch: Partial<AppConfig>, message: string) => Promise<Result>;
