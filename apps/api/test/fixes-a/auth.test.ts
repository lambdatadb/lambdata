import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { appAuthUsers, settings, users } from "../../src/db/queries";
import { db } from "../../src/db/client";
import { hashPassword } from "../../src/auth/password";
import { COOKIE_NAME, signJwt } from "../../src/auth/jwt";
import { signAppAuthJwt } from "../../src/auth/appJwt";
import { ENCRYPTED_SECRET_PREFIX } from "../../src/auth/hs256";
import { requireAuth, type AuthVariables } from "../../src/auth/middleware";
import { newId } from "../../src/util/id";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;

const REMOTE = { server: { requestIP: () => ({ address: "203.0.113.7", family: "IPv4", port: 40000 }) } };
const LOOPBACK = { server: { requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 40001 }) } };

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  settings.set("setup_complete", "1");
});

afterAll(() => md.cleanup());

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function handSignedToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

function cookieFor(token: string): Record<string, string> {
  return { Cookie: `${COOKIE_NAME}=${token}` };
}

function sessionCookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) throw new Error("no session cookie in response");
  return match[1]!;
}

async function json(path: string, init: RequestInit & { headers?: Record<string, string> } = {}, env?: object) {
  return app.request(
    path,
    { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } },
    env,
  );
}

async function seedWithPassword(role: "admin" | "db_owner" | "viewer", password: string): Promise<SeededUser> {
  const id = newId("u");
  const email = `${role}-${id.slice(-8)}@example.test`;
  users.insert({ id, email, passwordHash: await hashPassword(password), displayName: null, role, experienceLevel: "advanced" });
  return { id, email, role };
}

function seedAppUser(): { id: string; email: string } {
  const id = newId("app_user");
  const email = `app-${id.slice(-8)}@example.test`;
  appAuthUsers.insert({ id, email, passwordHash: "unused", displayName: null, emailConfirmed: true, status: "active" });
  return { id, email };
}

describe("JWT secrets at rest", () => {
  test("a console session signed with the old plaintext secret still works and the secret is encrypted in place", async () => {
    const legacySecret = "legacy-console-secret-0123456789abcdef";
    settings.set("jwt_secret", legacySecret);
    const user = seedUser("viewer");
    const now = Math.floor(Date.now() / 1000);
    const token = await handSignedToken(legacySecret, { sub: user.id, role: "viewer", iat: now, exp: now + 3600 });

    const first = await app.request("/api/auth/me", { headers: cookieFor(token) });
    expect(first.status).toBe(200);
    const stored = settings.get("jwt_secret")!;
    expect(stored.startsWith(ENCRYPTED_SECRET_PREFIX)).toBe(true);
    expect(stored).not.toContain(legacySecret);

    const second = await app.request("/api/auth/me", { headers: cookieFor(token) });
    expect(second.status).toBe(200);
    expect(settings.get("jwt_secret")).toBe(stored);
    const fresh = await signJwt(user.id, "viewer");
    expect((await app.request("/api/auth/me", { headers: cookieFor(fresh) })).status).toBe(200);
  });

  test("an App Auth token signed with the old plaintext secret and legacy issuer still works", async () => {
    const legacySecret = "legacy-app-secret-0123456789abcdef";
    settings.set("app_auth_jwt_secret", legacySecret);
    const appUser = seedAppUser();
    const now = Math.floor(Date.now() / 1000);
    const token = await handSignedToken(legacySecret, {
      sub: appUser.id,
      email: appUser.email,
      role: "authenticated",
      aud: "authenticated",
      iss: "kilndb-app-auth",
      iat: now,
      exp: now + 3600,
    });
    const res = await app.request("/api/app-auth/user", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).user.id).toBe(appUser.id);
    const stored = settings.get("app_auth_jwt_secret")!;
    expect(stored.startsWith(ENCRYPTED_SECRET_PREFIX)).toBe(true);
    expect(stored).not.toContain(legacySecret);
  });

  test("a new install never stores a plaintext secret", async () => {
    db.query("DELETE FROM settings WHERE key = 'jwt_secret'").run();
    const user = seedUser("viewer");
    const token = await signJwt(user.id, "viewer");
    expect(settings.get("jwt_secret")!.startsWith(ENCRYPTED_SECRET_PREFIX)).toBe(true);
    expect((await app.request("/api/auth/me", { headers: cookieFor(token) })).status).toBe(200);
  });

  test("a malformed session cookie is a 401, not a server error", async () => {
    const res = await app.request("/api/auth/me", { headers: cookieFor("a.b!.c") });
    expect(res.status).toBe(401);
  });
});

