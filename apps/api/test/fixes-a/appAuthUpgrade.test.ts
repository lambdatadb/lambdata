import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { db } from "../../src/db/client";
import { appAuthUsers, settings } from "../../src/db/queries";
import {
  APP_AUTH_ISSUER,
  ISSUER_SETTING,
  SIGNUP_DISABLED_BY_UPGRADE,
  SIGNUP_REFUSED_COUNT,
  SIGNUP_REFUSED_LAST_AT,
  SIGNUP_SETTING,
  SIGNUP_UPGRADE_CHECKED,
  appAuthSettings,
  settleAppAuthUpgrade,
  signAppAuthJwt,
  verifyAppAuthJwt,
} from "../../src/auth/appJwt";
import { newId } from "../../src/util/id";
import { peerEnv } from "../network/helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let ip = 10;

const KEYS = [
  "app_auth_jwt_secret",
  ISSUER_SETTING,
  SIGNUP_SETTING,
  SIGNUP_UPGRADE_CHECKED,
  SIGNUP_DISABLED_BY_UPGRADE,
  SIGNUP_REFUSED_COUNT,
  SIGNUP_REFUSED_LAST_AT,
];

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  settings.set("setup_complete", "1");
});

afterAll(() => md.cleanup());

beforeEach(() => {
  for (const key of KEYS) db.query("DELETE FROM settings WHERE key = ?").run(key);
  db.query("DELETE FROM app_auth_users").run();
});

function seedLegacyAppAuth(): void {
  settings.set("app_auth_jwt_secret", "legacy-app-secret-0123456789abcdef");
  appAuthUsers.insert({
    id: newId("app_user"),
    email: `legacy-${newId().slice(-8)}@example.test`,
    passwordHash: "unused",
    displayName: null,
    emailConfirmed: true,
    status: "active",
  });
}

function signup() {
  ip += 1;
  return app.request(
    "/api/app-auth/signup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `new-${newId().slice(-8)}@example.test`, password: "signup-password" }),
    },
    peerEnv(`192.168.7.${ip}`),
  );
}

async function settingsResponse() {
  const res = await app.request("/api/app-auth/settings", { headers: await authHeaders(admin) });
  return (await res.json()).settings;
}

describe("App Auth issuer (REH-4)", () => {
  test("a fresh install signs with the new issuer and remembers it", async () => {
    settleAppAuthUpgrade();
    expect(settings.get(ISSUER_SETTING)).toBe(APP_AUTH_ISSUER);
    expect(appAuthSettings().issuer).toBe(APP_AUTH_ISSUER);
  });

  test("an install that already had an App Auth secret keeps the legacy issuer, and both issuers verify", async () => {
    seedLegacyAppAuth();
    settleAppAuthUpgrade();
    expect(appAuthSettings().issuer).toBe("kilndb-app-auth");
    const user = appAuthUsers.list()[0]!;
    const { accessToken } = await signAppAuthJwt(user);
    const claims = await verifyAppAuthJwt(accessToken);
    expect(claims?.iss).toBe("kilndb-app-auth");
    settings.set(ISSUER_SETTING, APP_AUTH_ISSUER);
    const modern = await signAppAuthJwt(user);
    expect((await verifyAppAuthJwt(modern.accessToken))?.iss).toBe(APP_AUTH_ISSUER);
    settings.set(ISSUER_SETTING, "kilndb-app-auth");
    expect((await verifyAppAuthJwt(modern.accessToken))?.iss).toBe(APP_AUTH_ISSUER);
    expect((await settingsResponse()).issuer).toBe("kilndb-app-auth");
  });

  test("the decision is made before the first verification can create a secret", async () => {
    expect(await verifyAppAuthJwt("not.a.token")).toBeNull();
    expect(settings.get(ISSUER_SETTING)).toBe(APP_AUTH_ISSUER);
  });
});

describe("App Auth sign-up after the upgrade", () => {
  test("legacy metadata with no signup key is flagged, refuses sign-up with a helpful message, and counts refusals", async () => {
    seedLegacyAppAuth();
    settleAppAuthUpgrade();
    const first = await signup();
    expect(first.status).toBe(403);
    const error = (await first.json()).error as string;
    expect(error).toContain("disabled");
    expect(error).toContain("App Auth");
    expect(error).toContain("Allow signup");
    expect((await signup()).status).toBe(403);
    const s = await settingsResponse();
    expect(s.allowSignup).toBe(false);
    expect(s.signupDisabledByUpgrade).toBe(true);
    expect(s.signupRefusedCount).toBe(2);
    expect(s.signupRefusedLastAt).toBeGreaterThan(Date.now() - 60_000);
  });

  test("saving the signup setting either way clears the flag", async () => {
    for (const allowSignup of [false, true]) {
      for (const key of KEYS) db.query("DELETE FROM settings WHERE key = ?").run(key);
      seedLegacyAppAuth();
      settleAppAuthUpgrade();
      expect((await settingsResponse()).signupDisabledByUpgrade).toBe(true);
      const res = await app.request("/api/app-auth/settings", {
        method: "PATCH",
        headers: await authHeaders(admin, { "Content-Type": "application/json" }),
        body: JSON.stringify({ allowSignup }),
      });
      expect(res.status).toBe(200);
      const after = (await res.json()).settings;
      expect(after.signupDisabledByUpgrade).toBe(false);
      expect(after.signupRefusedCount).toBe(0);
      settleAppAuthUpgrade();
      expect((await settingsResponse()).signupDisabledByUpgrade).toBe(false);
      expect((await signup()).status).toBe(allowSignup ? 200 : 403);
      expect((await settingsResponse()).signupRefusedCount).toBe(0);
    }
  });

  test("a fresh install never gets the flag, even after App Auth users are added later", async () => {
    settleAppAuthUpgrade();
    seedLegacyAppAuth();
    settleAppAuthUpgrade();
    const s = await settingsResponse();
    expect(s.signupDisabledByUpgrade).toBe(false);
    expect(s.issuer).toBe(APP_AUTH_ISSUER);
    expect((await signup()).status).toBe(403);
    expect((await settingsResponse()).signupRefusedCount).toBe(0);
  });

  test("an old install that had stored its choice keeps it and is not flagged", async () => {
    seedLegacyAppAuth();
    settings.set(SIGNUP_SETTING, "1");
    settleAppAuthUpgrade();
    expect((await settingsResponse()).signupDisabledByUpgrade).toBe(false);
    expect((await signup()).status).toBe(200);
  });
});
