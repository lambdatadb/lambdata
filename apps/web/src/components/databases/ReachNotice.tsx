import { Link } from "react-router-dom";
import { Laptop, PlugZap } from "lucide-react";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { DATABASE_SWITCH_PATH, type DatabaseReach } from "../../lib/connections";

export const NOT_YET_TITLE = "Database clients on other machines cannot connect yet";
export const THIS_MACHINE_TEXT = "Reachable from this machine only.";

export function ReachNotice({
  reach,
  isAdmin,
  className,
  compact = false,
}: {
  reach: DatabaseReach;
  isAdmin: boolean;
  className?: string;
  compact?: boolean;
}) {
  if (reach === "outside") return null;
  const where = isAdmin ? (
    <>
      turn on <span className="font-medium text-text">Allow database clients on other machines</span> on the{" "}
      <Link to={DATABASE_SWITCH_PATH} className="text-text underline underline-offset-4 hover:decoration-accent">
        Network page
      </Link>
    </>
  ) : (
    <>
      ask an admin to turn on <span className="font-medium text-text">Allow database clients on other machines</span> on the
      Network page
    </>
  );
  const action = isAdmin ? (
    <Button size="xs" variant="secondary" asChild>
      <Link to={DATABASE_SWITCH_PATH}>Open the switch</Link>
    </Button>
  ) : undefined;
  if (reach === "this-machine") {
    return (
      <p className={cn("flex items-start gap-1.5 text-label text-text-muted", className)} data-reach="this-machine">
        <Laptop aria-hidden className="mt-px size-3.5 shrink-0 text-text-subtle" />
        <span>
          {THIS_MACHINE_TEXT} MariaDB listens on 127.0.0.1, so only clients running on the LambData server itself can connect.
          To connect from other machines, {where}.
        </span>
      </p>
    );
  }
  return (
    <Alert
      variant="warning"
      icon={<PlugZap aria-hidden />}
      title={NOT_YET_TITLE}
      action={action}
      className={className}
      data-reach="not-yet"
    >
      {compact ? (
        <>MariaDB only accepts connections from inside the LambData container right now. To connect from other machines, {where}.</>
      ) : (
        <>
          MariaDB only accepts connections from inside the LambData container right now, so a host and port here would not work
          from another computer. The user, password and schema below are still valid. To connect from other machines, {where}.
        </>
      )}
    </Alert>
  );
}
