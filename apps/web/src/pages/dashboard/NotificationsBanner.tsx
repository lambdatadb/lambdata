import { Link } from "react-router-dom";
import type { NotificationDestination } from "@lambdata/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { useDestinations } from "../../components/notifications/model";
import { formatRelativeTime } from "../../lib/format";
import { useIsAdmin } from "../../lib/auth";

export function failingDestinations(destinations: NotificationDestination[] | undefined): NotificationDestination[] {
  return (destinations ?? []).filter((d) => d.enabled && d.health === "failing");
}

export function NotificationsFailingAlert({ failing }: { failing: NotificationDestination[] }) {
  if (failing.length === 0) return null;
  const first = failing[0]!;
  return (
    <Alert
      variant="warning"
      title={failing.length === 1 ? `Notifications to ${first.name} are failing` : `${failing.length} notification destinations are failing`}
      data-notifications-failing={failing.length}
      action={
        <Button asChild size="xs" variant="secondary">
          <Link to="/notifications">Review</Link>
        </Button>
      }
    >
      {failing.length === 1 ? (
        <span className="break-words">
          <span className="font-mono text-code">{first.lastError ?? "Delivery failed"}</span>
          {first.lastFailureAt ? ` · ${formatRelativeTime(first.lastFailureAt)}` : ""}
        </span>
      ) : (
        failing.map((d) => d.name).join(", ")
      )}
    </Alert>
  );
}

export function NotificationsBanner() {
  const isAdmin = useIsAdmin();
  const query = useDestinations({ enabled: isAdmin, poll: 60_000 });
  if (!isAdmin) return null;
  return <NotificationsFailingAlert failing={failingDestinations(query.data)} />;
}
