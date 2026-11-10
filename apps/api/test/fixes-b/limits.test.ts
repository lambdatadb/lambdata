import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Job } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { databases, imports } from "../../src/db/queries";
import { env } from "../../src/env";
import { startJob, waitForJob } from "../../src/jobs";
import { startScheduledCheckpoint } from "../../src/checkpoints/scheduler";
import { storageRoute, storageTooLargeMessage } from "../../src/routes/storage";
import {
  assertCheckpointPolicyAllowed,
  checkpointCeilings,
  diskFloorBytes,
  diskProbe,
  parseByteSize,
  type VolumeSpace,
} from "../../src/util/disk";
import { newId } from "../../src/util/id";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const realSpace = diskProbe.space;
const ENV_KEYS = [
  "LAMBDATA_DISK_FLOOR",
  "LAMBDATA_DISK_WARN",
  "LAMBDATA_IMPORT_MAX_BYTES",
  "LAMBDATA_IMPORT_MAX_PENDING_UPLOADS",
  "LAMBDATA_IMPORT_MAX_PENDING_BYTES",
  "LAMBDATA_CHECKPOINT_MAX_RETENTION",
  "LAMBDATA_CHECKPOINT_MIN_INTERVAL_HOURS",
];

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;

function setSpace(freeBytes: number | (() => number), totalBytes = 500 * GB): void {
  diskProbe.space = (): VolumeSpace => ({ freeBytes: typeof freeBytes === "function" ? freeBytes() : freeBytes, totalBytes });
}

function floorMessage(action: string, free: string, extra = ""): string {
  const why = extra ? `the data volume has ${free} free, and ${extra}, below the 5 GB floor` : `the data volume has ${free} free, below the 5 GB floor`;
  return `Not enough disk space to ${action}: ${why} that LambData keeps free so MariaDB can keep running. Free some space (old checkpoints, pending uploads, files in Storage) or ask an admin to; the floor is set with LAMBDATA_DISK_FLOOR.`;
}

async function sendUpload(user: SeededUser, body: BodyInit, opts: { name?: string; length?: number } = {}): Promise<Response> {
  const extra: Record<string, string> = { "X-File-Name": opts.name ?? "dump.sql", "Content-Type": "application/octet-stream" };
  if (opts.length !== undefined) extra["Content-Length"] = String(opts.length);
  return app.request("/api/imports/uploads", { method: "POST", headers: await authHeaders(user, extra), body, duplex: "half" } as RequestInit);
}

function sqlStream(totalBytes: number, chunkBytes = MB): ReadableStream<Uint8Array> {
  let sent = 0;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const chunk = new Uint8Array(Math.min(chunkBytes, totalBytes - sent)).fill(0x20);
      if (sent === 0) chunk.set(encoder.encode("CREATE TABLE t (id INT);\n"));
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

function importFiles(): string[] {
  return existsSync(env.importsDir) ? readdirSync(env.importsDir) : [];
}

function insertDatabase(displayName: string, ownerUserId: string): string {
  const id = newId("db");
  databases.insert({
    id,
    name: id,
    displayName,
    ownerUserId,
    kind: "standard",
    mysqlUser: `ld_${id.slice(-8)}`,
    mysqlPasswordEnc: "enc",
    connectionsFrom: "%",
    tailscaleExposed: false,
    lanExposed: true,
  });
  return id;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
});

afterAll(() => md.cleanup());

