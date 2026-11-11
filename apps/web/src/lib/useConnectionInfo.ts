import type { Database, DatabaseCredentials } from "@lambdata/shared";
import { useDashboardSummary, useTailscaleStatus } from "./queries";
import { LOCAL_HOST, reachFromSystem, type DatabaseReach } from "./connections";

export interface ConnectionInfo {
  host: string;
  port: number;
  reach: DatabaseReach;
}

export function connectionHostFor(bind: string | undefined, reach: DatabaseReach, pageHost: string): string {
  if (reach === "this-machine") return LOCAL_HOST;
  return !bind || isInternalBind(bind) ? pageHost : bind;
}

export function useConnectionInfo(): ConnectionInfo {
  const q = useDashboardSummary();
  const system = q.data?.system;
  const reach = reachFromSystem(system);
  const pageHost = typeof window === "undefined" ? "localhost" : window.location.hostname;
  return {
    host: connectionHostFor(system?.host, reach, pageHost),
    port: system?.port ?? 3307,
    reach,
  };
}

export interface DatabaseEndpoint {
  label: "LAN" | "Tailnet" | "This machine";
  host: string;
  port: number;
  reachable: boolean;
}

export function isTailnetOnly(connectionsFrom: string): boolean {
  return connectionsFrom.trim().startsWith("100.");
}

export function databaseEndpoints(
  base: ConnectionInfo,
  tailnetIp: string | null,
  db: Pick<Database, "connectionsFrom"> | null | undefined,
): DatabaseEndpoint[] {
  if (base.reach === "this-machine") return [{ label: "This machine", host: LOCAL_HOST, port: base.port, reachable: true }];
  if (base.reach === "not-yet") return [{ label: "LAN", host: base.host, port: base.port, reachable: false }];
  const tailnetOnly = db ? isTailnetOnly(db.connectionsFrom) : false;
  const endpoints: DatabaseEndpoint[] = [{ label: "LAN", host: base.host, port: base.port, reachable: !tailnetOnly }];
  if (tailnetIp) endpoints.push({ label: "Tailnet", host: tailnetIp, port: base.port, reachable: true });
  return endpoints.sort((a, b) => Number(b.reachable) - Number(a.reachable));
}

export function useDatabaseEndpoints(db: Pick<Database, "connectionsFrom"> | null | undefined): DatabaseEndpoint[] {
  const base = useConnectionInfo();
  const tailnetIp = useTailnetIp();
  return databaseEndpoints(base, tailnetIp, db);
}

export function useTailnetIp(): string | null {
  const tailscale = useTailscaleStatus();
  return tailscale.data?.running ? tailscale.data.tailnetIp : null;
}

export function useDatabaseHost(tailnetOnly: boolean): { host: string; port: number; viaTailnet: boolean; reach: DatabaseReach } {
  const base = useConnectionInfo();
  const tailnetIp = useTailnetIp();
  if (base.reach === "outside" && tailnetOnly && tailnetIp) return { ...base, host: tailnetIp, viaTailnet: true };
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

export function revealedCredentials(
  credentials: DatabaseCredentials,
  tailnetOnly: boolean,
  page: ConnectionInfo,
  tailnetIp: string | null,
): { credentials: DatabaseCredentials; tailnetMissing: boolean; reach: DatabaseReach } {
  const reach = page.reach;
  if (reach === "this-machine") return { credentials: credentialsWithHost(credentials, LOCAL_HOST), tailnetMissing: false, reach };
  if (reach === "outside" && tailnetOnly && tailnetIp) {
    return { credentials: credentialsWithHost(credentials, tailnetIp), tailnetMissing: false, reach };
  }
  const host = isInternalBind(credentials.host) ? page.host : credentials.host;
  return {
    credentials: credentialsWithHost(credentials, host),
    tailnetMissing: reach === "outside" && tailnetOnly && !credentials.host.startsWith("100."),
    reach,
  };
}

export function useRevealedCredentials(
  credentials: DatabaseCredentials,
  tailnetOnly: boolean,
): { credentials: DatabaseCredentials; tailnetMissing: boolean; reach: DatabaseReach } {
  const tailnetIp = useTailnetIp();
  const page = useConnectionInfo();
  return revealedCredentials(credentials, tailnetOnly, page, tailnetIp);
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
