import { Component, type ReactNode } from "react";

/** Something that failed while drawing: one plain line and Reload, not a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="unreachable">
        Something went wrong.
        <button type="button" className="btn sm" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
