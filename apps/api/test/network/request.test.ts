import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { useTempMetadata, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { users } from "../../src/db/queries";
import { hashPassword } from "../../src/auth/password";
import { newId } from "../../src/util/id";
import { clientIp, isSecureRequest } from "../../src/network/request";
import { saveTrustedProxies } from "../../src/network/config";
import { peerEnv } from "./helpers";

let md: TempMetadata;
const probe = new Hono();
probe.get("/probe", (c) => c.json({ ip: clientIp(c), secure: isSecureRequest(c) }));

beforeAll(() => {
  md = useTempMetadata();
});

afterAll(() => md.cleanup());

beforeEach(() => saveTrustedProxies([]));

async function look(peer: string | null, headers: Record<string, string> = {}): Promise<{ ip: string; secure: boolean }> {
  const res = await probe.request("/probe", { headers }, peerEnv(peer));
  return (await res.json()) as { ip: string; secure: boolean };
}

describe("clientIp", () => {
  test("ignores forwarded headers from an untrusted peer", async () => {
    const r = await look("192.168.1.20", {
      "X-Forwarded-For": "203.0.113.9",
      "Cf-Connecting-Ip": "203.0.113.10",
      "X-Forwarded-Proto": "https",
    });
    expect(r).toEqual({ ip: "192.168.1.20", secure: false });
  });

  test("believes a loopback proxy and walks the chain from the right", async () => {
    expect((await look("127.0.0.1", { "X-Forwarded-For": "203.0.113.9" })).ip).toBe("203.0.113.9");
    expect((await look("127.0.0.1", { "X-Forwarded-For": "1.1.1.1, 203.0.113.9" })).ip).toBe("203.0.113.9");
    expect((await look("::1", { "X-Forwarded-For": "2001:db8::5" })).ip).toBe("2001:db8::5");
    expect((await look("127.0.0.1", { "X-Forwarded-For": "garbage" })).ip).toBe("127.0.0.1");
  });

  test("uses Cf-Connecting-Ip only from a trusted peer and only without X-Forwarded-For", async () => {
    expect((await look("127.0.0.1", { "Cf-Connecting-Ip": "198.51.100.4" })).ip).toBe("198.51.100.4");
    expect((await look("10.0.0.9", { "Cf-Connecting-Ip": "198.51.100.4" })).ip).toBe("10.0.0.9");
    expect(
      (await look("127.0.0.1", { "Cf-Connecting-Ip": "198.51.100.4", "X-Forwarded-For": "198.51.100.5" })).ip,
    ).toBe("198.51.100.5");
  });

  test("honours configured trusted proxies, skipping trusted hops", async () => {
    expect((await look("172.18.0.5", { "X-Forwarded-For": "198.51.100.7" })).ip).toBe("172.18.0.5");
    saveTrustedProxies(["172.18.0.0/16"]);
    expect((await look("172.18.0.5", { "X-Forwarded-For": "198.51.100.7" })).ip).toBe("198.51.100.7");
    expect((await look("172.18.0.5", { "X-Forwarded-For": "198.51.100.7, 172.18.0.9" })).ip).toBe("198.51.100.7");
    expect((await look("::ffff:172.18.0.5", { "X-Forwarded-For": "198.51.100.8" })).ip).toBe("198.51.100.8");
  });

  test("reports an unidentifiable peer as unknown, never as loopback", async () => {
    expect((await look(null)).ip).toBe("unknown");
    expect((await look(null, { "X-Forwarded-For": "127.0.0.1" })).ip).toBe("unknown");
  });
});

describe("isSecureRequest", () => {
  test("is true for https forwarded by a trusted proxy", async () => {
    expect((await look("127.0.0.1", { "X-Forwarded-Proto": "https" })).secure).toBe(true);
    expect((await look("127.0.0.1", { "Cf-Visitor": '{"scheme":"https"}' })).secure).toBe(true);
    expect((await look("127.0.0.1", { "X-Forwarded-Proto": "http" })).secure).toBe(false);
    expect((await look("127.0.0.1")).secure).toBe(false);
  });

  test("is false when an untrusted peer claims https", async () => {
    expect((await look("192.168.1.20", { "X-Forwarded-Proto": "https" })).secure).toBe(false);
    expect((await look("192.168.1.20", { "Cf-Visitor": '{"scheme":"https"}' })).secure).toBe(false);
  });
});

describe("through the real app", () => {
  let app: ReturnType<typeof buildApp>;
  const email = `net-login-${Date.now()}@example.test`;

  beforeAll(async () => {
    app = buildApp();
    users.insert({
      id: newId("u"),
      email,
      passwordHash: await hashPassword("correct horse battery"),
      displayName: "Net",
      role: "admin",
      experienceLevel: "advanced",
    });
  });

  function login(peer: string, headers: Record<string, string>, body: Record<string, string>): Promise<Response> {
    return Promise.resolve(
      app.request(
        "/api/auth/login",
        { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
        peerEnv(peer),
      ),
    );
  }

  test("login rate limiting cannot be dodged by spoofing X-Forwarded-For from the LAN", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await login(
        "192.168.77.10",
        { "X-Forwarded-For": `203.0.113.${i + 1}` },
        { email: `spoof-${i}@example.test`, password: "wrong" },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test("clients behind a trusted proxy get their own rate-limit buckets", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await login(
        "127.0.0.1",
        { "X-Forwarded-For": `198.51.100.${i + 20}` },
        { email: `proxied-${i}@example.test`, password: "wrong" },
      );
      statuses.push(res.status);
    }
    expect(statuses.every((s) => s === 401)).toBe(true);
  });

  test("the session cookie is Secure behind an https proxy and not on plain LAN", async () => {
    const proxied = await login(
      "127.0.0.1",
      { "X-Forwarded-For": "198.51.100.99", "X-Forwarded-Proto": "https", "Cf-Ray": "abc" },
      { email, password: "correct horse battery" },
    );
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("set-cookie") ?? "").toMatch(/;\s*Secure/i);

    const lan = await login("192.168.77.11", { "X-Forwarded-Proto": "https" }, { email, password: "correct horse battery" });
    expect(lan.status).toBe(200);
    expect(lan.headers.get("set-cookie") ?? "").not.toMatch(/;\s*Secure/i);
  });
});
