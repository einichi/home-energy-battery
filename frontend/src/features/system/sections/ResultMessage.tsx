import { useTranslation } from "react-i18next";
import { formatDateTimesInText } from "../../../core/format";
import type { Result } from "./types";

export function ResultMessage({ result }: { result: Result }) {
  const { t } = useTranslation("system");
  return result ? (
    <p className={`inline-save-result ${result.ok ? "success" : "failure"}`} role={result.ok ? "status" : "alert"}>
      {formatDateTimesInText(t(result.message))}
    </p>
  ) : null;
}
