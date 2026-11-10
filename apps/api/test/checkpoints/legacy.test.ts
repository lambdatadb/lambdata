import {
  checksums,
  codeObjectsOf,
  exec,
  makeDatabase,
  mariadbAvailable,
  populateRich,
  rootQuery,
  setup,
  type Fixture,
} from "./helpers";
import { testTmpRoot } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../../src/env";
import { checkpoints, databases, snapshots } from "../../src/db/queries";
import { convertLegacySnapshots, legacyCheckpointId } from "../../src/checkpoints/startup";
import { getWorkingCopyStatus, restoreCheckpoint } from "../../src/checkpoints";
import { checkpointDownloadStream } from "../../src/checkpoints/download";
import { readObjectText } from "../../src/checkpoints/store";
import { dumpStream, localAdminTarget } from "../../src/mariadb/process";
import { newId } from "../../src/util/id";

const FIXTURE_DIR = process.env.LAMBDATA_TEST_LEGACY_FIXTURE_DIR ?? "";
const FIXTURE = FIXTURE_DIR ? join(FIXTURE_DIR, "fixture.tgz") : "";
const MANIFEST = FIXTURE_DIR ? join(FIXTURE_DIR, "manifest.json") : "";

async function legacyDump(schema: string): Promise<Uint8Array> {
  const dump = dumpStream(await localAdminTarget(), schema, [
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--databases",
  ]);
  const [bytes] = await Promise.all([new Response(dump.stdout).bytes(), dump.done]);
  return bytes;
}

function addSnapshot(databaseId: string, bytes: Uint8Array, createdAt: number, trigger: "manual" | "scheduled", storedPath?: string) {
  mkdirSync(env.snapshotsDir, { recursive: true });
  const file = join(env.snapshotsDir, `${databaseId}_${createdAt}.sql`);
  writeFileSync(file, bytes);
  const id = newId("snap");
  snapshots.insert({ id, databaseId, filePath: storedPath ?? file, sizeBytes: bytes.length, createdAt, trigger });
  return { id, file };
}

async function gunzip(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const proc = Bun.spawn(["gunzip", "-c"], { stdin: new Uint8Array(await new Response(stream).arrayBuffer()), stdout: "pipe" });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  expect(await proc.exited).toBe(0);
  return out;
}

