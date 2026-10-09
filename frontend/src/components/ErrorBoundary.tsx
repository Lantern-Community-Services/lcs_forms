"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@/lib/telemetry";

/**
 * Catches a render error so one broken screen doesn't take the app with it.
 *
 * Without this, a single throw anywhere in the ~40 screens left a white page
 * with no way back — no message, no navigation, nothing to report. React has no
 * hook equivalent, so this stays a class component.
 */

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary — used to recover on navigation. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Moving to another screen clears the error, so a person isn't stuck on the
    // failure page after navigating away from the screen that caused it.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ui] a screen failed to render:", error, info.componentStack);
    reportClientError(error, { componentStack: info.componentStack?.slice(0, 2000) ?? null, screenFailed: true });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-[60vh] place-items-center px-6 py-12">
        <div className="max-w-md text-center">
          <h1 className="font-heading text-[20px] font-extrabold text-ink">This screen didn&apos;t load</h1>
          <p className="mt-2 text-[13.5px] text-muted">
            Something went wrong displaying this page. Nothing you were looking at has been changed.
          </p>
          {/* The message is shown rather than hidden: it is the only thing the
              person can pass on when reporting it. */}
          <p className="mt-3 break-words rounded-input bg-subtle px-3 py-2 text-left font-mono text-[11.5px] text-muted">
            {error.message || String(error)}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="h-9 rounded-input bg-navy px-4 text-[13.5px] font-semibold text-white hover:bg-navy-600"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.assign("/")}
              className="h-9 rounded-input border border-hairline bg-surface px-4 text-[13.5px] font-semibold text-ink hover:bg-rowhover"
            >
              Back to start
            </button>
          </div>
        </div>
      </div>
    );
  }
}
