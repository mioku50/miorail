import { Component, type ErrorInfo, type ReactNode } from 'react';

// T48a.2: top-level safety net. Since T48a the app shell renders before auth,
// so many more components (and third-party wallet providers) mount eagerly.
// A single render/effect throw with no boundary blanks the whole page. This
// boundary turns any such crash into a readable, recoverable screen instead
// of a black page, and logs the error so it is diagnosable.

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Miorail app crashed:', error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ error: null });
    if (typeof window !== 'undefined') window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-bg text-ink">
        <section className="w-full max-w-md border border-line bg-panel p-6 text-center rounded-xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-warn">Something went wrong</p>
          <h2 className="mt-2 text-lg font-semibold">Miorail hit an unexpected error</h2>
          <p className="mt-2 text-sm text-muted">
            The page failed to render. This is usually a temporary wallet-extension or
            connection conflict. Reloading almost always fixes it.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-4 w-full bg-accent px-4 py-3 text-sm font-semibold text-bg rounded-lg"
          >
            Reload Miorail
          </button>
          <p className="mt-3 font-mono text-[10px] text-ink-3 break-words">
            {this.state.error.message}
          </p>
        </section>
      </div>
    );
  }
}
