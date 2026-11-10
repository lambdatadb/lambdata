import { createTestDatabase, mariadbAvailable, rootQuery, startTestInstance, type TestInstance } from "../harness/instance";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql from "mysql2/promise";
import { env } from "../../src/env";
import { captureCodeRecords } from "../../src/mariadb/codeObjects";
import { getRootPassword } from "../../src/mariadb/controller";
import { localAdminTarget } from "../../src/mariadb/process";
import { createStagingSchema, swapStagingIntoLive, type ExpectLive } from "../../src/mariadb/schemaSwap";

const SWAPS = Number(process.env.LAMBDATA_SWAP_READER_ROUNDS ?? 20);
const READERS = 4;

const SCHEMA = [
  "CREATE TABLE parent (id INT PRIMARY KEY, name VARCHAR(20))",
  "CREATE TABLE child (id INT PRIMARY KEY, parent_id INT, note VARCHAR(20), CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES parent (id))",
  "CREATE TABLE grandchild (id INT PRIMARY KEY, child_id INT, FOREIGN KEY (child_id) REFERENCES child (id))",
  "CREATE TABLE audit (id INT AUTO_INCREMENT PRIMARY KEY, child_id INT)",
];
const ROWS = [
  "INSERT INTO parent VALUES (1, 'a'), (2, 'b')",
  "INSERT INTO child VALUES (1, 1, 'x'), (2, 2, 'y')",
  "INSERT INTO grandchild VALUES (1, 1)",
];

async function expectOf(schema: string): Promise<ExpectLive> {
  const tables: ExpectLive["tables"] = [];
  for (const t of ["audit", "child", "grandchild", "parent"]) {
    const [count] = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${schema}\`.\`${t}\``);
    const [sum] = await rootQuery<{ Checksum: number }>(`CHECKSUM TABLE \`${schema}\`.\`${t}\``);
    tables.push({ name: t, rowCount: Number(count!.n), checksum: Number(sum!.Checksum) });
  }
  return { tables, capturedAt: Date.now() };
}

describe.skipIf(!mariadbAvailable())("readers during swaps", () => {
  let instance: TestInstance | null = null;

  beforeAll(async () => {
    instance = await startTestInstance();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop();
  }, 60_000);

  test(`readers on the database's own account see no error through ${SWAPS} swaps of a schema with foreign keys`, async () => {
    const db = await createTestDatabase();
    const root = await mysql.createConnection({
      host: "127.0.0.1",
      port: env.mariadbPort,
      user: env.rootUser,
      password: await getRootPassword(),
      database: db.schema,
      multipleStatements: true,
    });
    await root.query([...SCHEMA, ...ROWS].join(";\n"));
    await root.query(
      "CREATE DEFINER=CURRENT_USER TRIGGER child_audit AFTER INSERT ON child FOR EACH ROW INSERT INTO audit (child_id) VALUES (NEW.id)",
    );
    await root.query("CREATE VIEW v_family AS SELECT p.name, COUNT(c.id) AS kids FROM parent p LEFT JOIN child c ON c.parent_id = p.id GROUP BY p.name");
    const code = await captureCodeRecords(await localAdminTarget(), db.schema);
    const foreignKeys = (): Promise<string[]> =>
      rootQuery<{ c: string; t: string }>(
        "SELECT CONSTRAINT_NAME AS c, TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? ORDER BY 2",
        [db.schema],
      ).then((rows) => rows.map((f) => `${f.t}.${f.c}`));
    const fksBefore = await foreignKeys();
    expect(fksBefore.length).toBe(2);
    expect(fksBefore[0]).toBe("child.fk_child_parent");
    let stop = false;
    const errors: string[] = [];
    let reads = 0;
    const readers = await Promise.all(
      Array.from({ length: READERS }, () =>
        mysql.createConnection({ host: "127.0.0.1", port: env.mariadbPort, user: db.user, password: db.password, database: db.schema }),
      ),
    );
    const loops = readers.map(async (r, i) => {
      const queries = [
        "SELECT COUNT(*) AS n FROM parent p JOIN child c ON c.parent_id = p.id",
        "SELECT COUNT(*) AS n FROM grandchild g JOIN child c ON c.id = g.child_id",
        "SELECT * FROM v_family",
        "SELECT COUNT(*) AS n FROM audit",
      ];
      let k = i;
      while (!stop) {
        try {
          await r.query(queries[k++ % queries.length]!);
          reads++;
        } catch (err) {
          errors.push(`${(err as { code?: string }).code ?? ""} ${(err as Error).message}`);
        }
      }
    });
    const timings: number[] = [];
    try {
      for (let round = 0; round < SWAPS; round++) {
        const staging = await createStagingSchema(db.schema);
        await root.query(`USE \`${staging}\``);
        await root.query([...SCHEMA, ...ROWS].join(";\n"));
        await root.query(`USE \`${db.schema}\``);
        const started = Date.now();
        const result = await swapStagingIntoLive({ live: db.schema, staging, code, expectLive: await expectOf(db.schema) });
        timings.push(Date.now() - started);
        expect(result.outcome).toBe("done");
      }
    } finally {
      stop = true;
      await Promise.all(loops);
      await Promise.all(readers.map((r) => r.end()));
      await root.end();
    }
    console.log(
      JSON.stringify({ swaps: SWAPS, readers: READERS, reads, errors: errors.length, sample: errors.slice(0, 3), slowestSwapMs: Math.max(...timings) }),
    );
    expect(reads).toBeGreaterThan(SWAPS * READERS);
    expect(errors).toEqual([]);
    expect(await foreignKeys()).toEqual(fksBefore);
    await rootQuery(`INSERT INTO \`${db.schema}\`.child VALUES (3, 1, 'z')`);
    const [audit] = await rootQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${db.schema}\`.audit WHERE child_id = 3`);
    expect(Number(audit!.n)).toBe(1);
  }, 600_000);
});