afterEach(() => {
  diskProbe.space = realSpace;
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("sizes and the default floor", () => {
  test("sizes accept plain bytes and binary units", () => {
    expect(parseByteSize("5GB")).toBe(5 * GB);
    expect(parseByteSize("1.5 g")).toBe(1.5 * GB);
    expect(parseByteSize("500MiB")).toBe(500 * MB);
    expect(parseByteSize("2147483648")).toBe(2 * GB);
    expect(parseByteSize("0")).toBe(0);
    expect(parseByteSize("lots")).toBeNull();
    expect(parseByteSize("-1")).toBeNull();
  });

  test("the floor is 5 GB, or 10% of a small volume, or what LAMBDATA_DISK_FLOOR says", () => {
    expect(diskFloorBytes(2000 * GB)).toBe(5 * GB);
    expect(diskFloorBytes(20 * GB)).toBe(2 * GB);
    expect(diskFloorBytes(null)).toBe(5 * GB);
    process.env.LAMBDATA_DISK_FLOOR = "12GB";
    expect(diskFloorBytes(20 * GB)).toBe(12 * GB);
    process.env.LAMBDATA_DISK_FLOOR = "0";
    expect(diskFloorBytes(20 * GB)).toBe(0);
  });
});

describe("free-space floor", () => {
  test("an upload is refused below the floor, whether or not it declares its length", async () => {
    const owner = seedUser("db_owner");
    setSpace(4.1 * GB);
    const before = importFiles();
    const streamed = await sendUpload(owner, sqlStream(1000));
    expect(streamed.status).toBe(507);
    expect((await json(streamed)).error).toBe(floorMessage("accept this upload", "4.1 GB"));
    setSpace(5.5 * GB);
    const declared = await sendUpload(owner, "CREATE TABLE t (id INT);", { length: 1024 * MB });
    expect(declared.status).toBe(507);
    expect((await json(declared)).error).toBe(floorMessage("accept this upload", "5.5 GB", "1 GB more would leave 4.5 GB"));
    expect(importFiles()).toEqual(before);
    setSpace(6 * GB);
    const ok = await sendUpload(owner, "CREATE TABLE t (id INT);");
    expect(ok.status).toBe(201);
  });

  test("an upload that would cross the floor while streaming stops and leaves nothing behind", async () => {
    const owner = seedUser("db_owner");
    let calls = 0;
    setSpace(() => (++calls === 1 ? 5.2 * GB : 4.9 * GB));
    const before = importFiles();
    const rows = imports.uploadIds().size;
    const res = await sendUpload(owner, sqlStream(40 * MB));
    expect(res.status).toBe(507);
    expect((await json(res)).error).toBe(floorMessage("accept this upload", "4.9 GB"));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(importFiles()).toEqual(before);
    expect(imports.uploadIds().size).toBe(rows);
  });

  test("importing an upload into a database is refused below the floor before anything is created", async () => {
    const owner = seedUser("db_owner");
    const up = await sendUpload(owner, "CREATE TABLE t (id INT);");
    const uploadId = ((await json(up)).upload as { id: string }).id;
    const count = databases.list().length;
    setSpace(3 * GB);
    const create = await app.request(`/api/imports/uploads/${uploadId}/create-database`, {
      method: "POST",
      headers: await authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ displayName: "Imported" }),
    });
    expect(create.status).toBe(507);
    expect((await json(create)).error).toBe(floorMessage("import this file", "3 GB"));
    expect(databases.list().length).toBe(count);
    const target = insertDatabase("Target", owner.id);
    const replace = await app.request(`/api/databases/${target}/imports`, {
      method: "POST",
      headers: await authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ uploadId }),
    });
    expect(replace.status).toBe(507);
    expect((await json(replace)).error).toBe(floorMessage("import this file", "3 GB"));
  });

  test("storing a file in Storage is refused below the floor", async () => {
    const owner = seedUser("db_owner");
    const created = await app.request("/api/storage/buckets", {
      method: "POST",
      headers: await authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: `limits-${Date.now().toString(36)}` }),
    });
    const bucketId = ((await json(created)).bucket as { id: string }).id;
    setSpace(4 * GB);
    const form = new FormData();
    form.append("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    const res = await app.request(`/api/storage/buckets/${bucketId}/objects`, { method: "POST", headers: await authHeaders(owner), body: form });
    expect(res.status).toBe(507);
    expect((await json(res)).error).toBe(floorMessage("store this file", "4 GB"));
    setSpace(100 * GB);
    const form2 = new FormData();
    form2.append("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    const ok = await app.request(`/api/storage/buckets/${bucketId}/objects`, { method: "POST", headers: await authHeaders(owner), body: form2 });
    expect(ok.status).toBe(200);
  });

  test("checkpoints, rollbacks and syncs do not start below the floor; scheduled ones are skipped too", async () => {
    const owner = seedUser("db_owner");
    const id = insertDatabase("Ledger", owner.id);
    setSpace(4.4 * GB);
    const res = await app.request(`/api/databases/${id}/checkpoints`, {
      method: "POST",
      headers: await authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ message: "before the change" }),
    });
    expect(res.status).toBe(507);
    expect((await json(res)).error).toBe(floorMessage("create a checkpoint", "4.4 GB"));
    expect(() => startScheduledCheckpoint(id)).toThrow(floorMessage("create a checkpoint", "4.4 GB"));
    expect(() => startJob({ kind: "checkpoint.restore", databaseId: id, userId: owner.id }, async () => null)).toThrow(
      "Not enough disk space to roll back to a checkpoint (it first saves a checkpoint and loads a full copy)",
    );
    expect(() => startJob({ kind: "sync.run", databaseId: id, userId: null }, async () => null)).toThrow(
      "Not enough disk space to sync this mirror (it loads a full copy of the source)",
    );
    const imported = startJob({ kind: "import.sql", databaseId: null, userId: null }, async () => null);
    expect((await waitForJob(imported.id))?.status).toBe("succeeded");
  });

  test("between the floor and twice the floor, jobs start with a plain warning", async () => {
    const owner = seedUser("db_owner");
    const id = insertDatabase("Notes", owner.id);
    setSpace(8.2 * GB);
    const job = startJob({ kind: "checkpoint.create", databaseId: id, userId: owner.id }, async () => null);
    const done = (await waitForJob(job.id)) as Job;
    expect(done.status).toBe("succeeded");
    expect(done.warnings).toEqual([
      "Disk space is running low: 8.2 GB free on the data volume. Below 5 GB LambData stops accepting uploads, files in Storage, Data API inserts and updates, checkpoints and syncs so that MariaDB keeps running.",
    ]);
    setSpace(50 * GB);
    const calm = startJob({ kind: "checkpoint.create", databaseId: id, userId: owner.id }, async () => null);
    expect(((await waitForJob(calm.id)) as Job).warnings).toEqual([]);
  });

  test("LAMBDATA_DISK_FLOOR=0 turns the floor off", async () => {
    const owner = seedUser("db_owner");
    process.env.LAMBDATA_DISK_FLOOR = "0";
    setSpace(100 * MB);
    expect((await sendUpload(owner, "CREATE TABLE t (id INT);")).status).toBe(201);
  });
});

