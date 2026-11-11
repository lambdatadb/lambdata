import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { DatabasePortStatus, NetworkStatus, RejectedConnection } from "@lambdata/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  DescriptionItem,
  DescriptionList,
  Switch,
  toast,
} from "../ui";
import { RejectionRow } from "../databases/RejectedConnections";
import { formatDate } from "../../lib/format";
import { isUnknownAccount, useClearRejections, useDatabasePortSwitch, useNetworkRejections } from "../../lib/connections";
import { Code, Refusal } from "./parts";

const UNKNOWN_LIMIT = 10;

export function databasePortSummary(port: DatabasePortStatus): string {
  if (port.outsideConnections) return "Database clients on other machines can connect.";
  if (port.inContainer) return "Only LambData itself can connect. Database clients on other machines cannot connect yet.";
  return "Only clients on this machine can connect.";
}

export function SwitchConsequences({ port, turningOn }: { port: DatabasePortStatus; turningOn: boolean }) {
  return (
    <div className="space-y-3" data-switch-consequences>
      <p>
        {turningOn
          ? "MariaDB restarts and listens on every network address of this server."
          : "MariaDB restarts and listens on 127.0.0.1 only, so clients on other machines are disconnected and cannot sign in again."}{" "}
        Open database connections drop for a moment while it restarts, and anything running against a database should retry.
      </p>
      {turningOn && port.inContainer && (
        <p>
          In Docker the port must be published too: <Code>{`-p ${port.port}:${port.port}`}</Code>, or the “MariaDB Port” field
          of the Unraid template. LambData cannot see or change that.
        </p>
      )}
      {turningOn && (
        <p>
          Each database's “connections from” setting decides which addresses may sign in to it. A rule on your router limits who
          can try at all.
        </p>
      )}
    </div>
  );
}

export function DatabaseConnectionsCard({ status, isAdmin }: { status: NetworkStatus; isAdmin: boolean }) {
  const port = status.databasePort;
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const change = useDatabasePortSwitch();

  if (!port) {
    return (
      <Card>
        <DescriptionList>
          <DescriptionItem term="MariaDB listens on" mono>
            {status.bind.mariadbBind}:{status.bind.mariadbPort}
          </DescriptionItem>
        </DescriptionList>
      </Card>
    );
  }

  const editable = isAdmin && !port.lockedByEnv;

  return (
    <Card flush>
      {port.lockedByEnv && (
        <Alert variant="neutral" title="Set by the container's variable" className="rounded-none border-x-0 border-t-0">
          <Code>LAMBDATA_MARIADB_BIND={port.bind}</Code> is set, and it always wins. Change or remove it in the container settings
          and restart the container to use this switch.
        </Alert>
      )}
      <CardContent className="space-y-5 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={port.outsideConnections ? "success" : "muted"} dot>
            {port.outsideConnections ? "Outside connections on" : "Outside connections off"}
          </Badge>
          <span className="text-body text-text-muted">{databasePortSummary(port)}</span>
        </div>
        <Switch
          checked={port.outsideConnections}
          disabled={!editable || change.isPending}
          onCheckedChange={(next) => {
            change.reset();
            setConfirm(next);
          }}
          label="Allow database clients on other machines"
          description={
            port.outsideConnections
              ? "On. MariaDB listens on every address of this server; each database's “connections from” setting decides who may sign in."
              : "Off. MariaDB listens on 127.0.0.1, so game servers, apps and database tools on other machines are refused."
          }
        />
        <Refusal error={change.error} onDismiss={change.reset} />
        <DescriptionList>
          <DescriptionItem term="MariaDB listens on" mono>
            {port.bind}:{port.port}
          </DescriptionItem>
          <DescriptionItem term="Console listens on" mono>
            {status.bind.host}:{status.bind.port}
          </DescriptionItem>
        </DescriptionList>
        <p className="text-body text-text-muted">
          Tunnels and Tailscale Serve carry the console only, and the access policy above does not apply to MariaDB. Database
          clients connect straight to this port.
        </p>
        {isAdmin && <UnknownAccounts supported={port.rejectionsSupported} />}
      </CardContent>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const next = confirm;
          setConfirm(null);
          if (next === null) return;
          change.mutate(next, {
            onSuccess: (res) =>
              toast.success(res.databasePort.outsideConnections ? "Outside connections are on" : "Outside connections are off"),
          });
        }}
        tone={confirm ? "default" : "danger"}
        title={confirm ? "Allow database clients on other machines?" : "Stop database clients on other machines?"}
        body={confirm !== null ? <SwitchConsequences port={port} turningOn={confirm} /> : null}
        confirmLabel={confirm ? "Restart MariaDB and allow" : "Restart MariaDB and stop them"}
        loading={change.isPending}
      />
    </Card>
  );
}

export function UnknownAccountList({ rejections }: { rejections: RejectedConnection[] }) {
  if (rejections.length === 0) {
    return <p className="text-label text-text-muted">No sign-ins for unknown accounts have been refused.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {rejections.map((r) => (
        <RejectionRow key={`${r.address}:${r.account ?? ""}:${r.reason}`} rejection={r} canAllow={false} showAccount />
      ))}
    </ul>
  );
}

function UnknownAccounts({ supported }: { supported: boolean }) {
  const query = useNetworkRejections(supported);
  const clear = useClearRejections();
  if (!supported) {
    return (
      <p className="border-t border-border pt-4 text-label text-text-muted">
        This MariaDB does not report refused sign-ins, so rejected connections are not listed.
      </p>
    );
  }
  const all = query.data?.rejections ?? [];
  const unknown = all.filter(isUnknownAccount).slice(0, UNKNOWN_LIMIT);
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-medium text-text">Rejected connections for unknown accounts</h3>
        {all.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            loading={clear.isPending}
            onClick={() => clear.mutate(undefined, { onError: () => toast.error("Could not clear the list") })}
          >
            <Trash2 aria-hidden /> Clear all
          </Button>
        )}
      </div>
      <p className="text-label text-text-muted">
        An open database port attracts automated sign-in attempts. Each database's “connections from” setting and a rule on your
        router limit who can try.
        {query.data?.since ? ` Recorded since ${formatDate(query.data.since)}.` : ""}
      </p>
      <UnknownAccountList rejections={unknown} />
    </div>
  );
}
