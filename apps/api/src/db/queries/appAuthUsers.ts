import type { AppAuthUser, AppAuthUserStatus } from "@lambdata/shared";
import { db } from "../client";

type AppAuthUserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  email_confirmed: number;
  status: AppAuthUserStatus;
  created_at: number;
  last_sign_in_at: number | null;
};

function rowToAppAuthUser(r: AppAuthUserRow): AppAuthUser {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    emailConfirmed: r.email_confirmed === 1,
    status: r.status,
    createdAt: r.created_at,
    lastSignInAt: r.last_sign_in_at,
  };
}

export const appAuthUsers = {
  list(): AppAuthUser[] {
    const rows = db
      .query("SELECT * FROM app_auth_users ORDER BY created_at DESC")
      .all() as AppAuthUserRow[];
    return rows.map(rowToAppAuthUser);
  },
  byId(id: string): (AppAuthUser & { passwordHash: string }) | null {
    const row = db.query("SELECT * FROM app_auth_users WHERE id = ?").get(id) as AppAuthUserRow | null;
    return row ? { ...rowToAppAuthUser(row), passwordHash: row.password_hash } : null;
  },
  byEmail(email: string): (AppAuthUser & { passwordHash: string }) | null {
    const row = db
      .query("SELECT * FROM app_auth_users WHERE email = ?")
      .get(email) as AppAuthUserRow | null;
    return row ? { ...rowToAppAuthUser(row), passwordHash: row.password_hash } : null;
  },
  insert(user: {
    id: string;
    email: string;
    passwordHash: string;
    displayName: string | null;
    emailConfirmed: boolean;
    status: AppAuthUserStatus;
  }): void {
    db.query(
      `INSERT INTO app_auth_users(
        id, email, password_hash, display_name, email_confirmed, status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user.id,
      user.email,
      user.passwordHash,
      user.displayName,
      user.emailConfirmed ? 1 : 0,
      user.status,
      Date.now(),
    );
  },
  update(
    id: string,
    patch: Partial<{
      displayName: string | null;
      emailConfirmed: boolean;
      status: AppAuthUserStatus;
      passwordHash: string;
    }>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      values.push(patch.displayName);
    }
    if (patch.emailConfirmed !== undefined) {
      sets.push("email_confirmed = ?");
      values.push(patch.emailConfirmed ? 1 : 0);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.passwordHash !== undefined) {
      sets.push("password_hash = ?");
      values.push(patch.passwordHash);
    }
    if (sets.length === 0) return;
    values.push(id);
    db.query(`UPDATE app_auth_users SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
  },
  updateLastSignIn(id: string): void {
    db.query("UPDATE app_auth_users SET last_sign_in_at = ? WHERE id = ?").run(Date.now(), id);
  },
  delete(id: string): void {
    db.query("DELETE FROM app_auth_users WHERE id = ?").run(id);
  },
};
