import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { homedir } from "node:os";
import type { ExperienceLevel, SetupState, DataDirMigrationResponse } from "@kilndb/shared";
import { audit, settings, users } from "../db/queries";
import { hashPassword } from "../auth/password";
import { COOKIE_MAX_AGE, COOKIE_NAME, signJwt } from "../auth/jwt";
import { newId } from "../util/id";
import { env } from "../env";
import { migrateDataDir } from "../util/dataDirMigration";
import { readPointer } from "../util/pointer";

export const setupRoute = new Hono();

setupRoute.get("/state", (c) => {
  const res: SetupState = {
    needsSetup: settings.get("setup_complete") !== "1",
    dataDir: env.dataDir,
    dataDirConfigured: readPointer() !== null,
    homeDir: homedir(),
  };
  return c.json(res);
});

setupRoute.post("/data-dir", async (c) => {
  if (settings.get("setup_complete") === "1") {
    throw new HTTPException(409, { message: "setup already completed; use authenticated endpoint" });
  }
  const body = (await c.req.json()) as { path?: string };
  if (!body.path) throw new HTTPException(400, { message: "path required" });

  try {
    const result = await migrateDataDir({ newPath: body.path });
    audit.log(null, "data_dir.initial", null, { path: result.newPath });
    const res: DataDirMigrationResponse = {
      ok: true,
      oldPath: result.oldPath,
      newPath: result.newPath,
      bytesCopied: result.bytesCopied,
      durationMs: result.durationMs,
    };
    return c.json(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HTTPException(500, { message });
  }
});

setupRoute.post("/complete", async (c) => {
  if (settings.get("setup_complete") === "1") {
    throw new HTTPException(409, { message: "setup already completed" });
  }
  const body = (await c.req.json()) as {
    email?: string;
    password?: string;
    displayName?: string;
    experienceLevel?: ExperienceLevel;
  };
  if (!body.email || !body.password) {
    throw new HTTPException(400, { message: "email and password required" });
  }
  if (body.password.length < 8) {
    throw new HTTPException(400, { message: "password must be at least 8 characters" });
  }
  const level: ExperienceLevel = body.experienceLevel === "novice" ? "novice" : "advanced";
  const id = newId("u");
  users.insert({
    id,
    email: body.email.toLowerCase().trim(),
    passwordHash: await hashPassword(body.password),
    displayName: body.displayName ?? null,
    role: "admin",
    experienceLevel: level,
  });
  settings.set("setup_complete", "1");
  audit.log(id, "setup.complete", null, { email: body.email });
  const token = await signJwt(id, "admin");
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    secure: env.cookieSecure,
  });
  return c.json({ ok: true });
});
