import type { Database, DatabaseCredentials } from "@lambdata/shared";
import { useDashboardSummary, useTailscaleStatus } from "./queries";

export function useConnectionInfo(): { host: string; port: number } {
  const q = useDashboardSummary();
  const bind = q.data?.system.host;
  const pageHost = typeof window === "undefined" ? "localhost" : window.location.hostname;
  return {
    host: !bind || isInternalBind(bind) ? pageHost : bind,
    port: q.data?.system.port ?? 3307,
  };
}

export interface DatabaseEndpoint {
  label: "LAN" | "Tailnet";
  host: string;
  port: number;
  reachable: boolean;
}

export function isTailnetOnly(connectionsFrom: string): boolean {
  return connectionsFrom.trim().startsWith("100.");
}

export function useDatabaseEndpoints(db: Pick<Database, "connectionsFrom"> | null | undefined): DatabaseEndpoint[] {
  const base = useConnectionInfo();
  const tailnetIp = useTailnetIp();
  const tailnetOnly = db ? isTailnetOnly(db.connectionsFrom) : false;
  const endpoints: DatabaseEndpoint[] = [{ label: "LAN", host: base.host, port: base.port, reachable: !tailnetOnly }];
  if (tailnetIp) endpoints.push({ label: "Tailnet", host: tailnetIp, port: base.port, reachable: true });
  return endpoints.sort((a, b) => Number(b.reachable) - Number(a.reachable));
}

export function useTailnetIp(): string | null {
  const tailscale = useTailscaleStatus();
  return tailscale.data?.running ? tailscale.data.tailnetIp : null;
}

export function useDatabaseHost(tailnetOnly: boolean): { host: string; port: number; viaTailnet: boolean } {
  const base = useConnectionInfo();
  const tailnetIp = useTailnetIp();
  if (tailnetOnly && tailnetIp) return { host: tailnetIp, port: base.port, viaTailnet: true };
  return { ...base, viaTailnet: false };
}

export function credentialsWithHost(credentials: DatabaseCredentials, host: string): DatabaseCredentials {
  if (host === credentials.host) return credentials;
  const u = encodeURIComponent(credentials.user);
  const pw = encodeURIComponent(credentials.password);
  const { port, schema, user } = credentials;
  return {
    ...credentials,
    host,
    mysqlCli: `mysql -h ${host} -P ${port} -u ${user} -p ${schema}`,
    jdbc: `jdbc:mysql://${host}:${port}/${schema}?user=${u}&password=${pw}`,
    uri: `mysql://${u}:${pw}@${host}:${port}/${schema}`,
  };
}

export function useRevealedCredentials(
  credentials: DatabaseCredentials,
  tailnetOnly: boolean,
): { credentials: DatabaseCredentials; tailnetMissing: boolean } {
  const tailnetIp = useTailnetIp();
  const page = useConnectionInfo();
  if (tailnetOnly && tailnetIp) return { credentials: credentialsWithHost(credentials, tailnetIp), tailnetMissing: false };
  const host = isInternalBind(credentials.host) ? page.host : credentials.host;
  return { credentials: credentialsWithHost(credentials, host), tailnetMissing: tailnetOnly && !credentials.host.startsWith("100.") };
}

export function formatConnectionAddress(host: string, port: number): string {
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bareHost.includes(":") ? `[${bareHost}]:${port}` : `${bareHost}:${port}`;
}

function isInternalBind(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.")
  );
}
