import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { appAuthUsers, settings, users } from "../../src/db/queries";
import { hashPassword, warmPasswordCheck } from "../../src/auth/password";
import { newId } from "../../src/util/id";
import { peerEnv } from "../network/helpers";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let consoleEmail: string;
let appEmail: string;
let ip = 10;

beforeAll(async () => {
  md = useTempMetadata();
  app = buildApp();
  settings.set("setup_complete", "1");
  consoleEmail = `avery-${newId().slice(-6)}@example.test`;
  appEmail = `app-${newId().slice(-6)}@example.test`;
  const hash = await hashPassword("the-real-password");
  users.insert({ id: newId("u"), email: consoleEmail, passwordHash: hash, displayName: "Avery Chen", role: "admin", experienceLevel: "advanced" });
  appAuthUsers.insert({ id: newId("app_user"), email: appEmail, passwordHash: hash, displayName: null, emailConfirmed: true, status: "active" });
  await warmPasswordCheck();
});

afterAll(() => md.cleanup());

async function timed(path: string, email: string): Promise<number> {
  ip += 1;
  const started = performance.now();
  const res = await app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "a-wrong-password" }) },
    peerEnv(`10.9.8.${ip}`),
  );
  const elapsed = performance.now() - started;
  expect(res.status).toBe(401);
  return elapsed;
}

async function median(path: string, email: () => string): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) samples.push(await timed(path, email()));
  samples.sort((a, b) => a - b);
  return samples[2]!;
}

describe("SEC-09: an unknown email costs as much as a wrong password", () => {
  for (const [name, path, known] of [
    ["console login", "/api/auth/login", () => consoleEmail],
    ["App Auth token", "/api/app-auth/token", () => appEmail],
  ] as const) {
    test(name, async () => {
      const knownMs = await median(path, known);
      const unknownMs = await median(path, () => `nobody-${newId().slice(-8)}@example.test`);
      expect(knownMs).toBeGreaterThan(20);
      expect(unknownMs).toBeGreaterThan(knownMs * 0.6);
      expect(unknownMs).toBeLessThan(knownMs * 1.6);
    }, 60_000);
  }
});
