import { mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { seedUser, type SeededUser } from "../harness/sqlite";
import mysql from "mysql2/promise";
import type { Database } from "@lambdata/shared";
import { env } from "../../src/env";
import { provisionDatabase } from "../../src/databases/provision";
import { waitForJob } from "../../src/jobs";
import { getMariaDbBinariesSync, getRootPassword } from "../../src/mariadb/controller";

export { mariadbAvailable, rootQuery };

export type Row = Record<string, unknown>;

export interface Fixture {
  instance: TestInstance;
  owner: SeededUser;
}

let counter = 0;

export async function setup(): Promise<Fixture> {
  const instance = await startTestInstance();
  return { instance, owner: seedUser("admin") };
}

export async function makeDatabase(owner: SeededUser, opts: { versioned?: boolean; kind?: "standard" | "mirror" } = {}) {
  counter++;
  const { database, credentials } = await provisionDatabase({
    displayName: `cp ${process.pid % 1000} ${counter} ${Math.random().toString(36).slice(2, 6)}`,
    ownerUserId: owner.id,
    versioned: opts.versioned,
    kind: opts.kind,
  });
  return { database, credentials };
}

export async function exec(schema: string, ...statements: string[]): Promise<void> {
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: env.rootUser,
    password: await getRootPassword(),
    database: schema,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: "utf8mb4",
  });
  try {
    for (const s of statements) await conn.query(s);
  } finally {
    await conn.end();
  }
}

export async function select<T = Row>(schema: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port: env.mariadbPort,
    user: env.rootUser,
    password: await getRootPassword(),
    database: schema,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: "utf8mb4",
  });
  try {
    const [rows] = await conn.query(sql, params);
    return rows as T[];
  } finally {
    await conn.end();
  }
}

export async function tableNames(schema: string): Promise<string[]> {
  const rows = await rootQuery<{ n: string }>(
    `SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE <> 'VIEW' ORDER BY TABLE_NAME`,
    [schema],
  );
  return rows.map((r) => r.n);
}

export async function checksums(schema: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of await tableNames(schema)) {
    const [row] = await rootQuery<Row>(`CHECKSUM TABLE \`${schema}\`.\`${t.replaceAll("`", "``")}\` EXTENDED`);
    const [count] = await rootQuery<Row>(`SELECT COUNT(*) AS n FROM \`${schema}\`.\`${t.replaceAll("`", "``")}\``);
    out[t] = `${row!.Checksum}/${count!.n}`;
  }
  return out;
}

export async function codeObjectsOf(schema: string): Promise<string[]> {
  const rows = await rootQuery<{ k: string }>(
    `SELECT CONCAT('view:', TABLE_NAME) AS k FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
     UNION ALL SELECT CONCAT('trigger:', TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
     UNION ALL SELECT CONCAT(LOWER(ROUTINE_TYPE), ':', ROUTINE_NAME) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
     UNION ALL SELECT CONCAT('event:', EVENT_NAME) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`,
    [schema, schema, schema, schema],
  );
  return rows.map((r) => r.k).sort();
}

export async function finished(jobId: string) {
  const job = await waitForJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  return job;
}

export async function mariadbClient(schema: string, input: Uint8Array | string): Promise<{ exit: number; stderr: string }> {
  const bin = getMariaDbBinariesSync().client;
  const proc = Bun.spawn(
    [
      bin,
      "--no-defaults",
      "--protocol=TCP",
      "--host=127.0.0.1",
      `--port=${env.mariadbPort}`,
      `--user=${env.rootUser}`,
      "--skip-ssl",
      "--batch",
      `--database=${schema}`,
    ],
    {
      stdin: typeof input === "string" ? new TextEncoder().encode(input) : input,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", MYSQL_PWD: await getRootPassword() },
    },
  );
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { exit, stderr };
}

export const RICH_SCHEMA = [
  `CREATE TABLE players (
     id BIGINT UNSIGNED PRIMARY KEY,
     name VARCHAR(100) NOT NULL,
     bio TEXT,
     avatar BLOB,
     score INT NOT NULL DEFAULT 0
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE matches (
     id INT AUTO_INCREMENT PRIMARY KEY,
     player_id BIGINT UNSIGNED NOT NULL,
     points INT NOT NULL,
     played_at DATETIME(3) NOT NULL,
     CONSTRAINT fk_matches_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE audit (
     id INT AUTO_INCREMENT PRIMARY KEY,
     player_id BIGINT UNSIGNED NOT NULL,
     note VARCHAR(200) NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE settings (k VARCHAR(50), v VARCHAR(200)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `INSERT INTO players VALUES
     (76561198000000008, 'Ada 😀', 'line1\nline2\n-- Table structure for table \`matches\`\n', 0x00FF0A0D27225C5C00, 10),
     (18446744073709551615, 'Max', NULL, NULL, 20),
     (9007199254740993, 'Zoë 中文 עברית', 'tab\there', 0xDEADBEEF, 30)`,
  `INSERT INTO matches (player_id, points, played_at) VALUES
     (76561198000000008, 5, '2026-01-01 10:00:00.123'), (9007199254740993, 7, '2026-01-02 11:00:00.456')`,
  `INSERT INTO settings VALUES ('b', '2'), ('a', '1'), ('c', NULL)`,
  `CREATE VIEW v_leaderboard AS SELECT p.name, SUM(m.points) AS total FROM players p JOIN matches m ON m.player_id = p.id GROUP BY p.id, p.name`,
  `CREATE TRIGGER trg_players_audit AFTER UPDATE ON players FOR EACH ROW INSERT INTO audit (player_id, note) VALUES (NEW.id, CONCAT('score ', OLD.score, '->', NEW.score))`,
  `CREATE PROCEDURE sp_player_summary(IN pid BIGINT UNSIGNED) SELECT p.name, COUNT(m.id) AS games FROM players p LEFT JOIN matches m ON m.player_id = p.id WHERE p.id = pid GROUP BY p.id, p.name`,
  `CREATE FUNCTION f_double(x INT) RETURNS INT DETERMINISTIC RETURN x * 2`,
];

export async function populateRich(schema: string): Promise<void> {
  await exec(schema, ...RICH_SCHEMA);
}

export function nextName(prefix: string): string {
  counter++;
  return `${prefix}_${process.pid % 1000}_${counter}`;
}

export type { Database };
