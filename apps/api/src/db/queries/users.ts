import type { ColorTheme, ExperienceLevel, Role, User, VitalsChartStyle } from "@lambdata/shared";
import { db } from "../client";

export const COLOR_THEMES = ["lime", "ember", "tide", "grove", "orchid"] as const satisfies readonly ColorTheme[];
const LEGACY_COLOR_THEMES: readonly string[] = ["ember", "tide", "grove", "orchid"];
export const DEFAULT_COLOR_THEME: ColorTheme = "lime";

export function isColorTheme(value: unknown): value is ColorTheme {
  return typeof value === "string" && (COLOR_THEMES as readonly string[]).includes(value);
}

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: Role;
  experience_level: ExperienceLevel;
  data_view_enabled: number;
  theme: string | null;
  vitals_chart_style: VitalsChartStyle;
  created_at: number;
  last_login_at: number | null;
  kind?: string | null;
};

export type UserKind = "person" | "token";

function kindOf(r: UserRow): UserKind {
  return r.kind === "token" ? "token" : "person";
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    experienceLevel: r.experience_level,
    dataViewEnabled: r.data_view_enabled === 1,
    colorTheme: isColorTheme(r.theme) ? r.theme : DEFAULT_COLOR_THEME,
    vitalsChartStyle: r.vitals_chart_style === "capsules" ? "capsules" : "area",
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

export class UserOwnsResourcesError extends Error {
  readonly databases: number;
  readonly buckets: number;

  constructor(databases: number, buckets: number) {
    const parts: string[] = [];
    if (databases > 0) parts.push(`${databases} database${databases === 1 ? "" : "s"}`);
    if (buckets > 0) parts.push(`${buckets} storage bucket${buckets === 1 ? "" : "s"}`);
    super(`user still owns ${parts.join(" and ")}; delete or reassign them first`);
    this.name = "UserOwnsResourcesError";
    this.databases = databases;
    this.buckets = buckets;
  }
}

export const users = {
  list(): User[] {
    const rows = db
      .query("SELECT * FROM users WHERE kind = 'person' ORDER BY created_at ASC")
      .all() as UserRow[];
    return rows.map(rowToUser);
  },
  byId(id: string): (User & { passwordHash: string; kind: UserKind }) | null {
    const r = db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
    return r ? { ...rowToUser(r), passwordHash: r.password_hash, kind: kindOf(r) } : null;
  },
  personById(id: string): (User & { passwordHash: string }) | null {
    const r = db.query("SELECT * FROM users WHERE id = ? AND kind = 'person'").get(id) as UserRow | null;
    return r ? { ...rowToUser(r), passwordHash: r.password_hash } : null;
  },
  byEmail(email: string): (User & { passwordHash: string }) | null {
    const r = db.query("SELECT * FROM users WHERE email = ? AND kind = 'person'").get(email) as UserRow | null;
    return r ? { ...rowToUser(r), passwordHash: r.password_hash } : null;
  },
  emailTaken(email: string): boolean {
    return db.query("SELECT 1 AS x FROM users WHERE email = ?").get(email) !== null;
  },
  isTokenActor(id: string): boolean {
    return db.query("SELECT 1 AS x FROM users WHERE id = ? AND kind = 'token'").get(id) !== null;
  },
  insert(u: {
    id: string;
    email: string;
    passwordHash: string;
    displayName: string | null;
    role: Role;
    experienceLevel: ExperienceLevel;
  }): void {
    db.query(
      `INSERT INTO users(id, email, password_hash, display_name, role, experience_level, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(u.id, u.email, u.passwordHash, u.displayName, u.role, u.experienceLevel, Date.now());
  },
  updateLastLogin(id: string): void {
    db.query("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), id);
  },
  updateRole(id: string, role: Role): void {
    db.query("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  },
  updatePassword(id: string, passwordHash: string): void {
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  },
  updateDisplayName(id: string, displayName: string | null): void {
    db.query("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, id);
  },
  updateExperience(id: string, level: ExperienceLevel): void {
    db.query("UPDATE users SET experience_level = ? WHERE id = ?").run(level, id);
  },
  updateDataView(id: string, enabled: boolean): void {
    db.query("UPDATE users SET data_view_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  },
  updateColorTheme(id: string, theme: ColorTheme): void {
    if (!isColorTheme(theme)) throw new Error(`invalid color theme: ${String(theme)}`);
    const legacy = LEGACY_COLOR_THEMES.includes(theme) ? theme : null;
    db.query(
      "UPDATE users SET theme = ?, color_theme = COALESCE(?, color_theme) WHERE id = ?",
    ).run(theme, legacy, id);
  },
  updateVitalsChartStyle(id: string, style: VitalsChartStyle): void {
    db.query("UPDATE users SET vitals_chart_style = ? WHERE id = ?").run(style, id);
  },
  ownedResourceCounts(id: string): { databases: number; buckets: number } {
    const dbs = db
      .query("SELECT COUNT(*) AS n FROM databases WHERE owner_user_id = ?")
      .get(id) as { n: number };
    const buckets = db
      .query("SELECT COUNT(*) AS n FROM storage_buckets WHERE owner_user_id = ?")
      .get(id) as { n: number };
    return { databases: Number(dbs.n), buckets: Number(buckets.n) };
  },
  delete(id: string): { id: string; name: string }[] {
    return db.transaction(() => {
      if (users.isTokenActor(id)) return [];
      const owned = users.ownedResourceCounts(id);
      if (owned.databases > 0 || owned.buckets > 0) {
        throw new UserOwnsResourcesError(owned.databases, owned.buckets);
      }
      const revoked = db
        .query("SELECT id, name FROM access_tokens WHERE created_by_user_id = ? AND revoked_at IS NULL")
        .all(id) as { id: string; name: string }[];
      db.query("UPDATE access_tokens SET revoked_at = ? WHERE created_by_user_id = ? AND revoked_at IS NULL").run(
        Date.now(),
        id,
      );
      db.query(
        `UPDATE audit_log
         SET actor_email = COALESCE(actor_email, (SELECT email FROM users WHERE id = ?)),
             user_id = NULL
         WHERE user_id = ?`,
      ).run(id, id);
      db.query("DELETE FROM users WHERE id = ? AND kind = 'person'").run(id);
      return revoked;
    })();
  },
};
