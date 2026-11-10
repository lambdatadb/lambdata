import type { Database as Db, DatabaseKind, DatabaseStatus } from "@lambdata/shared";
import { db } from "../client";

export type ProvisionState = "creating" | "deleting";

type DatabaseRow = {
  id: string;
  name: string;
  display_name: string;
  owner_user_id: string;
  owner_display_name?: string | null;
  kind: DatabaseKind;
  mysql_user: string;
  mysql_password_enc: string;
  connections_from: string;
  tailscale_exposed: number;
  lan_exposed: number;
  created_at: number;
  status: DatabaseStatus;
  versioned: number;
  base_checkpoint_id: string | null;
  show_in_vitals: number;
  provision_state: ProvisionState | null;
};

export function resolveBaseShortHash(baseCheckpointId: string | null): string | null {
  if (!baseCheckpointId) return null;
  const r = db.query("SELECT hash FROM checkpoints WHERE id = ?").get(baseCheckpointId) as { hash: string } | null;
  return r ? r.hash.slice(0, 7) : null;
}

function rowToDb(r: DatabaseRow): Db {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    ownerUserId: r.owner_user_id,
    ownerDisplayName: r.owner_display_name ?? null,
    kind: r.kind,
    mysqlUser: r.mysql_user,
    connectionsFrom: r.connections_from,
    tailscaleExposed: r.tailscale_exposed === 1,
    lanExposed: r.lan_exposed === 1,
    createdAt: r.created_at,
    status: r.status,
    versioned: r.versioned === 1,
    baseCheckpointId: r.base_checkpoint_id,
    baseShortHash: resolveBaseShortHash(r.base_checkpoint_id),
    showInVitals: r.show_in_vitals !== 0,
  };
}

const DB_SELECT = `
  SELECT d.*, u.display_name AS owner_display_name
  FROM databases d
  LEFT JOIN users u ON u.id = d.owner_user_id
`;

const VISIBLE = "(d.provision_state IS NULL OR d.provision_state <> 'creating')";

export interface ProvisioningRow {
  id: string;
  name: string;
  mysqlUser: string;
  connectionsFrom: string;
  provisionState: ProvisionState;
  createdAt: number;
}

export const databases = {
  list(): Db[] {
    const rows = db
      .query(`${DB_SELECT} WHERE ${VISIBLE} ORDER BY d.created_at DESC`)
      .all() as DatabaseRow[];
    return rows.map(rowToDb);
  },
  listForUser(userId: string): Db[] {
    const rows = db
      .query(`${DB_SELECT} WHERE d.owner_user_id = ? AND ${VISIBLE} ORDER BY d.created_at DESC`)
      .all(userId) as DatabaseRow[];
    return rows.map(rowToDb);
  },
  byId(id: string): (Db & { mysqlPasswordEnc: string }) | null {
    const r = db.query(`${DB_SELECT} WHERE d.id = ?`).get(id) as DatabaseRow | null;
    return r ? { ...rowToDb(r), mysqlPasswordEnc: r.mysql_password_enc } : null;
  },
  provisionStateOf(id: string): ProvisionState | null {
    const r = db.query("SELECT provision_state FROM databases WHERE id = ?").get(id) as
      | { provision_state: ProvisionState | null }
      | null;
    return r?.provision_state ?? null;
  },
  byName(name: string): Db | null {
    const r = db.query(`${DB_SELECT} WHERE d.name = ?`).get(name) as DatabaseRow | null;
    return r ? rowToDb(r) : null;
  },
  allNames(): string[] {
    const rows = db.query("SELECT name FROM databases").all() as { name: string }[];
    return rows.map((r) => r.name);
  },
  mysqlUserExists(user: string): boolean {
    return db.query("SELECT 1 AS x FROM databases WHERE mysql_user = ?").get(user) !== null;
  },
  insert(d: {
    id: string;
    name: string;
    displayName: string;
    ownerUserId: string;
    kind: DatabaseKind;
    mysqlUser: string;
    mysqlPasswordEnc: string;
    connectionsFrom: string;
    tailscaleExposed: boolean;
    lanExposed: boolean;
    versioned?: boolean;
    showInVitals?: boolean;
    provisionState?: ProvisionState | null;
  }): void {
    db.query(
      `INSERT INTO databases(id, name, display_name, owner_user_id, kind,
        mysql_user, mysql_password_enc, connections_from, tailscale_exposed, lan_exposed, created_at,
        versioned, show_in_vitals, provision_state)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d.id,
      d.name,
      d.displayName,
      d.ownerUserId,
      d.kind,
      d.mysqlUser,
      d.mysqlPasswordEnc,
      d.connectionsFrom,
      d.tailscaleExposed ? 1 : 0,
      d.lanExposed ? 1 : 0,
      Date.now(),
      d.versioned ? 1 : 0,
      d.showInVitals === false ? 0 : 1,
      d.provisionState ?? null,
    );
  },
  update(
    id: string,
    patch: Partial<{
      displayName: string;
      connectionsFrom: string;
      tailscaleExposed: boolean;
      lanExposed: boolean;
      status: DatabaseStatus;
      versioned: boolean;
      showInVitals: boolean;
    }>,
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      vals.push(patch.displayName);
    }
    if (patch.connectionsFrom !== undefined) {
      sets.push("connections_from = ?");
      vals.push(patch.connectionsFrom);
    }
    if (patch.tailscaleExposed !== undefined) {
      sets.push("tailscale_exposed = ?");
      vals.push(patch.tailscaleExposed ? 1 : 0);
    }
    if (patch.lanExposed !== undefined) {
      sets.push("lan_exposed = ?");
      vals.push(patch.lanExposed ? 1 : 0);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.versioned !== undefined) {
      sets.push("versioned = ?");
      vals.push(patch.versioned ? 1 : 0);
    }
    if (patch.showInVitals !== undefined) {
      sets.push("show_in_vitals = ?");
      vals.push(patch.showInVitals ? 1 : 0);
    }
    if (sets.length === 0) return;
    vals.push(id);
    db.query(`UPDATE databases SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]));
  },
  updatePassword(id: string, mysqlPasswordEnc: string): void {
    db.query("UPDATE databases SET mysql_password_enc = ? WHERE id = ?").run(mysqlPasswordEnc, id);
  },
  setBaseCheckpoint(id: string, checkpointId: string | null): void {
    db.query("UPDATE databases SET base_checkpoint_id = ? WHERE id = ?").run(checkpointId, id);
  },
  setProvisionState(id: string, state: ProvisionState | null): void {
    if (state === "deleting") {
      db.query("UPDATE databases SET provision_state = 'deleting', status = 'deleting' WHERE id = ?").run(id);
      return;
    }
    db.query("UPDATE databases SET provision_state = ? WHERE id = ?").run(state, id);
  },
  listProvisioning(): ProvisioningRow[] {
    const rows = db
      .query(
        `SELECT id, name, mysql_user, connections_from, provision_state, created_at
         FROM databases WHERE provision_state IS NOT NULL ORDER BY created_at ASC`,
      )
      .all() as {
      id: string;
      name: string;
      mysql_user: string;
      connections_from: string;
      provision_state: ProvisionState;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      mysqlUser: r.mysql_user,
      connectionsFrom: r.connections_from,
      provisionState: r.provision_state,
      createdAt: r.created_at,
    }));
  },
  delete(id: string): void {
    db.query("DELETE FROM databases WHERE id = ?").run(id);
  },
};
