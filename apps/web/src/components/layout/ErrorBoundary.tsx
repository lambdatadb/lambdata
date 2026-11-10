import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

interface Props {
  children: ReactNode;
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey?: string;
}

function isChunkError(error: Error): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    error.message,
  );
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ui]", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    return (
      <EmptyState
        icon={TriangleAlert}
        title={chunk ? "A newer version of the console is available" : "This page failed to render"}
        description={
          chunk ? "Reload to pick up the update." : <span className="font-mono text-code text-text-muted">{error.message}</span>
        }
        action={
          <Button variant="secondary" onClick={() => window.location.reload()}>
            <RotateCw /> Reload
          </Button>
        }
      />
    );
  }
}
