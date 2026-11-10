import { describe, expect, test } from "bun:test";
import { filterLines, schemaHash } from "../../src/checkpoints/sql";
import { treeHash } from "../../src/checkpoints/hash";

const LEGACY_DROP = /^(?:CREATE DATABASE\b|USE\s+`)/i;

async function run(text: string, size: number): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const input = (async function* () {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
  })();
  const parts: Uint8Array[] = [];
  for await (const p of filterLines(input, (l) => LEGACY_DROP.test(l))) parts.push(p.slice());
  return Buffer.concat(parts).toString("utf8");
}

describe("legacy line filter", () => {
  test("drops CREATE DATABASE and USE lines only, for every chunking", async () => {
    const long = "x".repeat(10_000);
    const text = [
      "-- header",
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
      "",
      "USE `shop`;",
      `INSERT INTO t VALUES (1,'${long}'),(2,'USE \`x\`;');`,
      "  USE `indented`;",
      `CREATE DATABASE ${long};`,
      "INSERT INTO t VALUES (3,'tail')",
    ].join("\n");
    const expected = ["-- header", "", `INSERT INTO t VALUES (1,'${long}'),(2,'USE \`x\`;');`, "  USE `indented`;", "INSERT INTO t VALUES (3,'tail')"].join(
      "\n",
    );
    for (const size of [1, 3, 17, 4096, 5000, 1 << 20]) expect(await run(text, size)).toBe(expected);
  });
});

describe("hash helpers", () => {
  test("schema hash ignores AUTO_INCREMENT and tree hash ignores order", () => {
    expect(schemaHash("CREATE TABLE t (id int) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4")).toBe(
      schemaHash("CREATE TABLE t (id int) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4"),
    );
    const a = { kind: "table", name: "a", objectHash: "1".repeat(64) };
    const b = { kind: "table", name: "b", objectHash: "2".repeat(64) };
    const c = { kind: "code", name: "code", objectHash: "3".repeat(64) };
    expect(treeHash([a, b, c])).toBe(treeHash([c, b, a]));
    expect(treeHash([a, b])).not.toBe(treeHash([a, { ...b, objectHash: "4".repeat(64) }]));
    expect(treeHash([{ ...a, name: "a\tb" }])).not.toBe(treeHash([{ ...a, name: "a" }, { ...a, name: "b" }]));
  });
});
