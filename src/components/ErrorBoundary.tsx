import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[RoofIQ] Uncaught render error:', error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-white p-8">
          <div className="max-w-lg w-full bg-slate-900 border border-red-500/40 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center text-red-400 text-lg font-bold shrink-0">!</div>
              <div>
                <h2 className="font-semibold text-white">Something went wrong</h2>
                <p className="text-xs text-slate-400">A render error occurred. Check the console for details.</p>
              </div>
            </div>
            {this.state.message && (
              <pre className="bg-slate-800 rounded-lg p-3 text-xs text-red-300 overflow-x-auto whitespace-pre-wrap break-all">
                {this.state.message}
              </pre>
            )}
            <button
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
