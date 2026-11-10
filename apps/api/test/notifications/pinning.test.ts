import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { testRoot } from "../harness/isolate";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { NotificationDestinationResponse, NotificationTestResponse } from "@lambdata/shared";
import { buildApp } from "../../src/server";
import { notificationsService } from "../../src/notifications/service";
import { clearNotifications, extraTls, FakeDestination, installFakeNetwork, json, restoreFakeNetwork, routes, transportCalls } from "./helpers";

const openssl = Bun.which("openssl");

async function selfSigned(dir: string, name: string): Promise<{ cert: string; key: string }> {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  const proc = Bun.spawn(
    [openssl!, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await proc.exited) !== 0) throw new Error("openssl failed");
  return { cert: await Bun.file(cert).text(), key: await Bun.file(key).text() };
}

describe("send-time connections are pinned to the checked address", () => {
  let meta: TempMetadata;
  let app: ReturnType<typeof buildApp>;
  let admin: SeededUser;
  let plain: FakeDestination;
  let secure: ReturnType<typeof Bun.serve> | null = null;
  const secureSeen: { host: string | null; path: string }[] = [];

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(admin, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function webhook(url: string) {
    return (
      await json<NotificationDestinationResponse>(
        await call("POST", "/api/notifications/destinations", { kind: "webhook", name: "Pinned", events: [], config: { url } }),
        201,
      )
    ).destination;
  }

  async function sendTest(id: string): Promise<NotificationTestResponse> {
    return json<NotificationTestResponse>(await call("POST", `/api/notifications/destinations/${id}/test`));
  }

  beforeAll(async () => {
    meta = useTempMetadata();
    installFakeNetwork();
    plain = new FakeDestination(4366);
    if (openssl) {
      const dir = mkdtempSync(join(testRoot(), "tls-"));
      const pair = await selfSigned(dir, "secure.test");
      extraTls.ca = [pair.cert];
      secure = Bun.serve({
        port: 4367,
        hostname: "127.0.0.1",
        tls: { cert: pair.cert, key: pair.key, serverName: "secure.test" },
        fetch(req) {
          secureSeen.push({ host: req.headers.get("host"), path: new URL(req.url).pathname });
          return new Response("ok");
        },
      });
    }
    app = buildApp();
    admin = seedUser("admin");
    await notificationsService.start();
  });

  afterAll(async () => {
    await notificationsService.stop();
    plain?.stop();
    secure?.stop(true);
    restoreFakeNetwork();
    meta?.cleanup();
  });

  beforeEach(() => {
    clearNotifications();
    plain.reset();
    transportCalls.length = 0;
    secureSeen.length = 0;
  });

  test("http: the request goes to the address that passed the check, with the original Host header", async () => {
    let lookups = 0;
    routes.set("flip.example", { addresses: () => (++lookups <= 2 ? ["127.0.0.1"] : ["169.254.169.254"]) });
    const d = await webhook("http://flip.example:4366/pinned");
    const res = await sendTest(d.id);
    expect(res.ok).toBe(true);
    expect(lookups).toBe(2);
    expect(transportCalls).toHaveLength(1);
    expect(new URL(transportCalls[0]!.url).hostname).toBe("127.0.0.1");
    expect(transportCalls[0]!.host).toBe("flip.example:4366");
    expect(transportCalls[0]!.serverName).toBeNull();
    expect(plain.requests[0]!.headers.host).toBe("flip.example:4366");
    expect(plain.requests[0]!.path).toBe("/pinned");
  });

  test("IPv4 is preferred and a literal address is used as it is", async () => {
    routes.set("dual.example", { addresses: ["::1", "127.0.0.1"] });
    const d = await webhook("http://dual.example:4366/dual");
    expect((await sendTest(d.id)).ok).toBe(true);
    expect(new URL(transportCalls[0]!.url).hostname).toBe("127.0.0.1");
    const literal = await webhook(plain.url("/literal"));
    transportCalls.length = 0;
    expect((await sendTest(literal.id)).ok).toBe(true);
    expect(transportCalls[0]!.url).toBe(plain.url("/literal"));
    expect(transportCalls[0]!.host).toBeNull();
  });

  test.skipIf(!openssl)("https: SNI and the certificate check use the original host name", async () => {
    routes.set("secure.test", { addresses: ["127.0.0.1"] });
    const d = await webhook("https://secure.test:4367/tls");
    const ok = await sendTest(d.id);
    expect(ok).toMatchObject({ ok: true, responseStatus: 200, error: null });
    expect(new URL(transportCalls[0]!.url).hostname).toBe("127.0.0.1");
    expect(transportCalls[0]!.serverName).toBe("secure.test");
    expect(secureSeen).toEqual([{ host: "secure.test:4367", path: "/tls" }]);

    routes.set("impostor.test", { addresses: ["127.0.0.1"] });
    const wrong = await webhook("https://impostor.test:4367/tls");
    const refused = await sendTest(wrong.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("TLS certificate problem");
    expect(secureSeen).toHaveLength(1);
  });
});
