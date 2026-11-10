import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp, DEFAULT_BODY_LIMIT_BYTES } from "../../src/server";
import { audit, settings, users } from "../../src/db/queries";
import { db } from "../../src/db/client";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let viewer: SeededUser;

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  viewer = seedUser("viewer");
});

afterAll(() => md?.cleanup());

async function call(user: SeededUser, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authHeaders(user, { "Content-Type": "application/json" });
  return app.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
}

describe("PATCH /api/settings", () => {
  test("stores allow-listed booleans as 1/0", async () => {
    const res = await call(admin, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ dashboard_show_addresses: false }),
    });
    expect(res.status).toBe(200);
    expect(settings.get("dashboard_show_addresses")).toBe("0");
    const get = await (await call(admin, "/api/settings")).json();
    expect(get.dashboardShowAddresses).toBe(false);
    await call(admin, "/api/settings", { method: "PATCH", body: JSON.stringify({ dashboardShowAddresses: true }) });
    expect(settings.get("dashboard_show_addresses")).toBe("1");
  });

  test("rejects unknown keys, secrets and wrong types", async () => {
    const before = settings.get("jwt_secret");
    for (const body of [{ jwt_secret: "forged" }, { setup_complete: "0" }, { dashboard_show_addresses: "yes" }, {}]) {
      const res = await call(admin, "/api/settings", { method: "PATCH", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
    expect(settings.get("jwt_secret")).toBe(before);
    expect(settings.get("setup_complete")).toBeNull();
  });

  test("is admin-only", async () => {
    const res = await call(viewer, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ dashboard_show_addresses: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/system/audit-logs", () => {
  test("is admin-only", async () => {
    expect((await call(viewer, "/api/system/audit-logs")).status).toBe(403);
    expect((await call(admin, "/api/system/audit-logs")).status).toBe(200);
  });

  test("clamps the limit", async () => {
    for (let i = 0; i < 510; i++) audit.log(admin.id, "x.bulk", null, { i });
    const big = await (await call(admin, "/api/system/audit-logs?limit=100000000")).json();
    expect(big.logs.length).toBe(500);
    const junk = await (await call(admin, "/api/system/audit-logs?limit=abc")).json();
    expect(junk.logs.length).toBe(20);
    const one = await (await call(admin, "/api/system/audit-logs?limit=0")).json();
    expect(one.logs.length).toBe(1);
    expect(Object.keys(one.logs[0]).sort()).toEqual(
      ["action", "at", "details", "id", "target", "user_display_name", "user_email", "user_id"].sort(),
    );
  });
});

describe("user deletion", () => {
  test("a user with audit history can be deleted", async () => {
    const leaver = seedUser("viewer");
    audit.log(leaver.id, "auth.login", null, null);
    const res = await call(admin, `/api/users/${leaver.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(users.byId(leaver.id)).toBeNull();
  });

  test("a user who owns a bucket gets a clear 409", async () => {
    const owner = seedUser("db_owner");
    db.query(
      "INSERT INTO storage_buckets(id, name, public, owner_user_id, created_at, updated_at) VALUES(?, ?, 0, ?, 1, 1)",
    ).run("b_route", "route-bucket", owner.id);
    const res = await call(admin, `/api/users/${owner.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("storage bucket");
  });
});

describe("theme", () => {
  test("lime can be saved through PATCH /api/users/:id", async () => {
    const res = await call(viewer, `/api/users/${viewer.id}`, {
      method: "PATCH",
      body: JSON.stringify({ colorTheme: "lime" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.colorTheme).toBe("lime");
    const bad = await call(viewer, `/api/users/${viewer.id}`, {
      method: "PATCH",
      body: JSON.stringify({ colorTheme: "neon" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("body limits", () => {
  test("ordinary routes refuse bodies over the default limit", async () => {
    const big = JSON.stringify({ dashboard_show_addresses: true, pad: "x".repeat(DEFAULT_BODY_LIMIT_BYTES) });
    const res = await call(admin, "/api/settings", { method: "PATCH", body: big });
    expect(res.status).toBe(413);
  });

  test("chunked bodies over the limit are refused while streaming", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 12) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const headers = await authHeaders(admin, { "Content-Type": "application/json" });
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  test("import uploads are exempt", async () => {
    const big = "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 10);
    const res = await call(admin, "/api/imports/uploads", { method: "POST", body: big });
    expect(res.status).not.toBe(413);
  });
});

describe("stub routes are mounted", () => {
  test("each stub prefix requires a session", async () => {
    for (const path of ["/api/jobs", "/api/imports/x", "/api/network/status", "/api/databases/x/checkpoints"]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
    }
  });
});
