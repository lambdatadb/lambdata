import { RotateCw } from "lucide-react";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { errorMessage } from "../../lib/api";
import { isForbidden } from "../../lib/queries";

export interface QueryErrorProps {
  error: unknown;
  title?: string;
  onRetry?: () => unknown;
  retrying?: boolean;
  className?: string;
}

export function QueryError({ error, title = "Could not load this", onRetry, retrying, className }: QueryErrorProps) {
  const forbidden = isForbidden(error);
  return (
    <Alert
      variant={forbidden ? "neutral" : "danger"}
      title={forbidden ? "You do not have access to this" : title}
      className={className}
      action={
        onRetry && !forbidden ? (
          <Button size="xs" variant="secondary" loading={retrying} onClick={() => void onRetry()}>
            <RotateCw /> Retry
          </Button>
        ) : undefined
      }
    >
      {forbidden ? "Ask an administrator if you need it." : errorMessage(error)}
    </Alert>
  );
}
