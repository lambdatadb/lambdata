import { Link } from "react-router-dom";
import type { DashboardSummary } from "@lambdata/shared";
import { CopyButton } from "../../components/ui/CopyableField";
import { formatConnectionAddress, useConnectionInfo } from "../../lib/useConnectionInfo";
import { useTailscaleStatus } from "../../lib/queries";
import { DATABASE_SWITCH_PATH, type DatabaseReach } from "../../lib/connections";

export function AddressSubtitle({ summary }: { summary: DashboardSummary | undefined }) {
  const show = summary?.system.dashboardShowAddresses === true;
  const connection = useConnectionInfo();
  const tailscale = useTailscaleStatus({ enabled: show && connection.reach === "outside" });
  if (!show) return <>Your MariaDB cluster at a glance.</>;
  const tailnetIp = tailscale.data?.running ? tailscale.data.tailnetIp : null;
  return <AddressLine reach={connection.reach} host={connection.host} port={connection.port} tailnetIp={tailnetIp} />;
}

export function AddressLine({
  reach,
  host,
  port,
  tailnetIp,
}: {
  reach: DatabaseReach;
  host: string;
  port: number;
  tailnetIp: string | null;
}) {
  if (reach === "not-yet") {
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-reach="not-yet">
        <span className="text-micro text-text-subtle">MariaDB</span>
        <span>Database clients on other machines cannot connect yet.</span>
        <Link to={DATABASE_SWITCH_PATH} className="text-text underline underline-offset-4 hover:decoration-accent">
          Allow them on the Network page
        </Link>
      </span>
    );
  }
  if (reach === "this-machine") {
    const local = formatConnectionAddress(host, port);
    return (
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1" data-reach="this-machine">
        <Address label="This machine" value={local} />
        <span className="text-micro text-text-subtle">reachable from this machine only</span>
      </span>
    );
  }
  const lan = formatConnectionAddress(host, port);
  const tailnet = tailnetIp ? formatConnectionAddress(tailnetIp, port) : null;
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Address label="LAN" value={lan} />
      {tailnet && <Address label="Tailnet" value={tailnet} />}
    </span>
  );
}

function Address({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-micro text-text-subtle">{label}</span>
      <span className="font-mono text-code text-text">{value}</span>
      <CopyButton value={value} label={`${label} address`} size="icon-xs" />
    </span>
  );
}