describe("uploads waiting to be imported, per person", () => {
  test("a db_owner can hold a limited number of uploads; admins are not limited", async () => {
    process.env.LAMBDATA_IMPORT_MAX_PENDING_UPLOADS = "2";
    const owner = seedUser("db_owner");
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await sendUpload(owner, "CREATE TABLE t (id INT);");
      expect(res.status).toBe(201);
      ids.push(((await json(res)).upload as { id: string }).id);
    }
    const third = await sendUpload(owner, "CREATE TABLE t (id INT);");
    expect(third.status).toBe(429);
    expect((await json(third)).error).toBe(
      "You already have 2 uploads waiting to be imported (48 bytes in all), the most one person can have at a time. Import or delete one you no longer need, or wait: the oldest is removed automatically in about 24 hours.",
    );
    for (let i = 0; i < 3; i++) expect((await sendUpload(admin, "CREATE TABLE t (id INT);")).status).toBe(201);
    const del = await app.request(`/api/imports/uploads/${ids[0]}`, { method: "DELETE", headers: await authHeaders(owner) });
    expect(del.status).toBe(200);
    expect((await sendUpload(owner, "CREATE TABLE t (id INT);")).status).toBe(201);
  });

  test("the total size of a person's waiting uploads is capped, declared or not", async () => {
    process.env.LAMBDATA_IMPORT_MAX_PENDING_BYTES = "100KB";
    const owner = seedUser("db_owner");
    expect((await sendUpload(owner, sqlStream(60 * 1024))).status).toBe(201);
    const before = importFiles();
    const streamed = await sendUpload(owner, sqlStream(60 * 1024));
    expect(streamed.status).toBe(429);
    expect((await json(streamed)).error).toBe(
      "This upload would bring your uploads waiting to be imported to more than 100 KB, the most one person can have at a time (you have 60 KB in 1 upload). Import or delete one you no longer need, or wait: the oldest is removed automatically in about 24 hours.",
    );
    const declared = await sendUpload(owner, "CREATE TABLE t (id INT);", { length: 60 * 1024 });
    expect(declared.status).toBe(429);
    expect((await json(declared)).error).toStartWith("This 60 KB file would bring your uploads waiting to be imported to more than 100 KB");
    expect(importFiles()).toEqual(before);
  });

  test("by default a person can hold five uploads and twice the per-file limit", async () => {
    const res = await app.request("/api/settings", { headers: await authHeaders(admin) });
    const limits = (await json(res)).limits as Record<string, number>;
    expect(limits.importMaxPendingUploads).toBe(5);
    expect(limits.importMaxBytes).toBe(2 * GB);
    expect(limits.importMaxPendingBytes).toBe(4 * GB);
  });
});

