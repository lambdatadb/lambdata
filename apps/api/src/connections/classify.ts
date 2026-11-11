import type { ConnectionRejectionReason, RejectedConnection } from "@lambdata/shared";
import { databases } from "../db/queries";
import { readonlyAccounts } from "../db/queries/readonlyAccounts";
import { env } from "../env";
import { LEGACY } from "../util/legacy";
import { isLoopbackIp, parseIp } from "../network/ip";
import { SCOPED_USER_PREFIX } from "../mariadb/scopedAccount";
import { hostPatternMatches } from "./hostPattern";
import { ER_ACCESS_DENIED, ER_ACCOUNT_LOCKED, ER_HOST_NOT_PRIVILEGED, type RawRejection } from "./parse";
import type { RejectionGroup } from "./store";

export interface KnownAccount {
  databaseId: string;
  connectionsFrom: string;
}

export interface AccountDirectory {
  known: Map<string, KnownAccount>;
  internal: Set<string>;
  internalPrefixes: string[];
}

export interface Classified {
  address: string;
  account: string | null;
  reason: ConnectionRejectionReason;
  databaseId: string | null;
}

const INTERNAL_ACCOUNTS = ["root", "mariadb.sys", "PUBLIC", "mysql"];

export function loadAccountDirectory(): AccountDirectory {
  const known = new Map<string, KnownAccount>();
  for (const d of databases.list()) known.set(d.mysqlUser, { databaseId: d.id, connectionsFrom: d.connectionsFrom });
  const internal = new Set<string>([...INTERNAL_ACCOUNTS, env.rootUser, LEGACY.mariadbRootUser]);
  for (const a of readonlyAccounts.list()) internal.add(a.mysqlUser);
  return { known, internal, internalPrefixes: [SCOPED_USER_PREFIX] };
}

function isLoopbackAddress(address: string): boolean {
  const ip = parseIp(address);
  if (ip) return isLoopbackIp(ip);
  return address.toLowerCase() === "localhost";
}

export function classifyRejection(raw: RawRejection, dir: AccountDirectory): Classified | null {
  if (isLoopbackAddress(raw.address)) return null;
  const user = raw.user;
  if (dir.internal.has(user) || dir.internalPrefixes.some((p) => user.startsWith(p))) return null;
  if (!user) {
    const reason = raw.code === ER_HOST_NOT_PRIVILEGED ? "address-not-allowed" : "other";
    return { address: raw.address, account: null, reason, databaseId: null };
  }
  const known = dir.known.get(user);
  if (!known) return { address: raw.address, account: user, reason: "unknown-account", databaseId: null };
  let reason: ConnectionRejectionReason;
  if (raw.code === ER_ACCOUNT_LOCKED) reason = "closed-for-operation";
  else if (raw.code === ER_HOST_NOT_PRIVILEGED || !hostPatternMatches(known.connectionsFrom, raw.address)) reason = "address-not-allowed";
  else reason = raw.code === ER_ACCESS_DENIED ? "wrong-password" : "other";
  return { address: raw.address, account: user, reason, databaseId: known.databaseId };
}

export function groupRejections(raws: RawRejection[], dir: AccountDirectory): RejectionGroup[] {
  const groups = new Map<string, RejectionGroup>();
  for (const raw of raws) {
    const c = classifyRejection(raw, dir);
    if (!c) continue;
    const key = `${c.address}\u0000${c.account ?? ""}\u0000${c.reason}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.firstAt = Math.min(g.firstAt, raw.at);
      g.lastAt = Math.max(g.lastAt, raw.at);
    } else {
      groups.set(key, { ...c, count: 1, firstAt: raw.at, lastAt: raw.at });
    }
  }
  return [...groups.values()];
}

const DOCKER_NOTE =
  "Behind Docker or a VPN the address MariaDB sees can differ from the client's own address, and the address shown here is the one to allow.";

export function explainRejection(
  g: Pick<RejectionGroup, "address" | "account" | "reason">,
  connectionsFrom: string | null,
): string {
  switch (g.reason) {
    case "address-not-allowed":
      if (g.account === null) {
        return `MariaDB refused ${g.address} before it checked an account, because no account may connect from that address. ${DOCKER_NOTE}`;
      }
      if (connectionsFrom === null) {
        return `The sign-in for “${g.account}” came from ${g.address}, which that account may not connect from. ${DOCKER_NOTE}`;
      }
      return `The sign-in came from ${g.address}, which this database's “connections from” setting (${connectionsFrom}) does not allow, so MariaDB answered as if the password were wrong. ${DOCKER_NOTE}`;
    case "wrong-password":
      return "The address is allowed, but the password was wrong or missing; check the password the client uses, especially after a password change.";
    case "closed-for-operation":
      return "The password was right, but the database was briefly closed to its own account while LambData ran a rollback, import or sync; the client can connect again once that finishes.";
    case "unknown-account":
      return `No database in LambData uses the account “${g.account ?? ""}”, so this was a client set up with the wrong user name or an automated sign-in attempt.`;
    default:
      return `MariaDB refused a connection from ${g.address} before an account was named.`;
  }
}

export function toRejectedConnection(
  g: RejectionGroup,
  lookup: (databaseId: string) => { displayName: string; connectionsFrom: string } | null,
): RejectedConnection {
  const target = g.databaseId ? lookup(g.databaseId) : null;
  const pattern = target?.connectionsFrom ?? null;
  const singleAddress = parseIp(g.address) !== null;
  const canAllow =
    g.reason === "address-not-allowed" &&
    target !== null &&
    singleAddress &&
    pattern !== null &&
    !hostPatternMatches(pattern, g.address);
  return {
    address: g.address,
    account: g.account,
    databaseId: g.databaseId,
    databaseName: target?.displayName ?? null,
    reason: g.reason,
    explanation: explainRejection(g, pattern),
    count: g.count,
    firstAt: g.firstAt,
    lastAt: g.lastAt,
    canAllow,
  };
}
