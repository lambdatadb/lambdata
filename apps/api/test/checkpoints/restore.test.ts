import {
  checksums,
  codeObjectsOf,
  exec,
  makeDatabase,
  mariadbAvailable,
  populateRich,
  rootQuery,
  select,
  setup,
  type Fixture,
} from "./helpers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { createCheckpoint, getWorkingCopyStatus, restoreCheckpoint } from "../../src/checkpoints";
import { checkpoints, databases } from "../../src/db/queries";
import { objectPath } from "../../src/checkpoints/store";
import { env } from "../../src/env";
import { STAGING_PREFIX, TRASH_PREFIX } from "../../src/mariadb/schemaSwap";

async function snapshotValues(schema: string) {
  return {
    players: await select(schema, "SELECT CAST(id AS CHAR) AS id, name, bio, HEX(avatar) AS avatar, score FROM players ORDER BY id"),
    matches: await select(schema, "SELECT id, CAST(player_id AS CHAR) AS player_id, points, CAST(played_at AS CHAR) AS played_at FROM matches ORDER BY id"),
    settings: await select(schema, "SELECT k, v FROM settings ORDER BY k"),
  };
}

async function managedSchemas(): Promise<string[]> {
  const rows = await rootQuery<{ n: string }>("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA");
  return rows.map((r) => r.n).filter((n) => n.startsWith(STAGING_PREFIX) || n.startsWith(TRASH_PREFIX));
}