describe("import limits endpoint", () => {
  test("GET /api/imports/limits reports the per-file limit to every signed-in role", async () => {
    for (const role of ["admin", "db_owner", "viewer"] as const) {
      const res = await app.request("/api/imports/limits", { headers: await authHeaders(seedUser(role)) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ maxUploadBytes: 2 * GB });
    }
    process.env.LAMBDATA_IMPORT_MAX_BYTES = "500MB";
    expect(await (await app.request("/api/imports/limits", { headers: await authHeaders(admin) })).json()).toEqual({
      maxUploadBytes: 500 * MB,
    });
    expect((await app.request("/api/imports/limits")).status).toBe(401);
  });

  test("an oversize import says what to do", async () => {
    process.env.LAMBDATA_IMPORT_MAX_BYTES = "200000";
    const owner = seedUser("db_owner");
    const message =
      "The file is larger than the 195 KB import limit. A SQL dump can be uploaded gzip-compressed (.sql.gz); otherwise ask an admin to raise LAMBDATA_IMPORT_MAX_BYTES.";
    const streamed = await sendUpload(owner, sqlStream(400_000, 64 * 1024));
    expect(streamed.status).toBe(413);
    expect((await json(streamed)).error).toBe(message);
    const declared = await sendUpload(owner, "CREATE TABLE t (id INT);", { length: 400_000 });
    expect(declared.status).toBe(413);
    expect((await json(declared)).error).toBe(message);
  });
});

describe("oversize files in Storage", () => {
  test("a declared length over the limit gets the same 413 and message as a streamed one", async () => {
    const bare = new Hono();
    bare.route("/api/storage", storageRoute);
    bare.onError((err, c) =>
      err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500),
    );
    const owner = seedUser("db_owner");
    const created = await app.request("/api/storage/buckets", {
      method: "POST",
      headers: await authHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: `big-${Date.now().toString(36)}` }),
    });
    const bucketId = ((await json(created)).bucket as { id: string }).id;
    const res = await bare.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(owner, { "Content-Type": "multipart/form-data; boundary=zz", "Content-Length": String(300 * MB) }),
      body: `--zz\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\nabc\r\n--zz--\r\n`,
    });
    expect(res.status).toBe(413);
    expect((await json(res)).error).toBe(storageTooLargeMessage());
    expect(storageTooLargeMessage()).toBe("The file is larger than the 250 MB limit for files in Storage.");
  });
});

