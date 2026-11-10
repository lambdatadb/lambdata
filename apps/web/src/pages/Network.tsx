import { PageHeader } from "../components/layout/PageShell";
import { QueryError } from "../components/layout/QueryError";
import { AccessCard } from "../components/network/AccessCard";
import { AddressesCard } from "../components/network/AddressesCard";
import { ConnectionCard } from "../components/network/ConnectionCard";
import { useNetworkPageStatus } from "../components/network/model";
import { NetworkSection } from "../components/network/parts";
import { PolicyCard } from "../components/network/PolicyCard";
import { TailscaleCard } from "../components/network/TailscaleCard";
import { TunnelCard } from "../components/network/TunnelCard";
import { Alert, Card, DescriptionItem, DescriptionList, SkeletonRows } from "../components/ui";
import { useIsAdmin } from "../lib/auth";

export function Network() {
  const isAdmin = useIsAdmin();
  const query = useNetworkPageStatus();
  const status = query.data;

  return (
    <>
      <PageHeader title="Network" subtitle="How this console can be reached, and how to lock it to the ways you choose." />
      {!isAdmin && (
        <Alert variant="neutral" className="mb-6">
          You can see how the console is reached. Only admins can change these settings.
        </Alert>
      )}
      {status && query.isError && (
        <QueryError
          className="mb-6"
          error={query.error}
          title="Could not refresh the network status; showing what was last read"
          onRetry={query.refetch}
          retrying={query.isFetching}
        />
      )}
      {status === undefined && query.isPending ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : status === undefined && query.isError ? (
        <QueryError error={query.error} title="Could not read the network status" onRetry={query.refetch} retrying={query.isFetching} />
      ) : !status ? (
        <Alert variant="warning" title="This server does not report network settings">
          The API is older than this console. Update LambData and reload.
        </Alert>
      ) : (
        <div className="pb-6">
          {status.warnings?.length > 0 && (
            <Alert variant="warning" title={status.warnings.length === 1 ? "Check this setting" : "Check these settings"} className="mb-8">
              {status.warnings.length === 1 ? (
                status.warnings[0]
              ) : (
                <ul className="list-disc space-y-1 pl-4">
                  {status.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          <NetworkSection
            id="connection"
            step={1}
            title="Where you are"
            description="How this browser reached LambData right now. Every change below is checked against it."
          >
            <ConnectionCard status={status} />
          </NetworkSection>

          <NetworkSection
            id="access-policy"
            step={2}
            title="Who may connect"
            description="Turn off the ways in you do not use. LambData refuses a change that would block the connection making it."
          >
            <PolicyCard status={status} isAdmin={isAdmin} />
          </NetworkSection>

          <NetworkSection
            id="cloudflare-tunnel"
            step={3}
            title="Cloudflare Tunnel"
            description="A public hostname for the console, with no port opened on your router."
          >
            <TunnelCard status={status} isAdmin={isAdmin} />
            <AddressesCard status={status} isAdmin={isAdmin} />
          </NetworkSection>

          <NetworkSection
            id="cloudflare-access"
            step={4}
            title="Cloudflare Access"
            description="Cloudflare's sign-in in front of the tunnel. LambData checks the Access token on every request itself, so a request that only claims to come from Cloudflare is not believed."
          >
            <AccessCard status={status} isAdmin={isAdmin} />
          </NetworkSection>

          <NetworkSection
            id="tailscale"
            step={5}
            title="Tailscale"
            description="Reach the console and your databases over your private tailnet."
          >
            <TailscaleCard status={status} isAdmin={isAdmin} />
          </NetworkSection>

          <NetworkSection
            id="database-connections"
            step={6}
            title="Database connections"
            description="MariaDB is reached separately from the console."
          >
            <Card>
              <div className="space-y-4">
                <p className="text-body text-text-muted">
                  Tunnels and Tailscale Serve carry the console only, and the policy above does not apply to MariaDB. Database
                  clients connect directly over your local network or tailnet; limit them with each database's allowed hosts.
                </p>
                <DescriptionList>
                  <DescriptionItem term="Console listens on" mono>
                    {status.bind.host}:{status.bind.port}
                  </DescriptionItem>
                  <DescriptionItem term="MariaDB listens on" mono>
                    {status.bind.mariadbBind}:{status.bind.mariadbPort}
                  </DescriptionItem>
                </DescriptionList>
              </div>
            </Card>
          </NetworkSection>
        </div>
      )}
    </>
  );
}
