import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatDateTimesInText } from "../core/format";
import i18n from "../i18n/instance";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("React UI failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-state">
          <p className="eyebrow">{i18n.t("Interface error", { ns: "common" })}</p>
          <h1>{i18n.t("This view could not be displayed", { ns: "common" })}</h1>
          <p>{formatDateTimesInText(this.state.error.message)}</p>
          <Link className="button" to="/">{i18n.t("Return to Overview", { ns: "common" })}</Link>
        </main>
      );
    }
    return this.props.children;
  }
}
