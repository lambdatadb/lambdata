import type { AppAuthSettings, AppAuthUser } from "@lambdata/shared";
import { db } from "../db/client";
import { settings } from "../db/queries";
import { LEGACY } from "../util/legacy";
import { signHs256, verifyHs256 } from "./hs256";
import { appTokenVersion, tokenVersionMatches } from "./tokenVersions";

export const APP_AUTH_ISSUER = "lambdata-app-auth";
const ACCEPTED_ISSUERS = new Set<string>([APP_AUTH_ISSUER, LEGACY.appAuthIssuer]);
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
const MIN_TOKEN_TTL_SECONDS = 300;
const MAX_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const SECRET_SETTING = "app_auth_jwt_secret";
export const SIGNUP_SETTING = "app_auth_allow_signup";
export const ISSUER_SETTING = "app_auth_issuer";
export const SIGNUP_UPGRADE_CHECKED = "app_auth_signup_upgrade_checked";
export const SIGNUP_DISABLED_BY_UPGRADE = "app_auth_signup_disabled_by_upgrade";
export const SIGNUP_REFUSED_COUNT = "app_auth_signup_refused_count";
export const SIGNUP_REFUSED_LAST_AT = "app_auth_signup_refused_last_at";

export const SIGNUP_DISABLED_MESSAGE =
  "Sign-up is disabled on this LambData server. An admin can turn it on in the LambData console under App Auth, Allow signup.";

export interface AppAuthClaims {
  sub: string;
  email: string;
  role: "authenticated";
  aud: "authenticated";
  iss: string;
  ver: number;
  iat: number;
  exp: number;
}

function clampTtl(value: number): number {
  return Math.max(MIN_TOKEN_TTL_SECONDS, Math.min(MAX_TOKEN_TTL_SECONDS, Math.floor(value)));
}

function appAuthWasUsed(): boolean {
  if (settings.get(SECRET_SETTING)) return true;
  const row = db.query("SELECT COUNT(*) AS n FROM app_auth_users").get() as { n: number } | null;
  return Number(row?.n ?? 0) > 0;
}

export function appAuthIssuer(): string {
  const stored = settings.get(ISSUER_SETTING);
  if (stored && ACCEPTED_ISSUERS.has(stored)) return stored;
  const issuer = settings.get(SECRET_SETTING) ? LEGACY.appAuthIssuer : APP_AUTH_ISSUER;
  settings.set(ISSUER_SETTING, issuer);
  return issuer;
}

export function settleAppAuthUpgrade(): void {
  appAuthIssuer();
  if (settings.get(SIGNUP_UPGRADE_CHECKED) === "1") return;
  if (settings.get(SIGNUP_SETTING) === null && appAuthWasUsed()) {
    settings.set(SIGNUP_DISABLED_BY_UPGRADE, "1");
    console.log(
      "[app-auth] App Auth sign-up is now off until an admin turns it on (it used to be on by default). Apps that let users sign up will get 403 until then.",
    );
  }
  settings.set(SIGNUP_UPGRADE_CHECKED, "1");
}

export function signupDisabledByUpgrade(): boolean {
  return settings.get(SIGNUP_DISABLED_BY_UPGRADE) === "1" && settings.get(SIGNUP_SETTING) === null;
}

export function recordRefusedSignup(): void {
  if (!signupDisabledByUpgrade()) return;
  const count = Number(settings.get(SIGNUP_REFUSED_COUNT) ?? 0);
  settings.set(SIGNUP_REFUSED_COUNT, String(Number.isFinite(count) ? count + 1 : 1));
  settings.set(SIGNUP_REFUSED_LAST_AT, String(Date.now()));
}

export function appAuthSettings(): AppAuthSettings {
  const ttlRaw = Number(settings.get("app_auth_token_ttl_seconds") ?? DEFAULT_TOKEN_TTL_SECONDS);
  const flagged = signupDisabledByUpgrade();
  const refused = Number(settings.get(SIGNUP_REFUSED_COUNT) ?? 0);
  const lastAt = Number(settings.get(SIGNUP_REFUSED_LAST_AT) ?? 0);
  return {
    allowSignup: settings.getBool(SIGNUP_SETTING, false),
    tokenTtlSeconds: Number.isFinite(ttlRaw) ? clampTtl(ttlRaw) : DEFAULT_TOKEN_TTL_SECONDS,
    issuer: appAuthIssuer(),
    signupDisabledByUpgrade: flagged,
    signupRefusedCount: flagged && Number.isFinite(refused) ? refused : 0,
    signupRefusedLastAt: flagged && Number.isFinite(lastAt) && lastAt > 0 ? lastAt : null,
  };
}

export function updateAppAuthSettings(patch: { allowSignup?: boolean; tokenTtlSeconds?: number }): AppAuthSettings {
  if (patch.allowSignup !== undefined) {
    settings.set(SIGNUP_SETTING, patch.allowSignup ? "1" : "0");
    settings.set(SIGNUP_DISABLED_BY_UPGRADE, "0");
  }
  if (patch.tokenTtlSeconds !== undefined) {
    settings.set("app_auth_token_ttl_seconds", String(clampTtl(patch.tokenTtlSeconds)));
  }
  return appAuthSettings();
}

export async function signAppAuthJwt(user: AppAuthUser): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const cfg = appAuthSettings();
  const now = Math.floor(Date.now() / 1000);
  const claims: AppAuthClaims = {
    sub: user.id,
    email: user.email,
    role: "authenticated",
    aud: "authenticated",
    iss: cfg.issuer,
    ver: appTokenVersion(user.id) ?? 0,
    iat: now,
    exp: now + cfg.tokenTtlSeconds,
  };
  return {
    accessToken: await signHs256(SECRET_SETTING, { ...claims }),
    expiresIn: cfg.tokenTtlSeconds,
  };
}

export async function verifyAppAuthJwt(token: string): Promise<AppAuthClaims | null> {
  appAuthIssuer();
  const claims = await verifyHs256(SECRET_SETTING, token);
  if (!claims || typeof claims.sub !== "string") return null;
  if (typeof claims.iss !== "string" || !ACCEPTED_ISSUERS.has(claims.iss)) return null;
  if (claims.aud !== "authenticated") return null;
  if (!tokenVersionMatches(claims.ver, appTokenVersion(claims.sub))) return null;
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    role: "authenticated",
    aud: "authenticated",
    iss: claims.iss,
    ver: typeof claims.ver === "number" ? claims.ver : 0,
    iat: typeof claims.iat === "number" ? claims.iat : 0,
    exp: claims.exp,
  };
}
