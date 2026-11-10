import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { functionInvocations } from "../../src/db/queries";
import { functionLimits, functionLoad, functionProcessEnv } from "../../src/functions/invoke";
import { functionDir } from "../../src/functions/service";
import { findProcesses } from "../../src/util/processes";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let owner: SeededUser;
let viewer: SeededUser;
const defaults = { ...functionLimits };

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  owner = seedUser("db_owner");
  viewer = seedUser("viewer");
});

afterAll(() => md.cleanup());

afterEach(() => {
  Object.assign(functionLimits, defaults);
});

async function call(user: SeededUser, path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers = await authHeaders(user, { "Content-Type": "application/json" });
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

let counter = 0;

async function deploy(source: string): Promise<string> {
  const name = `fb-fn-${++counter}-${Date.now().toString(36)}`;
  expect((await call(admin, "/api/functions", "POST", { name, verifyJwt: false })).status).toBe(200);
  expect((await call(admin, `/api/functions/${name}/source`, "PUT", { source })).status).toBe(200);
  return name;
}

function pgrep(pattern: string): number[] {
  return findProcesses(pattern);
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

describe("function authoring is admin-only", () => {
  const roles = () => [
    { label: "admin", user: admin, allowed: true },
    { label: "db_owner", user: owner, allowed: false },
    { label: "viewer", user: viewer, allowed: false },
  ];

  function expectStatus(res: Response, allowed: boolean, label: string): void {
    expect({ label, status: res.status }).toEqual({ label, status: allowed ? 200 : 403 });
  }

  test("create is admin-only", async () => {
    for (const { label, user, allowed } of roles()) {
      const name = `fb-create-${label.replace("_", "-")}-${Date.now().toString(36)}`;
      expectStatus(await call(user, "/api/functions", "POST", { name }), allowed, label);
      expect((await call(admin, `/api/functions/${name}`)).status).toBe(allowed ? 200 : 404);
    }
  });

  test("writing source is admin-only", async () => {
    const name = await deploy("export default () => 'original';");
    for (const { label, user, allowed } of roles()) {
      const source = `export default () => '${label}';`;
      expectStatus(await call(user, `/api/functions/${name}/source`, "PUT", { source }), allowed, label);
      const current = (await (await call(admin, `/api/functions/${name}/source`)).json()).source;
      expect(current).toBe(allowed ? source : "export default () => 'admin';");
    }
  });

  test("changing settings, including verifyJwt, is admin-only", async () => {
    const name = `fb-protected-${Date.now().toString(36)}`;
    expect((await call(admin, "/api/functions", "POST", { name, verifyJwt: true })).status).toBe(200);
    for (const { label, user, allowed } of roles().reverse()) {
      expectStatus(await call(user, `/api/functions/${name}`, "PATCH", { verifyJwt: false }), allowed, label);
      const fn = (await (await call(admin, `/api/functions/${name}`)).json()).function;
      expect({ label, verifyJwt: fn.verifyJwt }).toEqual({ label, verifyJwt: !allowed });
    }
    expect((await app.request(`/functions/v1/${name}`)).status).toBe(200);
  });

  test("delete is admin-only", async () => {
    const name = await deploy("export default () => 1;");
    for (const { label, user, allowed } of roles().reverse()) {
      expectStatus(await call(user, `/api/functions/${name}`, "DELETE"), allowed, label);
      expect((await call(admin, `/api/functions/${name}`)).status).toBe(allowed ? 404 : 200);
    }
  });

  test("secrets are admin-only", async () => {
    for (const { label, user, allowed } of roles().reverse()) {
      const secret = `FB_${label.toUpperCase()}`;
      expectStatus(await call(user, "/api/functions/secrets", "GET"), allowed, label);
      expectStatus(await call(user, "/api/functions/secrets", "POST", { name: secret, value: "v" }), allowed, label);
      expectStatus(await call(user, `/api/functions/secrets/${secret}`, "DELETE"), allowed, label);
    }
  });

  test("every role sees the list, but only admins read source and invocation logs", async () => {
    const name = await deploy("export default () => new Response('token=' + 'sk_live_example');");
    expect((await app.request(`/functions/v1/${name}`)).status).toBe(200);
    for (const { label, user, allowed } of roles()) {
      expectStatus(await call(user, "/api/functions"), true, label);
      expectStatus(await call(user, `/api/functions/${name}`), true, label);
      const source = await call(user, `/api/functions/${name}/source`);
      const logs = await call(user, `/api/functions/${name}/logs`);
      expectStatus(source, allowed, label);
      expectStatus(logs, allowed, label);
      if (allowed) {
        expect((await source.json()).source).toContain("sk_live_example");
        expect((await logs.json()).invocations.length).toBeGreaterThan(0);
      } else {
        expect((await source.json()).error).toBe(
          "Only admins can read a function's source, because it often holds keys and other secrets.",
        );
        expect((await logs.json()).error).toBe(
          "Only admins can read a function's invocation logs, because they often hold keys and other secrets.",
        );
      }
    }
    const listed = (await (await call(viewer, "/api/functions")).json()).functions.find((f: { name: string }) => f.name === name);
    expect(listed).toMatchObject({ name, invocationCount: 1 });
    expect(JSON.stringify(listed)).not.toContain("sk_live_example");
  });

  test("bodies are validated", async () => {
    expect((await call(admin, "/api/functions", "POST", { name: 5 })).status).toBe(400);
    expect((await call(admin, "/api/functions", "POST", { name: "Bad Name!" })).status).toBe(400);
    const name = await deploy("export default () => 1;");
    expect((await call(admin, "/api/functions", "POST", { name })).status).toBe(409);
    expect((await call(admin, `/api/functions/${name}/source`, "PUT", {})).status).toBe(400);
    expect((await call(admin, `/api/functions/${name}/source`, "PUT", { source: "x".repeat(512_001) })).status).toBe(400);
    expect((await call(admin, "/api/functions/missing-fn/source", "PUT", { source: "x" })).status).toBe(404);
    expect((await call(admin, "/api/functions/secrets", "POST", { name: "OK_NAME", value: "" })).status).toBe(400);
  });
});

describe("function subprocess environment", () => {
  const injected: Record<string, string> = {
    LAMBDATA_FIXES_B_SENTINEL: "api-only",
    KILNDB_FIXES_B_SENTINEL: "api-only",
    TS_AUTHKEY: "tskey-should-not-leak",
    NO_PROXY: "fixes-b.test",
    LC_MESSAGES: "C",
  };

  beforeAll(() => {
    for (const [key, value] of Object.entries(injected)) process.env[key] = value;
  });

  afterAll(() => {
    for (const key of Object.keys(injected)) delete process.env[key];
  });

  test("receives only the documented runtime variables, secrets and a minimal inherited set", async () => {
    expect((await call(admin, "/api/functions/secrets", "POST", { name: "FIXES_B_SECRET", value: "s3cret" })).status).toBe(200);
    const name = await deploy(
      "export default (req, ctx) => Response.json({ env: { ...process.env }, ctx: ctx.env, cwd: process.cwd() });",
    );
    const res = await app.request(`http://fn.test/functions/v1/${name}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { env: Record<string, string>; ctx: Record<string, string>; cwd: string };

    const runtime = {
      API_URL: "http://fn.test/api",
      FUNCTIONS_URL: "http://fn.test/functions/v1",
      FUNCTION_NAME: name,
      APP_USER_ID: "",
      APP_USER_EMAIL: "",
    };
    const expectedCtx: Record<string, string> = { FIXES_B_SECRET: "s3cret" };
    for (const [key, value] of Object.entries(runtime)) {
      expectedCtx[`LAMBDATA_${key}`] = value;
      expectedCtx[`KILNDB_${key}`] = value;
    }
    expect(body.ctx).toEqual(expectedCtx);

    const inherited = functionProcessEnv();
    expect(inherited.NO_PROXY).toBe("fixes-b.test");
    expect(inherited.LC_MESSAGES).toBe("C");
    expect(inherited.PATH).toBe(process.env.PATH!);
    expect(inherited.HOME).toBe(process.env.HOME!);
    expect(Object.keys(body.env).sort()).toEqual(Object.keys({ ...inherited, ...expectedCtx }).sort());
    expect(body.env).toMatchObject({ ...inherited, ...expectedCtx });
    expect(body.env.TS_AUTHKEY).toBeUndefined();
    expect(body.env.LAMBDATA_FIXES_B_SENTINEL).toBeUndefined();
    expect(body.env.KILNDB_FIXES_B_SENTINEL).toBeUndefined();
    expect(body.env.LAMBDATA_DATA_DIR).toBeUndefined();
    expect(realpathSync(body.cwd)).toBe(realpathSync(functionDir(name)));
  });

  test("the inherited set is an explicit allow-list", () => {
    const vars = functionProcessEnv({
      PATH: "/bin",
      HOME: "/home/x",
      TZ: "UTC",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      LAMBDATA_DATA_DIR: "/data",
      KILNDB_DATA_DIR: "/data",
      LAMBDATA_MARIADB_PORT: "3307",
      PORT: "4317",
      TS_AUTHKEY: "tskey",
      AWS_SECRET_ACCESS_KEY: "aws",
      BUN_INSTALL: "/usr/local",
    });
    expect(vars).toEqual({
      PATH: "/bin",
      HOME: "/home/x",
      TZ: "UTC",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
    });
    expect(functionProcessEnv({}).PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

describe("runaway functions", () => {
  test("a timeout kills the whole process group, grandchildren included", async () => {
    functionLimits.timeoutMs = 1_500;
    const marker = "sleep 987.25";
    const name = await deploy(
      `export default async () => { Bun.spawn(["sleep", "987.25"], { stdout: "ignore", stderr: "ignore" }); await Bun.sleep(600000); };`,
    );
    const pending = app.request(`/functions/v1/${name}`);
    expect(await waitFor(() => pgrep(marker).length > 0, 10_000)).toBe(true);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(await waitFor(() => pgrep(marker).length === 0, 3_000)).toBe(true);
  }, 30_000);

  test("a grandchild left holding the output pipe does not hang the response", async () => {
    const marker = "sleep 876.25";
    const name = await deploy(
      `export default () => { Bun.spawn(["sleep", "876.25"], { stdout: "inherit", stderr: "inherit" }).unref(); return Response.json({ ok: true }); };`,
    );
    const started = Date.now();
    const res = await app.request(`/functions/v1/${name}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await waitFor(() => pgrep(marker).length === 0, 3_000)).toBe(true);
  }, 30_000);

  test("output beyond the cap is cut off with a clear error", async () => {
    functionLimits.maxOutputBytes = 512 * 1024;
    const name = await deploy(`export default () => "x".repeat(2_000_000);`);
    const res = await app.request(`/functions/v1/${name}`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("function output exceeded");
  }, 30_000);

  test("concurrent invocations beyond the cap and queue get 503 with Retry-After", async () => {
    functionLimits.maxConcurrent = 1;
    functionLimits.maxQueued = 1;
    functionLimits.queueWaitMs = 20_000;
    const name = await deploy(`export default async () => { await Bun.sleep(1200); return "done"; };`);
    const responses = await Promise.all([1, 2, 3].map(() => app.request(`/functions/v1/${name}`)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 503]);
    const rejected = responses.find((r) => r.status === 503)!;
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect((await rejected.json()).error).toContain("too many function invocations");
    expect(functionLoad()).toEqual({ running: 0, queued: 0 });
    const logged = functionInvocations.list(name, 10).map((i) => i.statusCode).sort();
    expect(logged).toEqual([200, 200, 503]);
  }, 30_000);

  test("a queued invocation that waits too long is rejected", async () => {
    functionLimits.maxConcurrent = 1;
    functionLimits.maxQueued = 4;
    functionLimits.queueWaitMs = 150;
    const name = await deploy(`export default async () => { await Bun.sleep(1500); return "done"; };`);
    const [first, second] = await Promise.all([app.request(`/functions/v1/${name}`), app.request(`/functions/v1/${name}`)]);
    expect([first!.status, second!.status].sort()).toEqual([200, 503]);
    expect(functionLoad()).toEqual({ running: 0, queued: 0 });
  }, 30_000);
});

describe("function request body limit", () => {
  test("declared and streamed bodies over 10 MB get 413", async () => {
    const name = await deploy(`export default async (req) => String((await req.arrayBuffer()).byteLength);`);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const declared = await app.request(`/functions/v1/${name}`, { method: "POST", body: big });
    expect(declared.status).toBe(413);
    expect((await declared.json()).error).toContain("10 MB");

    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 11 * 1024 * 1024) return controller.close();
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const streamed = await app.request(`/functions/v1/${name}`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(functionLoad()).toEqual({ running: 0, queued: 0 });

    const ok = await app.request(`/functions/v1/${name}`, { method: "POST", body: new Uint8Array(1024) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1024");
  }, 30_000);
});
