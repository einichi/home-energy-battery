import { getJson, sendJson } from "./client";
import type { AwayReserveStatus } from "./contracts";

export const getAwayReserve = (signal?: AbortSignal) => getJson<AwayReserveStatus>("/api/away-reserve", signal);
export const setAwayReserve = (enabled: boolean) => sendJson<AwayReserveStatus>("/api/away-reserve", "PATCH", { enabled });
