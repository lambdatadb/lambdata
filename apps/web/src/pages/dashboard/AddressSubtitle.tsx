import type { DashboardSummary } from "@lambdata/shared";
import { CopyButton } from "../../components/ui/CopyableField";
import { formatConnectionAddress, useConnectionInfo } from "../../lib/useConnectionInfo";
import { useTailscaleStatus } from "../../lib/queries";

export function AddressSubtitle({ summary }: { summary: DashboardSummary | undefined }) {
  const show = summary?.system.dashboardShowAddresses === true;
  const connection = useConnectionInfo();
  const tailscale = useTailscaleStatus({ enabled: show });
  if (!show) return <>Your MariaDB cluster at a glance.</>;
  const lan = formatConnectionAddress(connection.host, connection.port);
  const tailnet =
    tailscale.data?.running && tailscale.data.tailnetIp ? formatConnectionAddress(tailscale.data.tailnetIp, connection.port) : null;
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
