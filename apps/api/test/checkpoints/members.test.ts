import { describe, expect, test } from "bun:test";
import { memberTokens, restoreToken, rewriteMembers } from "../../src/checkpoints/members";
import { withoutStagingDrop } from "../../src/checkpoints/restore";

async function collect(chunks: Uint8Array[], name: string, split: number[] = []): Promise<string> {
  const joined = Buffer.concat(chunks);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const s of [...split, joined.length]) {
    parts.push(joined.subarray(at, s));
    at = s;
  }
  const out: Uint8Array[] = [];
  for await (const c of withoutStagingDrop(
    (async function* () {
      for (const p of parts) yield p;
    })(),
    name,
  ))
    out.push(c);
  return Buffer.concat(out).toString("utf8");
}

describe("enum and set members MariaDB shows as ?", () => {
  test("member lists are split as the server renders them", () => {
    expect(memberTokens("enum('','a','it''s','back\\\\slash','ünï ?','q?','?''x')")!.tokens).toEqual([
      "''",
      "'a'",
      "'it''s'",
      "'back\\\\slash'",
      "'ünï ?'",
      "'q?'",
      "'?''x'",
    ]);
    expect(memberTokens("set('a','?b','c')")!.tokens).toEqual(["'a'", "'?b'", "'c'"]);
    expect(memberTokens("int(11)")).toBeNull();
  });

  test("a rendered member gets its characters back and keeps the server's escaping", () => {
    expect(restoreToken("'ünï ?'", "ünï 😀")).toBe("'ünï 😀'");
    expect(restoreToken("'?''x'", "😀'x")).toBe("'😀''x'");
    expect(restoreToken("'q?'", "q?")).toBe("'q?'");
    expect(restoreToken("'back\\\\slash'", "back\\slash")).toBe("'back\\\\slash'");
    expect(restoreToken("'a?'", "ab")).toBeNull();
    expect(restoreToken("'a'", "ab")).toBeNull();
  });

  test("the column definition and its default are rewritten, nothing else", () => {
    const ddl = "CREATE TABLE `t` (\n  `id` int(11) NOT NULL,\n  `e` enum('a','ünï ?') DEFAULT 'ünï ?' COMMENT 'x?',\n  `f` enum('a','ünï ?') DEFAULT NULL,\n  PRIMARY KEY (`id`)\n)";
    const out = rewriteMembers(ddl, { name: "e", columnType: "enum('a','ünï ?')", columnDefault: "'ünï ?'" }, { members: ["a", "ünï 😀"], columnDefault: "ünï 😀" });
    expect(out).toBe("CREATE TABLE `t` (\n  `id` int(11) NOT NULL,\n  `e` enum('a','ünï 😀') DEFAULT 'ünï 😀' COMMENT 'x?',\n  `f` enum('a','ünï ?') DEFAULT NULL,\n  PRIMARY KEY (`id`)\n)");
    expect(rewriteMembers(ddl, { name: "e", columnType: "enum('a','ünï ?')", columnDefault: "'ünï ?'" }, { members: ["a"], columnDefault: null })).toBeNull();
  });
});

describe("loading table objects into staging", () => {
  const header = "-- LambData table v2 ";
  test("the leading DROP is skipped, also for a name with a newline and across chunk borders", async () => {
    const body = "CREATE TABLE `line\nbreak` (id INT);\nINSERT INTO `line\nbreak` VALUES (1);\n";
    const object = `${header}line\\nbreak\nDROP TABLE IF EXISTS \`line\nbreak\`;\n${body}`;
    const bytes = Buffer.from(object);
    for (const split of [[], [5], [30, 31], [50], [bytes.length - 1]]) {
      expect(await collect([bytes], "line\nbreak", split)).toBe(`${header}line\\nbreak\n${body}`);
    }
  });

  test("an object in another layout is passed through unchanged", async () => {
    const object = `${header}t\nCREATE TABLE \`t\` (id INT);\n`;
    expect(await collect([Buffer.from(object)], "t")).toBe(object);
    expect(await collect([Buffer.from(`${header}t\nDROP`)], "t")).toBe(`${header}t\nDROP`);
  });
});
