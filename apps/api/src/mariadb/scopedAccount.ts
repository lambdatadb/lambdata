import type { RowDataPacket } from "mysql2/promise";
import { env } from "../env";
import { generatePassword } from "../util/credentials";
import { randAlphaNum } from "../util/id";
import { localConnectHost, withRootConnection } from "./controller";
import { grantTarget } from "./grantPattern";
import type { Target } from "./process";
import { sanitizeMariaDbMessage } from "./messages";

export const SCOPED_USER_PREFIX = "ld_scp_";
export const IMPORT_USER_PREFIX = "ld_imp_";
const KNOWN_PREFIXES = [SCOPED_USER_PREFIX, IMPORT_USER_PREFIX];
const USER_PATTERN = /^ld_(?:scp|imp)_[A-Za-z0-9]{12}$/;

export interface ScopedAccountOptions {
  schemas: string[];
  setUser?: boolean;
  prefix?: typeof SCOPED_USER_PREFIX | typeof IMPORT_USER_PREFIX;
}

export interface ScopedAccount {
  user: string;
  password: string;
  hosts: string[];
  schemas: string[];
  target: Target;
}

const active = new Set<string>();

function errorMessage(err: unknown): string {
  return sanitizeMariaDbMessage(err instanceof Error ? err.message : String(err));
}

function accountHosts(): string[] {
  return [...new Set(["127.0.0.1", localConnectHost()])];
}

export function scopedAccountActive(user: string): boolean {
  return active.has(user);
}

export async function createScopedAccount(opts: ScopedAccountOptions): Promise<ScopedAccount> {
  if (opts.schemas.length === 0) throw new Error("a scoped account needs at least one schema");
  const grants = opts.schemas.map((s) => grantTarget(s));
  const user = `${opts.prefix ?? SCOPED_USER_PREFIX}${randAlphaNum(12)}`;
  const password = generatePassword();
  const hosts = accountHosts();
  active.add(user);
  try {
    await withRootConnection(async (c) => {
      for (const h of hosts) {
        await c.query("CREATE USER ?@? IDENTIFIED BY ?", [user, h, password]);
        for (const g of grants) await c.query(`GRANT ALL PRIVILEGES ON ${g} TO ?@?`, [user, h]);
        if (opts.setUser) await c.query("GRANT SET USER ON *.* TO ?@?", [user, h]);
      }
    });
  } catch (err) {
    await dropScopedAccount({ user, hosts }).catch(() => {});
    throw new Error(`could not create a temporary scoped account: ${errorMessage(err)}`, { cause: err });
  }
  return {
    user,
    password,
    hosts,
    schemas: [...opts.schemas],
    target: { host: localConnectHost(), port: env.mariadbPort, user, password },
  };
}

export async function dropScopedAccount(account: Pick<ScopedAccount, "user" | "hosts">): Promise<void> {
  try {
    await withRootConnection(async (c) => {
      for (const h of account.hosts) await c.query("DROP USER IF EXISTS ?@?", [account.user, h]);
    });
  } finally {
    active.delete(account.user);
  }
}

export async function withScopedAccount<T>(opts: ScopedAccountOptions, fn: (account: ScopedAccount) => Promise<T>): Promise<T> {
  const account = await createScopedAccount(opts);
  try {
    return await fn(account);
  } finally {
    await dropScopedAccount(account).catch((err) => {
      console.warn(`[mariadb] could not remove temporary account ${account.user}; it is removed at the next startup:`, errorMessage(err));
    });
  }
}

export async function dropOrphanScopedAccounts(): Promise<number> {
  return withRootConnection(async (c) => {
    let dropped = 0;
    for (const prefix of KNOWN_PREFIXES) {
      const [rows] = await c.query<RowDataPacket[]>("SELECT User AS user, Host AS host FROM mysql.user WHERE User LIKE ?", [
        `${prefix.replace(/_/g, "\\_")}%`,
      ]);
      for (const r of rows) {
        const user = String(r.user);
        if (!USER_PATTERN.test(user) || active.has(user)) continue;
        await c.query("DROP USER IF EXISTS ?@?", [user, String(r.host)]);
        dropped++;
      }
    }
    return dropped;
  });
}
