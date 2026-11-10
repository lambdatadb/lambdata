import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { authHeaders, seedUser, type SeededUser } from "../harness/sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database, SetAsideListResponse } from "@lambdata/shared";
import { db } from "../../src/db/client";
import { provisionDatabase } from "../../src/databases/provision";
import { startJob, waitForJob } from "../../src/jobs";
import { journalDir } from "../../src/mariadb/journal";
import {
  QUARANTINE_PREFIX,
  TRASH_PREFIX,
  createStagingSchema,
  dropSchemaIfExists,
  recoverInterruptedSwaps,
  swapRecoveryPending,
  swapStagingIntoLive,
  type SwapRecoveryReport,
} from "../../src/mariadb/schemaSwap";

type SwapReport = SwapRecoveryReport & { trash: string };
import { buildApp } from "../../src/server";

describe.skipIf(!mariadbAvailable())("tables a swap set aside", () => {
  let instance: TestInstance | null = null;
  let app: ReturnType<typeof buildApp>;
  let owner: SeededUser;
  let otherOwner: SeededUser;
  let viewer: SeededUser;
  let counter = 0;

  beforeAll(async () => {
    instance = await startTestInstance();
    app = buildApp();
    owner = seedUser("db_owner");
    otherOwner = seedUser("db_owner");
    viewer = seedUser("viewer");
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  async function makeLive(): Promise<Database> {
    counter++;
    const { database } = await provisionDatabase({ displayName: `set aside ${process.pid % 1000} ${counter}`, ownerUserId: owner.id });
    const s = `\`${database.name}\``;
    await rootQuery(`CREATE TABLE ${s}.orders (id INT PRIMARY KEY, note VARCHAR(20))`);
    await rootQuery(`CREATE TABLE ${s}.other (id INT PRIMARY KEY)`);
    await rootQuery(`INSERT INTO ${s}.orders VALUES (1, 'a'), (2, 'b')`);
    await rootQuery(`INSERT INTO ${s}.other VALUES (7)`);
    return database;
  }

  async function interruptedSwap(database: Database, intrude: string[]): Promise<SwapReport> {
    const live = `\`${database.name}\``;
    const fill = async (schema: string) => {
      for (const t of ["orders", "other"]) {
        await rootQuery(`CREATE TABLE \`${schema}\`.\`${t}\` LIKE ${live}.\`${t}\``);
        await rootQuery(`INSERT INTO \`${schema}\`.\`${t}\` SELECT * FROM ${live}.\`${t}\``);
      }
    };
    const staging = await createStagingSchema(database.name);
    await fill(staging);
    let saved: { file: string; text: string } | null = null;
    await swapStagingIntoLive({
      live: database.name,
      staging,
      databaseId: database.id,
      onPhase: (phase) => {
        if (phase !== "prepared") return;
        for (const name of readdirSync(journalDir()).filter((n) => n.startsWith("swap-"))) {
          const text = readFileSync(join(journalDir(), name), "utf8");
          if (text.includes(staging)) saved = { file: name, text };
        }
        throw new Error("simulated stop just before the tables moved");
      },
    }).catch(() => {});
    if (!saved) throw new Error("the swap journal was not found");
    const { file, text } = saved as { file: string; text: string };
    const journal = JSON.parse(text) as { trash: string; staging: string };
    await rootQuery(`CREATE DATABASE \`${journal.staging}\``);
    await fill(journal.staging);
    await rootQuery(`CREATE DATABASE \`${journal.trash}\``);
    await rootQuery(`RENAME TABLE ${live}.orders TO \`${journal.trash}\`.orders, ${live}.other TO \`${journal.trash}\`.other`);
    for (const sql of intrude) await rootQuery(sql.replaceAll("$db", live));
    writeFileSync(join(journalDir(), file), text);
    return recoverInterruptedSwaps().then((report) => ({ ...report, trash: journal.trash }));
  }

  async function call(user: SeededUser, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: await authHeaders(user, { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function list(database: Database, user: SeededUser = owner): Promise<SetAsideListResponse> {
    const res = await call(user, "GET", `/api/databases/${database.id}/set-aside`);
    expect(res.status).toBe(200);
    return (await res.json()) as SetAsideListResponse;
  }

  async function ids(schema: string, table: string): Promise<number[]> {
    return (await rootQuery<{ id: number }>(`SELECT id FROM \`${schema}\`.\`${table}\` ORDER BY id`)).map((r) => Number(r.id));
  }

  async function schemaExists(name: string): Promise<boolean> {
    return (await rootQuery("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [name])).length > 0;
  }

  function audits(databaseId: string, action: string): Record<string, unknown>[] {
    const rows = db.query("SELECT details FROM audit_log WHERE target = ? AND action = ? ORDER BY id").all(databaseId, action) as { details: string }[];
    return rows.map((r) => JSON.parse(r.details) as Record<string, unknown>);
  }

  test("a quarantine is listed with its tables and moved back under a free name, a new name, never a taken one", async () => {
    const database = await makeLive();
    const report = await interruptedSwap(database, [
      "CREATE TABLE $db.orders (id INT PRIMARY KEY, note VARCHAR(20))",
      "INSERT INTO $db.orders VALUES (99, 'intruder')",
      "CREATE TABLE $db.other (id INT PRIMARY KEY)",
      "INSERT INTO $db.other VALUES (98), (97)",
    ]);
    expect(report.rolledBack).toContain(database.name);
    expect(await ids(database.name, "orders")).toEqual([1, 2]);
    expect(await schemaExists(report.trash)).toBe(false);
    const listed = await list(database);
    expect(listed.schemas).toHaveLength(1);
    const q = listed.schemas[0]!;
    expect(q.schema.startsWith(QUARANTINE_PREFIX)).toBe(true);
    expect(q.kind).toBe("quarantine");
    expect(typeof q.createdAt).toBe("number");
    expect(q.tables.map((t) => [t.name, t.rowCount, t.nameFreeInDatabase])).toEqual([
      ["orders", 1, false],
      ["other", 2, false],
    ]);
    expect(q.sizeBytes).toBeGreaterThan(0);

    const base = `/api/databases/${database.id}/set-aside/${q.schema}/move-back`;
    const taken = await call(owner, "POST", base, { table: "other" });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toContain(`${database.name} already has a table or view named other`);
    expect((await call(owner, "POST", base, { table: "other", as: "bad`name" })).status).toBe(400);
    const renamed = await call(owner, "POST", base, { table: "other", as: "other_found" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ table: "other", movedTo: "other_found", schemaRemoved: false });
    expect(await ids(database.name, "other_found")).toEqual([97, 98]);
    expect(await ids(database.name, "other")).toEqual([7]);

    await rootQuery(`CREATE TRIGGER \`${q.schema}\`.orders_touch BEFORE INSERT ON \`${q.schema}\`.orders FOR EACH ROW SET NEW.note = NEW.note`);
    await rootQuery(`RENAME TABLE \`${database.name}\`.orders TO \`${database.name}\`.orders_main`);
    expect((await list(database)).schemas[0]!.tables).toEqual([expect.objectContaining({ name: "orders", nameFreeInDatabase: true })]);
    const withTrigger = await call(owner, "POST", base, { table: "orders" });
    expect(withTrigger.status).toBe(409);
    expect(((await withTrigger.json()) as { error: string }).error).toContain("MariaDB cannot move a table with triggers into another database");
    expect(await ids(q.schema, "orders")).toEqual([99]);
    await rootQuery(`DROP TRIGGER \`${q.schema}\`.orders_touch`);
    const free = await call(owner, "POST", base, { table: "orders" });
    expect(free.status).toBe(200);
    expect(await free.json()).toEqual({ table: "orders", movedTo: "orders", schemaRemoved: true });
    expect(await ids(database.name, "orders")).toEqual([99]);
    expect(await ids(database.name, "orders_main")).toEqual([1, 2]);
    expect(await schemaExists(q.schema)).toBe(false);
    expect((await list(database)).schemas).toEqual([]);
    expect(audits(database.id, "db.set_aside.move_back").map((a) => [a.schema, a.table, a.movedTo, a.schemaRemoved])).toEqual([
      [q.schema, "other", "other_found", false],
      [q.schema, "orders", "orders", true],
    ]);
  }, 120_000);

  test("a kept original is moved back under a new name and the interrupted swap then finishes; another kept schema is deleted", async () => {
    const database = await makeLive();
    const report = await interruptedSwap(database, ["CREATE VIEW $db.orders AS SELECT 1 AS id"]);
    expect(report.failed).toContain(database.name);
    const trash = report.trash;
    expect(swapRecoveryPending(database.name)).toBe(true);
    expect(await ids(database.name, "other")).toEqual([7]);
    const listed = await list(database);
    expect(listed.schemas.map((s) => [s.schema, s.kind])).toEqual([[trash, "kept"]]);
    expect(listed.schemas[0]!.tables.map((t) => [t.name, t.rowCount, t.nameFreeInDatabase])).toEqual([["orders", 2, false]]);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const job = startJob({ kind: "sync.run", databaseId: database.id, userId: null }, () => gate);
    const blocked = await call(owner, "POST", `/api/databases/${database.id}/set-aside/${trash}/move-back`, { table: "orders", as: "orders_saved" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { jobId: string }).jobId).toBe(job.id);
    expect((await call(owner, "DELETE", `/api/databases/${database.id}/set-aside/${trash}`)).status).toBe(409);
    release();
    await waitForJob(job.id);

    const moved = await call(owner, "POST", `/api/databases/${database.id}/set-aside/${trash}/move-back`, { table: "orders", as: "orders_saved" });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ table: "orders", movedTo: "orders_saved", schemaRemoved: true });
    expect(await ids(database.name, "orders_saved")).toEqual([1, 2]);
    expect(await schemaExists(trash)).toBe(false);
    expect(swapRecoveryPending(database.name)).toBe(false);
    expect((await list(database)).schemas).toEqual([]);

    const second = await makeLive();
    const trash2 = (await interruptedSwap(second, ["CREATE VIEW $db.orders AS SELECT 1 AS id"])).trash;
    expect(swapRecoveryPending(second.name)).toBe(true);
    expect((await call(otherOwner, "GET", `/api/databases/${second.id}/set-aside`)).status).toBe(403);
    expect((await list(second, viewer)).schemas.map((s) => s.schema)).toEqual([trash2]);
    expect((await call(viewer, "POST", `/api/databases/${second.id}/set-aside/${trash2}/move-back`, { table: "orders", as: "orders_saved" })).status).toBe(403);
    expect((await call(viewer, "DELETE", `/api/databases/${second.id}/set-aside/${trash2}`)).status).toBe(403);
    expect(await schemaExists(trash2)).toBe(true);
    expect((await call(owner, "DELETE", `/api/databases/${database.id}/set-aside/${trash2}`)).status).toBe(404);
    expect(await schemaExists(trash2)).toBe(true);
    const removed = await call(owner, "DELETE", `/api/databases/${second.id}/set-aside/${trash2}`);
    expect(removed.status).toBe(204);
    expect(await schemaExists(trash2)).toBe(false);
    expect(swapRecoveryPending(second.name)).toBe(false);
    expect(audits(second.id, "db.set_aside.delete")).toEqual([
      { schema: trash2, kind: "kept", tables: [{ name: "orders", rowCount: 2 }] },
    ]);
  }, 120_000);

  test("names that are not this database's set-aside schemas are refused and left alone", async () => {
    const database = await makeLive();
    const staging = await createStagingSchema(database.name);
    const madeUp = `${QUARANTINE_PREFIX}abcdefgh_${database.name}`;
    await rootQuery(`CREATE DATABASE \`${TRASH_PREFIX}zzzzzzzz_${database.name}\``);
    try {
      for (const name of [staging, madeUp, `${TRASH_PREFIX}zzzzzzzz_${database.name}`, "mysql", "evil`name", database.name]) {
        const del = await call(owner, "DELETE", `/api/databases/${database.id}/set-aside/${encodeURIComponent(name)}`);
        expect({ name, status: del.status }).toEqual({ name, status: 404 });
        const move = await call(owner, "POST", `/api/databases/${database.id}/set-aside/${encodeURIComponent(name)}/move-back`, { table: "orders" });
        expect({ name, status: move.status }).toEqual({ name, status: 404 });
      }
      expect(await schemaExists(staging)).toBe(true);
      expect(await schemaExists(`${TRASH_PREFIX}zzzzzzzz_${database.name}`)).toBe(true);
      expect((await list(database)).schemas).toEqual([]);
    } finally {
      await dropSchemaIfExists(staging);
      await rootQuery(`DROP DATABASE IF EXISTS \`${TRASH_PREFIX}zzzzzzzz_${database.name}\``);
    }
  }, 120_000);
});
