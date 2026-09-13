import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

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
          <p className="eyebrow">Interface error</p>
          <h1>This view could not be displayed</h1>
          <p>{this.state.error.message}</p>
          <a className="button" href="/">Open the current interface</a>
        </main>
      );
    }
    return this.props.children;
  }
}
