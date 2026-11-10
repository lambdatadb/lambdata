import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedUser, useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { db } from "../../src/db/client";
import {
  audit,
  databases,
  redactAuditDetails,
  settings,
  storageBuckets,
  UserOwnsResourcesError,
  users,
} from "../../src/db/queries";

let md: TempMetadata;

beforeAll(() => {
  md = useTempMetadata();
});

afterAll(() => md?.cleanup());

function insertDatabase(id: string, ownerUserId: string, name = id): void {
  databases.insert({
    id,
    name,
    displayName: name,
    ownerUserId,
    kind: "standard",
    mysqlUser: `ld_${name}_x`,
    mysqlPasswordEnc: "enc",
    connectionsFrom: "%",
    tailscaleExposed: false,
    lanExposed: true,
  });
}

describe("users", () => {
  test("theme defaults to lime and accepts every theme", () => {
    const u = seedUser("viewer");
    expect(users.byId(u.id)!.colorTheme).toBe("lime");
    for (const theme of ["ember", "tide", "grove", "orchid", "lime"] as const) {
      users.updateColorTheme(u.id, theme);
      expect(users.byId(u.id)!.colorTheme).toBe(theme);
    }
  });

  test("legacy color_theme stays in step for the old themes only", () => {
    const u = seedUser("viewer");
    users.updateColorTheme(u.id, "orchid");
    users.updateColorTheme(u.id, "lime");
    const row = db.query("SELECT theme, color_theme FROM users WHERE id = ?").get(u.id);
    expect(row).toEqual({ theme: "lime", color_theme: "orchid" });
  });

  test("an unknown stored theme reads as lime", () => {
    const u = seedUser("viewer");
    db.query("UPDATE users SET theme = 'neon' WHERE id = ?").run(u.id);
    expect(users.byId(u.id)!.colorTheme).toBe("lime");
  });

  test("deleting a user keeps their audit history with the email", () => {
    const admin = seedUser("admin");
    const leaver = seedUser("db_owner");
    audit.log(leaver.id, "auth.login", null, null);
    audit.log(admin.id, "user.update", leaver.id, { role: "viewer" });
    users.delete(leaver.id);
    expect(users.byId(leaver.id)).toBeNull();
    const rows = db
      .query("SELECT user_id, actor_email FROM audit_log WHERE action = 'auth.login' AND actor_email = ?")
      .all(leaver.email) as { user_id: string | null }[];
    expect(rows).toEqual([{ user_id: null, actor_email: leaver.email } as never]);
    const listed = audit.list(50).find((e) => e.action === "auth.login" && e.user_email === leaver.email);
    expect(listed?.user_id).toBeNull();
  });

  test("deleting a user who owns databases or buckets is refused", () => {
    const owner = seedUser("db_owner");
    insertDatabase("db_owned_1", owner.id);
    storageBuckets.insert({ id: "b_owned_1", name: "owned-bucket", public: false, ownerUserId: owner.id });
    let caught: unknown = null;
    try {
      users.delete(owner.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserOwnsResourcesError);
    expect((caught as UserOwnsResourcesError).message).toContain("1 database and 1 storage bucket");
    expect(users.byId(owner.id)).not.toBeNull();
  });
});

describe("audit", () => {
  test("secrets are redacted centrally, whatever the caller passes", () => {
    const u = seedUser("admin");
    audit.log(u.id, "user.update", u.id, { password: "pw-123456", nested: { sourcePassword: "s3" }, ok: 1 });
    audit.log(u.id, "function.secret.upsert", "K", { name: "K", value: "v-secret" });
    audit.log(u.id, "settings.update", null, { jwt_secret: "j", app_auth_jwt_secret: "a", tokenTtlSeconds: 60 });
    const raw = (db.query("SELECT details FROM audit_log WHERE user_id = ?").all(u.id) as { details: string }[])
      .map((r) => r.details)
      .join("\n");
    for (const secret of ["pw-123456", "s3", "v-secret", "\"j\"", "\"a\""]) expect(raw).not.toContain(secret);
    expect(raw).toContain("tokenTtlSeconds");
    expect(raw).toContain("\"ok\":1");
  });

  test("actor_email is recorded on write", () => {
    const u = seedUser("admin");
    audit.log(u.id, "x.test", null, null);
    const row = db.query("SELECT actor_email FROM audit_log WHERE user_id = ? AND action = 'x.test'").get(u.id);
    expect(row).toEqual({ actor_email: u.email });
  });

  test("redactAuditDetails leaves the input untouched", () => {
    const input = { password: "p", list: [{ token: "t" }] };
    const out = redactAuditDetails("x", input) as typeof input;
    expect(out).toEqual({ password: "[redacted]", list: [{ token: "[redacted]" }] });
    expect(input.password).toBe("p");
  });
});

describe("databases", () => {
  test("new columns map onto the Database type", () => {
    const owner = seedUser("admin");
    insertDatabase("db_map", owner.id, "map_db");
    let row = databases.byId("db_map")!;
    expect(row.versioned).toBe(false);
    expect(row.showInVitals).toBe(true);
    expect(row.baseCheckpointId).toBeNull();
    expect(row.baseShortHash).toBeNull();
    databases.update("db_map", { versioned: true, showInVitals: false });
    databases.setBaseCheckpoint("db_map", "cp_1");
    row = databases.byId("db_map")!;
    expect([row.versioned, row.showInVitals, row.baseCheckpointId]).toEqual([true, false, "cp_1"]);
    expect(Object.keys(row)).not.toContain("provisionState");
  });

  test("rows still being created are hidden from listings", () => {
    const owner = seedUser("db_owner");
    databases.insert({
      id: "db_half",
      name: "half_db",
      displayName: "Half",
      ownerUserId: owner.id,
      kind: "standard",
      mysqlUser: "ld_half_x",
      mysqlPasswordEnc: "enc",
      connectionsFrom: "%",
      tailscaleExposed: false,
      lanExposed: true,
      provisionState: "creating",
    });
    expect(databases.list().some((d) => d.id === "db_half")).toBe(false);
    expect(databases.listForUser(owner.id).some((d) => d.id === "db_half")).toBe(false);
    expect(databases.byId("db_half")).not.toBeNull();
    expect(databases.allNames()).toContain("half_db");
    databases.setProvisionState("db_half", "deleting");
    expect(databases.byId("db_half")!.status).toBe("deleting");
    expect(databases.list().some((d) => d.id === "db_half")).toBe(true);
  });
});

describe("settings", () => {
  test("getBool understands legacy string values", () => {
    settings.set("flag_a", "false");
    settings.set("flag_b", "1");
    expect(settings.getBool("flag_a", true)).toBe(false);
    expect(settings.getBool("flag_b", false)).toBe(true);
    expect(settings.getBool("flag_missing", true)).toBe(true);
  });
});
