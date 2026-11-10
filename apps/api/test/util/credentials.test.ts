import { describe, expect, test } from "bun:test";
import {
  MAX_MYSQL_USER_LENGTH,
  deriveSchemaName,
  generateMysqlUser,
  generatePassword,
} from "../../src/util/credentials";

describe("generateMysqlUser", () => {
  test("is well formed and at most 32 characters for every schema length", () => {
    for (let len = 1; len <= 64; len++) {
      const schema = "abcdefghij".repeat(7).slice(0, len);
      const user = generateMysqlUser(schema);
      expect(user.length).toBeLessThanOrEqual(MAX_MYSQL_USER_LENGTH);
      expect(user).toMatch(/^ld_[a-z0-9](?:[a-z0-9_]*[a-z0-9])?_[a-z0-9]{8}$/);
      expect(user.startsWith(`ld_${schema.slice(0, 20)}_`)).toBe(true);
    }
  });

  test("never produces an empty or underscore-only middle", () => {
    for (const schema of ["", "_", "___", "a".repeat(64), "abc_".repeat(16), "UPPER-case.name"]) {
      const user = generateMysqlUser(schema);
      expect(user).not.toContain("__");
      expect(user.length).toBeLessThanOrEqual(MAX_MYSQL_USER_LENGTH);
      expect(user).toMatch(/^ld_[a-z0-9_]+_[a-z0-9]{8}$/);
    }
    expect(generateMysqlUser("___")).toMatch(/^ld_db_[a-z0-9]{8}$/);
  });

  test("schemas sharing a long prefix still get distinct users", () => {
    const base = "very_long_database_name_used_by_tests";
    const users = new Set<string>();
    for (let i = 0; i < 2_000; i++) users.add(generateMysqlUser(`${base}_${i}`));
    expect(users.size).toBe(2_000);
  });

  test("retries until the name is not taken", () => {
    const taken = new Set<string>();
    let calls = 0;
    const user = generateMysqlUser("shop", (u) => {
      calls++;
      if (calls < 3) {
        taken.add(u);
        return true;
      }
      return false;
    });
    expect(calls).toBe(3);
    expect(taken.has(user)).toBe(false);
    expect(() => generateMysqlUser("shop", () => true)).toThrow(/unique/);
  });
});

describe("deriveSchemaName", () => {
  test("produces lowercase letters, digits and underscores without a leading or trailing underscore", () => {
    const inputs = ["My Shop", "__private__", "  spaced  ", "Émoji 🎉 store", "a".repeat(80), `${"b".repeat(47)}-c`, "", "---"];
    for (const input of inputs) {
      const name = deriveSchemaName(input);
      expect(name).toMatch(/^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/);
      expect(name.length).toBeLessThanOrEqual(48);
    }
    expect(deriveSchemaName("__private__")).toBe("private");
    expect(deriveSchemaName("")).toBe("db");
  });

  test("never yields a system schema name", () => {
    expect(deriveSchemaName("mysql")).toBe("mysql_db");
    expect(deriveSchemaName("MySQL")).toBe("mysql_db");
    expect(deriveSchemaName("information schema")).toBe("information_schema_db");
    expect(deriveSchemaName("Performance-Schema")).toBe("performance_schema_db");
    expect(deriveSchemaName("sys")).toBe("sys_db");
  });
});

describe("generatePassword", () => {
  test("is url-safe and random", () => {
    const a = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(generatePassword()).not.toBe(a);
  });
});
