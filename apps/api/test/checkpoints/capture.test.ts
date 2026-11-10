import { exec, makeDatabase, mariadbAvailable, populateRich, select, setup, type Fixture } from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createCheckpoint } from "../../src/checkpoints";
import { checkpoints, databases } from "../../src/db/queries";
import { objectPath, readObjectText } from "../../src/checkpoints/store";

function hashes(checkpointId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of checkpoints.entries(checkpointId)) out[`${e.kind}:${e.name}`] = e.objectHash;
  return out;
}

async function checkpoint(databaseId: string, allowUnchanged = true): Promise<string> {
  const r = await createCheckpoint(databaseId, { trigger: "manual", message: "test", userId: null, allowUnchanged });
  if (!r.checkpointId) throw new Error("expected a checkpoint");
  return r.checkpointId;
}

const TABLE = (name: string) =>
  `CREATE TABLE \`${name}\` (id INT PRIMARY KEY, v VARCHAR(50)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

describe.skipIf(!mariadbAvailable())("checkpoint capture", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("dumping the same data twice gives identical hashes for every entry", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const a = await checkpoint(database.id);
    const b = await checkpoint(database.id);
    expect(Object.keys(hashes(a)).sort()).toEqual(
      ["code:code", "table:audit", "table:matches", "table:players", "table:settings"].sort(),
    );
    expect(hashes(b)).toEqual(hashes(a));
    expect(checkpoints.byId(b)!.treeHash).toBe(checkpoints.byId(a)!.treeHash);
    expect(checkpoints.byId(b)!.hash).not.toBe(checkpoints.byId(a)!.hash);
    expect(checkpoints.byId(b)!.newBytes).toBe(0);
    expect(checkpoints.byId(a)!.newBytes).toBeGreaterThan(0);
    for (const h of Object.values(hashes(a))) expect(existsSync(objectPath(database.id, h))).toBe(true);
  }, 120_000);

  test("a table's hash does not depend on other tables, its position, or being last", async () => {
    const one = (await makeDatabase(fx.owner)).database;
    const two = (await makeDatabase(fx.owner)).database;
    await exec(
      one.name,
      TABLE("b_mid"),
      TABLE("a_first"),
      TABLE("z_last"),
      "INSERT INTO b_mid VALUES (1, 'mid'), (2, 'mid2')",
      "INSERT INTO a_first VALUES (1, 'first')",
      "INSERT INTO z_last VALUES (1, 'last')",
    );
    await exec(two.name, TABLE("z_last"), "INSERT INTO z_last VALUES (1, 'last')");
    const full = hashes(await checkpoint(one.id));
    const alone = hashes(await checkpoint(two.id));
    expect(alone["table:z_last"]).toBe(full["table:z_last"]!);

    await exec(two.name, TABLE("zz_after"), "INSERT INTO zz_after VALUES (1, 'after')", TABLE("b_mid"), "INSERT INTO b_mid VALUES (1, 'mid'), (2, 'mid2')");
    const notLast = hashes(await checkpoint(two.id));
    expect(notLast["table:z_last"]).toBe(full["table:z_last"]!);
    expect(notLast["table:b_mid"]).toBe(full["table:b_mid"]!);

    const text = await readObjectText(one.id, full["table:z_last"]!);
    expect(text.startsWith("-- LambData table v2 z_last\nDROP TABLE IF EXISTS `z_last`;\nCREATE TABLE `z_last`")).toBe(true);
    expect(text.endsWith("INSERT INTO `z_last` (`id`, `v`) VALUES (1,'last');\n")).toBe(true);
    expect(text).not.toContain("LOCK TABLES");
    expect(text).not.toContain("@OLD_TIME_ZONE");
    expect(text).not.toContain("CREATE DATABASE");
    expect(text).not.toMatch(/^USE /m);
    expect(text).not.toContain(one.name);
  }, 120_000);

  test("changing one row changes exactly one table's hash", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const before = hashes(await checkpoint(database.id));
    await exec(database.name, "UPDATE settings SET v = 'changed' WHERE k = 'a'");
    const after = hashes(await checkpoint(database.id));
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed).toEqual(["table:settings"]);
  }, 120_000);

  test("views never appear as tables and code changes only touch the code entry", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const before = hashes(await checkpoint(database.id));
    expect(Object.keys(before).some((k) => k.includes("v_leaderboard"))).toBe(false);
    const code = await readObjectText(database.id, before["code:code"]!);
    expect(code).toContain("v_leaderboard");
    expect(code).toContain("trg_players_audit");
    expect(code).toContain("sp_player_summary");
    expect(code).not.toContain("enable the sandbox mode");
    await exec(database.name, "CREATE OR REPLACE VIEW v_two AS SELECT 2 AS two");
    const after = hashes(await checkpoint(database.id));
    expect(Object.keys(before).filter((k) => before[k] !== after[k])).toEqual(["code:code"]);
  }, 120_000);

  test("an unchanged database records nothing unless asked, and sets the base on creation", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const first = await createCheckpoint(database.id, { trigger: "manual", message: "first", userId: fx.owner.id });
    expect(first.unchanged).toBe(false);
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(first.checkpointId);
    expect(databases.byId(database.id)!.baseShortHash).toBe(checkpoints.byId(first.checkpointId!)!.shortHash);
    const again = await createCheckpoint(database.id, { trigger: "scheduled" });
    expect(again).toEqual({ checkpointId: null, unchanged: true });
    expect(checkpoints.listForDatabase(database.id).length).toBe(1);
    await exec(database.name, "INSERT INTO settings VALUES ('d', '4')");
    const second = await createCheckpoint(database.id, { trigger: "manual", message: "  second\nline\u0000  " });
    const cp = checkpoints.byId(second.checkpointId!)!;
    expect(cp.parentId).toBe(first.checkpointId);
    expect(cp.message).toBe("second\nline");
    expect(cp.isBase).toBe(true);
    expect(cp.tableCount).toBe(4);
    expect(cp.rowCount).toBe(3 + 2 + 0 + 4);
    expect(cp.newBytes).toBeLessThan(cp.storedBytes);
    expect(cp.createdByDisplayName).toBeNull();
    expect(checkpoints.byId(first.checkpointId!)!.createdByDisplayName).not.toBeNull();
  }, 120_000);

  test("an empty database can be checkpointed", async () => {
    const { database } = await makeDatabase(fx.owner);
    const r = await createCheckpoint(database.id, { trigger: "manual" });
    const cp = checkpoints.byId(r.checkpointId!)!;
    expect(cp.tableCount).toBe(0);
    expect(checkpoints.entries(cp.id)).toEqual([]);
  }, 60_000);

  test("sequences, system-versioned tables and odd names are captured", async () => {
    const { database } = await makeDatabase(fx.owner);
    await exec(
      database.name,
      "CREATE SEQUENCE seq_orders START WITH 100 INCREMENT BY 5",
      "CREATE TABLE ver (id INT PRIMARY KEY, v INT) WITH SYSTEM VERSIONING",
      "INSERT INTO ver VALUES (1, 1)",
      "CREATE TABLE `odd name ü` (id INT PRIMARY KEY)",
      "CREATE TABLE `back``tick` (id INT PRIMARY KEY)",
      "INSERT INTO `back``tick` VALUES (7)",
    );
    const id = await checkpoint(database.id);
    expect(Object.keys(hashes(id)).sort()).toEqual(
      ["table:back`tick", "table:odd name ü", "table:seq_orders", "table:ver"].sort(),
    );
    const rows = await select<{ n: string }>(database.name, "SELECT NEXTVAL(seq_orders) AS n");
    expect(String(rows[0]!.n)).toBe("100");
  }, 120_000);
});