describe.skipIf(!mariadbAvailable())("legacy snapshots", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("a small hand-made legacy file converts byte for byte and restores by filtering CREATE DATABASE and USE", async () => {
    const { database } = await makeDatabase(fx.owner);
    const original = [
      "-- MariaDB dump 10.19",
      "/*!40101 SET NAMES utf8mb4 */;",
      "/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;",
      "",
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `old_name` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
      "",
      "USE `old_name`;",
      "DROP TABLE IF EXISTS `notes`;",
      "CREATE TABLE `notes` (`id` int NOT NULL, `body` text, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
      "INSERT INTO `notes` VALUES (1,'hello 😀'),(2,'USE `nothing`; inside a string');",
      "DELIMITER ;;",
      "/*!50003 CREATE*/ /*!50003 TRIGGER `notes_bi` BEFORE INSERT ON `notes` FOR EACH ROW SET NEW.body = CONCAT('>', NEW.body) */;;",
      "DELIMITER ;",
      "/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;",
      "",
    ].join("\n");
    const bytes = new TextEncoder().encode(original);
    const createdAt = Date.UTC(2026, 10, 9, 21, 33, 45);
    const snap = addSnapshot(database.id, bytes, createdAt, "manual", `/somewhere/else/snapshots/${database.id}_${createdAt}.sql`);

    const result = await convertLegacySnapshots();
    expect(result.converted).toBeGreaterThanOrEqual(1);
    expect(snapshots.byId(snap.id)).toBeNull();
    expect(existsSync(snap.file)).toBe(false);
    const cp = checkpoints.byId(legacyCheckpointId(snap.id))!;
    expect(cp).toMatchObject({
      format: "legacy",
      trigger: "legacy",
      createdAt,
      treeHash: null,
      message: "Snapshot from 2026-11-09 21:33:45 UTC",
      logicalBytes: bytes.length,
      isBase: true,
    });
    const [entry] = checkpoints.entries(cp.id);
    expect(entry!.kind).toBe("legacy");
    expect(await readObjectText(database.id, entry!.objectHash)).toBe(original);
    expect(await gunzip(checkpointDownloadStream(database.name, cp, checkpoints.entries(cp.id)))).toEqual(bytes);
    expect((await getWorkingCopyStatus(database.id)).state).toBe("unknown");

    await exec(database.name, "CREATE TABLE junk (id INT)");
    const restored = await restoreCheckpoint(database.id, cp.id, { userId: null });
    expect(restored.safetyCheckpointId).not.toBeNull();
    expect(Object.keys(await checksums(database.name))).toEqual(["notes"]);
    const rows = await rootQuery<{ body: string }>(`SELECT body FROM \`${database.name}\`.notes ORDER BY id`);
    expect(rows.map((r) => r.body)).toEqual(["hello 😀", "USE `nothing`; inside a string"]);
    expect(await codeObjectsOf(database.name)).toEqual(["trigger:notes_bi"]);
    const schemas = await rootQuery<{ n: string }>("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'old_name'");
    expect(schemas).toEqual([]);
  }, 240_000);

  test("real legacy dumps convert, keep their order and triggers, restore exactly and are idempotent", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const sumsA = await checksums(database.name);
    const codeA = await codeObjectsOf(database.name);
    const dumpA = await legacyDump(database.name);
    await exec(database.name, "UPDATE players SET score = 99", "INSERT INTO settings VALUES ('later', 'x')");
    const sumsB = await checksums(database.name);
    const dumpB = await legacyDump(database.name);
    const t0 = Date.now() - 3 * 86_400_000;
    const a = addSnapshot(database.id, dumpA, t0, "scheduled");
    const b = addSnapshot(database.id, dumpB, t0 + 3_600_000, "manual");
    const missing = newId("snap");
    snapshots.insert({ id: missing, databaseId: database.id, filePath: "/nowhere/x.sql", sizeBytes: 1, createdAt: t0, trigger: "manual" });

    const first = await convertLegacySnapshots();
    expect(first.dropped).toBeGreaterThanOrEqual(1);
    expect(snapshots.listAll().filter((s) => s.databaseId === database.id)).toEqual([]);
    const cpA = checkpoints.byId(legacyCheckpointId(a.id))!;
    const cpB = checkpoints.byId(legacyCheckpointId(b.id))!;
    expect(cpA.trigger).toBe("scheduled");
    expect(cpB.trigger).toBe("legacy");
    expect(cpB.parentId).toBe(cpA.id);
    expect(cpA.parentId).toBeNull();
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(cpB.id);

    writeFileSync(b.file, dumpB);
    const again = await convertLegacySnapshots();
    expect(again).toEqual({ converted: 0, dropped: 0, failed: 0 });
    expect(existsSync(b.file)).toBe(false);
    expect(checkpoints.listForDatabase(database.id).length).toBe(2);

    await restoreCheckpoint(database.id, cpA.id, { userId: null });
    expect(await checksums(database.name)).toEqual(sumsA);
    expect(await codeObjectsOf(database.name)).toEqual(codeA);
    await restoreCheckpoint(database.id, cpB.id, { userId: null });
    expect(await checksums(database.name)).toEqual(sumsB);
    expect(await codeObjectsOf(database.name)).toEqual(codeA);
  }, 240_000);

  test("a snapshot file outside the data directory is converted but never deleted", async () => {
    const { database } = await makeDatabase(fx.owner);
    const outside = join(testTmpRoot(), `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    const file = join(outside, `${database.id}_123.sql`);
    writeFileSync(file, "CREATE TABLE `kept` (id INT);\n");
    const id = newId("snap");
    snapshots.insert({ id, databaseId: database.id, filePath: file, sizeBytes: 29, createdAt: 123, trigger: "manual" });
    await convertLegacySnapshots();
    expect(snapshots.byId(id)).toBeNull();
    expect(checkpoints.byId(legacyCheckpointId(id))!.format).toBe("legacy");
    expect(existsSync(file)).toBe(true);
  }, 60_000);

  test.skipIf(!existsSync(FIXTURE) || !existsSync(MANIFEST))(
    "the fixture install's snapshots convert and restore to the recorded checksums",
    async () => {
      const dir = join(testTmpRoot(), `fixture-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const tar = Bun.spawn(["tar", "-xzf", FIXTURE, "-C", dir, "data/snapshots", "data/metadata.sqlite"], { stderr: "pipe" });
      expect(await tar.exited).toBe(0);
      const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
        snapshots: { id: string; databaseName: string; fileName: string; sha256: string; createdAt: number; triggerAfterFixup: string; captures: string }[];
        schemas: Record<string, { tables: Record<string, { rowCount: number; checksumTableExtended: number }> }>;
      };
      const current = manifest.snapshots.find((s) => s.captures.startsWith("kiln_primary current"))!;
      const { database } = await makeDatabase(fx.owner);
      const file = join(dir, "data/snapshots", current.fileName);
      const bytes = new Uint8Array(readFileSync(file));
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(current.sha256);
      mkdirSync(env.snapshotsDir, { recursive: true });
      const relocated = join(env.snapshotsDir, current.fileName);
      copyFileSync(file, relocated);
      const id = newId("snap");
      snapshots.insert({
        id,
        databaseId: database.id,
        filePath: `/old/install/data/snapshots/${current.fileName}`,
        sizeBytes: bytes.length,
        createdAt: current.createdAt,
        trigger: current.triggerAfterFixup as "manual",
      });
      await convertLegacySnapshots();
      expect(existsSync(relocated)).toBe(false);
      const cp = checkpoints.byId(legacyCheckpointId(id))!;
      expect(cp.format).toBe("legacy");
      const entry = checkpoints.entries(cp.id)[0]!;
      expect(entry.objectHash).toBe(current.sha256);
      expect(await gunzip(checkpointDownloadStream(database.name, cp, checkpoints.entries(cp.id)))).toEqual(bytes);

      await restoreCheckpoint(database.id, cp.id, { userId: null });
      const expected = manifest.schemas.kiln_primary!.tables;
      const got = await rootQuery<{ Table: string; Checksum: number }>(
        `CHECKSUM TABLE ${Object.keys(expected).map((t) => `\`${database.name}\`.\`${t}\``).join(", ")} EXTENDED`,
      );
      for (const [name, t] of Object.entries(expected)) {
        const row = got.find((g) => g.Table === `${database.name}.${name}`)!;
        expect(Number(row.Checksum)).toBe(t.checksumTableExtended);
        const [count] = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${database.name}\`.\`${name}\``);
        expect(Number(count!.n)).toBe(t.rowCount);
      }
      const code = await codeObjectsOf(database.name);
      expect(code.some((c) => c.startsWith("view:"))).toBe(true);
      expect(code.some((c) => c.startsWith("trigger:"))).toBe(true);
      expect(code.some((c) => c.startsWith("procedure:"))).toBe(true);
    },
    240_000,
  );
});