describe("checkpoint retention ceilings", () => {
  const current = { autoIntervalHours: 24, autoRetention: 7 };

  test("defaults: keep at most 30, run at most hourly; admins are not bound", () => {
    expect(checkpointCeilings()).toEqual({ maxAutoRetention: 30, minIntervalHours: 1 });
    expect(() => assertCheckpointPolicyAllowed({ role: "db_owner", next: { autoIntervalHours: 1, autoRetention: 30 }, current })).not.toThrow();
    expect(() => assertCheckpointPolicyAllowed({ role: "db_owner", next: { autoIntervalHours: 24, autoRetention: 1000 }, current })).toThrow(
      "This server keeps at most 30 automatic checkpoints per database, and 1000 were requested. Choose 30 or fewer, or ask an admin to raise the limit in Settings.",
    );
    expect(() => assertCheckpointPolicyAllowed({ role: "admin", next: { autoIntervalHours: 1, autoRetention: 1000 }, current })).not.toThrow();
  });

  test("a value set before the ceiling existed can be kept while other fields change", () => {
    const old = { autoIntervalHours: 1, autoRetention: 500 };
    expect(() => assertCheckpointPolicyAllowed({ role: "db_owner", next: { autoIntervalHours: 1, autoRetention: 500 }, current: old })).not.toThrow();
    expect(() => assertCheckpointPolicyAllowed({ role: "db_owner", next: { autoIntervalHours: 1, autoRetention: 600 }, current: old })).toThrow();
  });

  test("admins set the ceilings in Settings; env provides the default; null goes back to it", async () => {
    const owner = seedUser("db_owner");
    const patch = async (user: SeededUser, body: unknown) =>
      app.request("/api/settings", {
        method: "PATCH",
        headers: await authHeaders(user, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
    expect((await patch(owner, { checkpointMinIntervalHours: 6 })).status).toBe(403);
    expect((await patch(admin, { checkpointMinIntervalHours: 0 })).status).toBe(400);
    const res = await patch(admin, { checkpointMinIntervalHours: 6, checkpointMaxAutoRetention: 14 });
    expect(res.status).toBe(200);
    expect((await json(res)).limits).toMatchObject({ checkpointMinIntervalHours: 6, checkpointMaxAutoRetention: 14 });
    expect(() => assertCheckpointPolicyAllowed({ role: "db_owner", next: { autoIntervalHours: 1, autoRetention: 7 }, current })).toThrow(
      "Automatic checkpoints can run at most every 6 hours on this server, and every hour was requested. Choose a longer interval, or ask an admin to lower the minimum in Settings.",
    );
    expect(() => assertCheckpointPolicyAllowed({ role: "db_owner", next: { autoIntervalHours: 0, autoRetention: 7 }, current })).not.toThrow();
    expect(() => assertCheckpointPolicyAllowed({ role: "db_owner", next: { autoIntervalHours: 6, autoRetention: 14 }, current })).not.toThrow();
    process.env.LAMBDATA_CHECKPOINT_MAX_RETENTION = "12";
    process.env.LAMBDATA_CHECKPOINT_MIN_INTERVAL_HOURS = "2";
    expect(checkpointCeilings()).toEqual({ maxAutoRetention: 14, minIntervalHours: 6 });
    expect((await patch(admin, { checkpointMinIntervalHours: null, checkpointMaxAutoRetention: null })).status).toBe(200);
    expect(checkpointCeilings()).toEqual({ maxAutoRetention: 12, minIntervalHours: 2 });
    const viewerView = await app.request("/api/settings", { headers: await authHeaders(seedUser("viewer")) });
    expect((await json(viewerView)).limits).toMatchObject({ checkpointMaxAutoRetention: 12, checkpointMinIntervalHours: 2 });
  });
});