describe.skipIf(!mariadbAvailable())("checkpoint restore", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 180_000);

  afterAll(async () => {
    await fx?.instance.stop();
  }, 120_000);

  test("restores tables, keys, triggers, views, procedures, big integers, emoji and binary exactly", async () => {
    const { database, credentials } = await makeDatabase(fx.owner);
    const schema = database.name;
    await populateRich(schema);
    const sums = await checksums(schema);
    const values = await snapshotValues(schema);
    const code = await codeObjectsOf(schema);
    const target = (await createCheckpoint(database.id, { trigger: "manual", message: "good state" })).checkpointId!;

    await exec(
      schema,
      "UPDATE players SET score = score + 100",
      "DELETE FROM matches WHERE points = 5",
      "INSERT INTO settings VALUES ('zz', 'new')",
      "DROP VIEW v_leaderboard",
      "DROP PROCEDURE sp_player_summary",
      "CREATE TABLE extra (id INT PRIMARY KEY)",
      "DROP TRIGGER trg_players_audit",
    );
    expect(await checksums(schema)).not.toEqual(sums);

    const result = await restoreCheckpoint(database.id, target, { userId: fx.owner.id });
    expect(result.restoredCheckpointId).toBe(target);
    expect(result.safetyCheckpointId).not.toBeNull();

    expect(await checksums(schema)).toEqual(sums);
    expect(await snapshotValues(schema)).toEqual(values);
    expect(await codeObjectsOf(schema)).toEqual(code);
    expect(await managedSchemas()).toEqual([]);
    expect(databases.byId(database.id)!.baseCheckpointId).toBe(target);
    expect((await getWorkingCopyStatus(database.id, { refresh: true })).state).toBe("clean");

    const players = values.players as { id: string; name: string; avatar: string | null }[];
    expect(players.map((p) => p.id)).toEqual(["18446744073709551615", "76561198000000008", "9007199254740993"]);
    expect(players.find((p) => p.id === "76561198000000008")!.name).toBe("Ada 😀");
    expect(players.find((p) => p.id === "76561198000000008")!.avatar).toBe("00FF0A0D27225C5C00");

    const user = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: credentials.user,
      password: credentials.password,
      database: schema,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      const [board] = await user.query("SELECT name, total FROM v_leaderboard ORDER BY total DESC");
      expect((board as { name: string }[]).length).toBe(2);
      const [proc] = await user.query("CALL sp_player_summary(76561198000000008)");
      expect(String((proc as { games: unknown }[][])[0]![0]!.games)).toBe("1");
      await user.query("UPDATE players SET score = 11 WHERE id = 76561198000000008");
      const [audit] = await user.query("SELECT note FROM audit");
      expect((audit as { note: string }[]).map((a) => a.note)).toEqual(["score 10->11"]);
      await expect(user.query("INSERT INTO matches (player_id, points, played_at) VALUES (1, 1, NOW())")).rejects.toThrow(
        /foreign key/i,
      );
      const [fn] = await user.query("SELECT f_double(21) AS v");
      expect(String((fn as { v: unknown }[])[0]!.v)).toBe("42");
    } finally {
      await user.end();
    }

    const safety = checkpoints.byId(result.safetyCheckpointId!)!;
    expect(safety.trigger).toBe("pre-restore");
    expect(safety.parentId).toBe(target);
    expect(safety.message).toContain(checkpoints.byId(target)!.shortHash);
    const back = await restoreCheckpoint(database.id, safety.id, { userId: fx.owner.id });
    expect(back.restoredCheckpointId).toBe(safety.id);
    expect(await select(schema, "SELECT COUNT(*) AS n FROM extra")).toEqual([{ n: "0" }]);
    expect(await codeObjectsOf(schema)).not.toContain("view:v_leaderboard");
  }, 240_000);

  test("a clean working copy takes no safety checkpoint, and a new checkpoint after a rollback branches", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const a = (await createCheckpoint(database.id, { trigger: "manual", message: "a" })).checkpointId!;
    await exec(database.name, "INSERT INTO settings VALUES ('x', 'y')");
    const b = (await createCheckpoint(database.id, { trigger: "manual", message: "b" })).checkpointId!;
    const restored = await restoreCheckpoint(database.id, a, { userId: null });
    expect(restored.safetyCheckpointId).toBeNull();
    await exec(database.name, "INSERT INTO settings VALUES ('q', 'r')");
    const c = (await createCheckpoint(database.id, { trigger: "manual", message: "c" })).checkpointId!;
    expect(checkpoints.byId(c)!.parentId).toBe(a);
    expect(checkpoints.byId(b)!.parentId).toBe(a);
  }, 240_000);

  test("a corrupt or missing object fails before the swap and leaves live data untouched", async () => {
    const { database } = await makeDatabase(fx.owner);
    await populateRich(database.name);
    const id = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(database.name, "DELETE FROM matches", "INSERT INTO settings VALUES ('live', 'data')");
    const live = await checksums(database.name);
    const liveCode = await codeObjectsOf(database.name);
    const players = checkpoints.entries(id).find((e) => e.name === "players")!;
    const path = objectPath(database.id, players.objectHash);
    const original = await Bun.file(path).bytes();

    writeFileSync(path, Bun.gzipSync("DROP TABLE IF EXISTS `players`;\nCREATE TABLE `players` (id INT);\n"));
    await expect(restoreCheckpoint(database.id, id, { userId: null })).rejects.toThrow(/corrupt/);
    expect(await checksums(database.name)).toEqual(live);
    expect(await codeObjectsOf(database.name)).toEqual(liveCode);
    expect(await managedSchemas()).toEqual([]);

    writeFileSync(path, original.subarray(0, Math.floor(original.length / 2)));
    await expect(restoreCheckpoint(database.id, id, { userId: null })).rejects.toThrow();
    expect(await checksums(database.name)).toEqual(live);
    expect(await managedSchemas()).toEqual([]);

    const { unlinkSync } = await import("node:fs");
    unlinkSync(path);
    await expect(restoreCheckpoint(database.id, id, { userId: null })).rejects.toThrow(/missing/);
    expect(await checksums(database.name)).toEqual(live);

    writeFileSync(path, original);
    await restoreCheckpoint(database.id, id, { userId: null });
    expect(await select(database.name, "SELECT COUNT(*) AS n FROM matches")).toEqual([{ n: "2" }]);
  }, 240_000);

  test("a refused swap (foreign keys from another schema) leaves live data untouched", async () => {
    const { database } = await makeDatabase(fx.owner);
    const other = (await makeDatabase(fx.owner)).database;
    await populateRich(database.name);
    const id = (await createCheckpoint(database.id, { trigger: "manual" })).checkpointId!;
    await exec(
      other.name,
      `CREATE TABLE ref (pid BIGINT UNSIGNED, FOREIGN KEY (pid) REFERENCES \`${database.name}\`.players(id)) ENGINE=InnoDB`,
    );
    await exec(database.name, "INSERT INTO settings VALUES ('keep', 'me')");
    const live = await checksums(database.name);
    await expect(restoreCheckpoint(database.id, id, { userId: null })).rejects.toThrow(/foreign keys/);
    expect(await checksums(database.name)).toEqual(live);
    expect(await managedSchemas()).toEqual([]);
    await exec(other.name, "DROP TABLE ref");
  }, 240_000);
});