describe("session revocation", () => {
  test("changing your own password needs the current password and ends your other sessions", async () => {
    const user = await seedWithPassword("viewer", "old-password-1");
    const oldCookie = await authHeaders(user);
    const path = `/api/users/${user.id}`;

    const missing = await json(path, { method: "PATCH", headers: oldCookie, body: JSON.stringify({ password: "new-password-1" }) });
    expect(missing.status).toBe(400);
    const wrong = await json(path, {
      method: "PATCH",
      headers: oldCookie,
      body: JSON.stringify({ password: "new-password-1", currentPassword: "not-it-at-all" }),
    });
    expect(wrong.status).toBe(403);
    expect((await app.request("/api/auth/me", { headers: oldCookie })).status).toBe(200);

    const ok = await json(path, {
      method: "PATCH",
      headers: oldCookie,
      body: JSON.stringify({ password: "new-password-1", currentPassword: "old-password-1" }),
    });
    expect(ok.status).toBe(200);
    const replacement = sessionCookieFrom(ok);

    expect((await app.request("/api/auth/me", { headers: oldCookie })).status).toBe(401);
    expect((await app.request("/api/auth/me", { headers: cookieFor(replacement) })).status).toBe(200);
    const login = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: user.email, password: "new-password-1" }),
    });
    expect(login.status).toBe(200);
  });

  test("an admin resetting someone's password signs that user out everywhere", async () => {
    const user = await seedWithPassword("db_owner", "first-password");
    const theirCookie = await authHeaders(user);
    const adminCookie = await authHeaders(admin);
    const res = await json(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: adminCookie,
      body: JSON.stringify({ password: "reset-by-admin" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await app.request("/api/auth/me", { headers: theirCookie })).status).toBe(401);
    expect((await app.request("/api/auth/me", { headers: adminCookie })).status).toBe(200);
  });

  test("sign out everywhere invalidates every existing session", async () => {
    const user = seedUser("viewer");
    const a = await authHeaders(user);
    const b = await authHeaders(user);
    const untyped = await app.request("/api/auth/logout-all", { method: "POST", headers: a });
    expect(untyped.status).toBe(415);
    const res = await app.request("/api/auth/logout-all", { method: "POST", headers: { ...a, "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    expect((await app.request("/api/auth/me", { headers: a })).status).toBe(401);
    expect((await app.request("/api/auth/me", { headers: b })).status).toBe(401);
    expect((await app.request("/api/auth/me", { headers: await authHeaders(user) })).status).toBe(200);
  });

  test("an admin resetting an App Auth user's password revokes that user's tokens", async () => {
    const appUser = seedAppUser();
    const { accessToken } = await signAppAuthJwt({ ...appAuthUsers.byId(appUser.id)! });
    const bearer = { Authorization: `Bearer ${accessToken}` };
    expect((await app.request("/api/app-auth/user", { headers: bearer })).status).toBe(200);
    const res = await json(`/api/app-auth/users/${appUser.id}`, {
      method: "PATCH",
      headers: await authHeaders(admin),
      body: JSON.stringify({ password: "a-new-app-password" }),
    });
    expect(res.status).toBe(200);
    expect((await app.request("/api/app-auth/user", { headers: bearer })).status).toBe(401);
  });
});

describe("users", () => {
  test("PATCH applies displayName", async () => {
    const user = seedUser("viewer");
    const res = await json(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: await authHeaders(user),
      body: JSON.stringify({ displayName: "Renamed Person" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.displayName).toBe("Renamed Person");
    expect(users.byId(user.id)!.displayName).toBe("Renamed Person");
  });

  test("invalid bodies are rejected before anything is written", async () => {
    const user = seedUser("viewer");
    const before = users.byId(user.id)!;
    const res = await json(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: await authHeaders(admin),
      body: JSON.stringify({ role: "root", displayName: "Should not stick" }),
    });
    expect(res.status).toBe(400);
    expect(users.byId(user.id)!.displayName).toBe(before.displayName);
    expect(users.byId(user.id)!.role).toBe("viewer");
  });

  test("requireAuth trusts a user already resolved on the request", async () => {
    const probe = new Hono<{ Variables: AuthVariables }>();
    const user = users.byId(admin.id)!;
    probe.use("*", async (c, next) => {
      c.set("user", user);
      await next();
    });
    probe.get("/x", requireAuth, requireAuth, (c) => c.json({ id: c.get("user").id }));
    const res = await probe.request("/x");
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(admin.id);
  });
});

describe("App Auth signup default", () => {
  const signup = () =>
    json("/api/app-auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: `s-${newId().slice(-10)}@example.test`, password: "signup-password" }),
    });

  test("unset means off", async () => {
    db.query("DELETE FROM settings WHERE key = 'app_auth_allow_signup'").run();
    expect((await signup()).status).toBe(403);
    const res = await app.request("/api/app-auth/settings", { headers: await authHeaders(admin) });
    expect((await res.json()).settings.allowSignup).toBe(false);
  });

  test("explicitly off stays off", async () => {
    settings.set("app_auth_allow_signup", "0");
    expect((await signup()).status).toBe(403);
  });

  test("explicitly on, as the settings switch stores it, stays on", async () => {
    settings.set("app_auth_allow_signup", "1");
    const res = await signup();
    expect(res.status).toBe(200);
    expect((await res.json()).session.accessToken).toBeString();
  });

  test("the switch stores 1 and 0", async () => {
    const headers = await authHeaders(admin);
    await json("/api/app-auth/settings", { method: "PATCH", headers, body: JSON.stringify({ allowSignup: false }) });
    expect(settings.get("app_auth_allow_signup")).toBe("0");
    await json("/api/app-auth/settings", { method: "PATCH", headers, body: JSON.stringify({ allowSignup: true }) });
    expect(settings.get("app_auth_allow_signup")).toBe("1");
    const bad = await json("/api/app-auth/settings", { method: "PATCH", headers, body: JSON.stringify({ allowSignup: "yes" }) });
    expect(bad.status).toBe(400);
  });
});

describe("first-run window", () => {
  test("before setup, folder checks and the data-dir step only answer localhost", async () => {
    settings.set("setup_complete", "0");
    try {
      const body = JSON.stringify({ path: md.dataDir });
      const remoteValidate = await json("/api/system/validate-path", { method: "POST", body }, REMOTE);
      expect(remoteValidate.status).toBe(403);
      const remotePick = await json("/api/system/pick-folder", { method: "POST", body: "{}" }, REMOTE);
      expect(remotePick.status).toBe(403);
      const remoteDataDir = await json("/api/setup/data-dir", { method: "POST", body }, REMOTE);
      expect(remoteDataDir.status).toBe(403);
      const unknownPeer = await json("/api/system/validate-path", { method: "POST", body });
      expect(unknownPeer.status).toBe(403);

      const localValidate = await json("/api/system/validate-path", { method: "POST", body }, LOOPBACK);
      expect(localValidate.status).toBe(200);
      expect((await localValidate.json()).resolvedPath).toBeString();

      const state = await (await app.request("/api/setup/state")).json();
      expect(state.needsSetup).toBe(true);
      expect(state.dataDir).toBe(md.dataDir);
    } finally {
      settings.set("setup_complete", "1");
    }
  });

  test("after setup, the same endpoints need an admin session and setup state hides paths", async () => {
    const body = JSON.stringify({ path: md.dataDir });
    expect((await json("/api/system/validate-path", { method: "POST", body }, LOOPBACK)).status).toBe(401);
    const viewer = seedUser("viewer");
    const asViewer = await json("/api/system/validate-path", { method: "POST", body, headers: await authHeaders(viewer) }, LOOPBACK);
    expect(asViewer.status).toBe(403);
    const asAdmin = await json("/api/system/validate-path", { method: "POST", body, headers: await authHeaders(admin) }, REMOTE);
    expect(asAdmin.status).toBe(200);
    const state = await (await app.request("/api/setup/state")).json();
    expect(state).toEqual({ needsSetup: false, dataDir: "", dataDirConfigured: state.dataDirConfigured, homeDir: "", tokenRequired: false });
  });
});
