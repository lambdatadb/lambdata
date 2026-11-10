import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { homedir } from "node:os";
import { z } from "zod";
import type { DataDirMigrationResponse, SetupGate, SetupState } from "@lambdata/shared";
import { audit, settings, users } from "../db/queries";
import { hashPassword } from "../auth/password";
import { issueSessionCookie } from "../auth/jwt";
import { settleAppAuthUpgrade } from "../auth/appJwt";
import { announceSetupToken, expireSetupToken, setupTokenActive, verifySetupToken } from "../auth/setupToken";
import { isLocalRequest } from "../network/request";
import { newId } from "../util/id";
import { env } from "../env";
import { DataDirMigrationError, migrateDataDir } from "../util/dataDirMigration";
import { readPointer } from "../util/pointer";
import { clientIp, failureLimiter } from "../util/rateLimit";
import { parseJson } from "../util/validate";

export const setupRoute = new Hono();

export const SETUP_TOKEN_MISSING = "setup_token_required";
export const SETUP_TOKEN_INVALID = "setup_token_invalid";

const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

export const setupTokenFailures = failureLimiter({ windowMs: FAILURE_WINDOW_MS, max: MAX_FAILURES });

const tokenField = z.string().max(200, "setup token is too long").optional();

const dataDirSchema = z.object({
  path: z.string({ error: "path required" }).trim().min(1, "path required"),
  setupToken: tokenField,
});

const completeSchema = z.object({
  email: z.string({ error: "email and password required" }).trim().min(1, "email and password required"),
  password: z.string({ error: "email and password required" }).min(8, "password must be at least 8 characters"),
  displayName: z.string().trim().max(200, "display name is too long").nullable().optional(),
  experienceLevel: z.enum(["novice", "advanced"]).optional(),
  setupToken: tokenField,
});

const tokenSchema = z.object({ setupToken: tokenField });

function setupComplete(): boolean {
  return settings.get("setup_complete") === "1";
}

export function refuseToken(c: Context, setupToken: string | undefined): Response | null {
  if (isLocalRequest(c)) return null;
  const key = `ip:${clientIp(c)}`;
  const wait = setupTokenFailures.blockedFor(key);
  if (wait > 0) {
    return c.json(
      { error: "Too many wrong setup tokens. Wait a few minutes and try again.", code: SETUP_TOKEN_INVALID },
      429,
      { "Retry-After": String(wait) },
    );
  }
  if (!setupTokenActive()) announceSetupToken();
  const token = setupToken?.trim() ?? "";
  if (!token) {
    return c.json(
      {
        error: "Enter the setup token from the LambData log. It is printed when LambData starts, on the line that says “LambData first-run setup token”.",
        code: SETUP_TOKEN_MISSING,
      },
      403,
    );
  }
  if (!verifySetupToken(token)) {
    setupTokenFailures.fail(key);
    return c.json(
      {
        error: "That setup token is not right. Copy the most recent one from the LambData log; restarting LambData prints a new token.",
        code: SETUP_TOKEN_INVALID,
      },
      403,
    );
  }
  return null;
}

setupRoute.get("/state", (c) => {
  const needsSetup = !setupComplete();
  const local = isLocalRequest(c);
  const res: SetupState & SetupGate = {
    needsSetup,
    dataDir: needsSetup ? env.dataDir : "",
    dataDirConfigured: readPointer() !== null,
    homeDir: needsSetup && local ? homedir() : "",
    tokenRequired: needsSetup && !local,
  };
  return c.json(res);
});

setupRoute.post("/token", async (c) => {
  if (setupComplete()) {
    throw new HTTPException(409, { message: "setup already completed" });
  }
  const { setupToken } = await parseJson(c, tokenSchema);
  const refused = refuseToken(c, setupToken);
  if (refused) return refused;
  return c.json({ ok: true });
});

setupRoute.post("/data-dir", async (c) => {
  if (setupComplete()) {
    throw new HTTPException(409, { message: "setup already completed; use authenticated endpoint" });
  }
  const { path, setupToken } = await parseJson(c, dataDirSchema);
  const refused = refuseToken(c, setupToken);
  if (refused) return refused;

  try {
    const result = await migrateDataDir({ newPath: path });
    audit.log(null, "data_dir.initial", null, { path: result.newPath });
    settleAppAuthUpgrade();
    if (setupComplete()) expireSetupToken();
    const res: DataDirMigrationResponse = {
      ok: true,
      oldPath: result.oldPath,
      newPath: result.newPath,
      bytesCopied: result.bytesCopied,
      durationMs: result.durationMs,
    };
    return c.json(res);
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HTTPException(err instanceof DataDirMigrationError ? err.status : 500, { message });
  }
});

setupRoute.post("/complete", async (c) => {
  if (setupComplete()) {
    throw new HTTPException(409, { message: "setup already completed" });
  }
  const body = await parseJson(c, completeSchema);
  const refused = refuseToken(c, body.setupToken);
  if (refused) return refused;
  const passwordHash = await hashPassword(body.password);
  if (setupComplete()) {
    throw new HTTPException(409, { message: "setup already completed" });
  }
  const id = newId("u");
  const email = body.email.toLowerCase();
  users.insert({
    id,
    email,
    passwordHash,
    displayName: body.displayName || null,
    role: "admin",
    experienceLevel: body.experienceLevel ?? "advanced",
  });
  settings.set("setup_complete", "1");
  expireSetupToken();
  audit.log(id, "setup.complete", null, { email });
  await issueSessionCookie(c, id, "admin");
  return c.json({ ok: true });
});
