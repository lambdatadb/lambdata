import { db } from "../client";

export interface ReadonlyAccount {
  databaseId: string;
  mysqlUser: string;
  mysqlHost: string;
  passwordEnc: string;
  ready: boolean;
  createdAt: number;
}

type ReadonlyAccountRow = {
  database_id: string;
  mysql_user: string;
  mysql_host: string;
  password_enc: string;
  ready: number;
  created_at: number;
};

function rowToAccount(r: ReadonlyAccountRow): ReadonlyAccount {
  return {
    databaseId: r.database_id,
    mysqlUser: r.mysql_user,
    mysqlHost: r.mysql_host,
    passwordEnc: r.password_enc,
    ready: r.ready === 1,
    createdAt: r.created_at,
  };
}

export const readonlyAccounts = {
  byDatabaseId(databaseId: string): ReadonlyAccount | null {
    const r = db.query("SELECT * FROM readonly_accounts WHERE database_id = ?").get(databaseId) as
      | ReadonlyAccountRow
      | null;
    return r ? rowToAccount(r) : null;
  },
  list(): ReadonlyAccount[] {
    const rows = db.query("SELECT * FROM readonly_accounts ORDER BY created_at ASC").all() as ReadonlyAccountRow[];
    return rows.map(rowToAccount);
  },
  userExists(mysqlUser: string): boolean {
    return db.query("SELECT 1 AS x FROM readonly_accounts WHERE mysql_user = ?").get(mysqlUser) !== null;
  },
  insert(a: { databaseId: string; mysqlUser: string; mysqlHost: string; passwordEnc: string }): void {
    db.query(
      `INSERT INTO readonly_accounts(database_id, mysql_user, mysql_host, password_enc, ready, created_at)
       VALUES(?, ?, ?, ?, 0, ?)`,
    ).run(a.databaseId, a.mysqlUser, a.mysqlHost, a.passwordEnc, Date.now());
  },
  setHost(databaseId: string, mysqlHost: string): void {
    db.query("UPDATE readonly_accounts SET mysql_host = ? WHERE database_id = ?").run(mysqlHost, databaseId);
  },
  setReady(databaseId: string, ready: boolean): void {
    db.query("UPDATE readonly_accounts SET ready = ? WHERE database_id = ?").run(ready ? 1 : 0, databaseId);
  },
  delete(databaseId: string): void {
    db.query("DELETE FROM readonly_accounts WHERE database_id = ?").run(databaseId);
  },
};
