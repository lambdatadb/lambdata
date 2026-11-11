import { describe, expect, test } from "bun:test";
import { parseAuditLine, parseErrorLogLine, parseLine, type RawRejection } from "../../src/connections/parse";
import {
  classifyRejection,
  explainRejection,
  groupRejections,
  toRejectedConnection,
  type AccountDirectory,
} from "../../src/connections/classify";
import { hostPatternMatches } from "../../src/connections/hostPattern";
import { AUDIT_12_2, ERRORLOG_11_8, ERRORLOG_12_2 } from "./fixtures";

const NOW = new Date(2026, 10, 12, 0, 0, 0).getTime();

function directory(): AccountDirectory {
  return {
    known: new Map([
      ["alpha_u", { databaseId: "db_alpha", connectionsFrom: "%" }],
      ["beta_u", { databaseId: "db_beta", connectionsFrom: "10.9.%" }],
      ["gamma_u", { databaseId: "db_gamma", connectionsFrom: "203.0.113.%" }],
    ]),
    internal: new Set(["root", "lambdata_root", "kilndb_root", "ro_viewer"]),
    internalPrefixes: ["ld_scp_"],
  };
}

function parseAll(source: "audit" | "errorlog", lines: string[]): RawRejection[] {
  return lines.map((l) => parseLine(source, l, NOW)).filter((r): r is RawRejection => r !== null);
}

describe("audit plugin lines (MariaDB 12.2)", () => {
  test("only failed connections are read, with the address and code", () => {
    const raws = parseAll("audit", AUDIT_12_2);
    expect(raws.map((r) => [r.user, r.address, r.code])).toEqual([
      ["alpha_u", "203.0.113.7", 1045],
      ["beta_u", "203.0.113.7", 1045],
      ["gamma_u", "203.0.113.7", 4151],
      ["nobody", "203.0.113.7", 1045],
      ["alpha_u", "203.0.113.7", 1045],
      ["root", "127.0.0.1", 1045],
    ]);
    expect(raws[0]!.at).toBe(new Date(2026, 10, 11, 16, 35, 18).getTime());
  });

  test("the classifier explains each failure", () => {
    const dir = directory();
    const classified = parseAll("audit", AUDIT_12_2).map((r) => classifyRejection(r, dir));
    expect(classified.map((c) => c && [c.account, c.reason, c.databaseId])).toEqual([
      ["alpha_u", "wrong-password", "db_alpha"],
      ["beta_u", "address-not-allowed", "db_beta"],
      ["gamma_u", "closed-for-operation", "db_gamma"],
      ["nobody", "unknown-account", null],
      ["alpha_u", "wrong-password", "db_alpha"],
      null,
    ]);
  });

  test("a line without a port, an IPv6 peer and a user name with a comma", () => {
    expect(parseAuditLine("20261111 16:35:18,db-host,odd,name,198.51.100.4,5,0,FAILED_CONNECT,,,1045", NOW)).toMatchObject({
      user: "odd,name",
      address: "198.51.100.4",
    });
    expect(parseAuditLine("20261111 16:35:18,db-host,alpha_u,2001:db8::7,5,0,FAILED_CONNECT,,,1045", NOW)?.address).toBe(
      "2001:db8::7",
    );
    expect(parseAuditLine("20261111 16:35:18,db-host,alpha_u,203.0.113.7:1,5,0,CONNECT,,,0", NOW)).toBeNull();
  });

  test("no line carries or yields a password", () => {
    const joined = JSON.stringify(parseAll("audit", AUDIT_12_2));
    expect(joined).not.toContain("Wrong");
    expect(Object.keys(parseAll("audit", AUDIT_12_2)[0]!).sort()).toEqual(["address", "at", "code", "user"]);
  });
});

describe("error log lines", () => {
  for (const [version, lines, address] of [
    ["12.2", ERRORLOG_12_2, "203.0.113.7"],
    ["11.8", ERRORLOG_11_8, "198.51.100.23"],
  ] as const) {
    test(`MariaDB ${version}: access denied lines are read and classified`, () => {
      const raws = parseAll("errorlog", [...lines]);
      expect(raws.every((r) => r.code === 1045)).toBe(true);
      const dir = directory();
      const classified = raws.map((r) => classifyRejection(r, dir)).filter((c) => c !== null);
      expect(classified.map((c) => [c!.account, c!.address, c!.reason])).toEqual([
        ["alpha_u", address, "wrong-password"],
        ["beta_u", address, "address-not-allowed"],
        ["nobody", address, "unknown-account"],
        ["alpha_u", address, "wrong-password"],
      ]);
    });
  }

  test("other warnings are ignored", () => {
    expect(parseErrorLogLine("2026-11-11 21:36:49 0 [Warning] failed to retrieve the MAC address", NOW)).toBeNull();
    expect(parseErrorLogLine("2026-11-11 21:36:49 0 [Note] Access denied for user is not a real line", NOW)).toBeNull();
  });

  test("a time in the future is clamped to now", () => {
    const r = parseErrorLogLine("2099-01-01 00:00:00 4 [Warning] Access denied for user 'a'@'203.0.113.7' (using password: YES)", NOW);
    expect(r?.at).toBe(NOW);
  });
});

describe("classification", () => {
  const raw = (user: string, address: string, code = 1045): RawRejection => ({ at: NOW, user, address, code });

  test("internal accounts and loopback checks are not listed", () => {
    const dir = directory();
    expect(classifyRejection(raw("root", "203.0.113.7"), dir)).toBeNull();
    expect(classifyRejection(raw("lambdata_root", "203.0.113.7"), dir)).toBeNull();
    expect(classifyRejection(raw("ro_viewer", "203.0.113.7"), dir)).toBeNull();
    expect(classifyRejection(raw("ld_scp_abc", "203.0.113.7"), dir)).toBeNull();
    expect(classifyRejection(raw("alpha_u", "127.0.0.1"), dir)).toBeNull();
    expect(classifyRejection(raw("nobody", "::1"), dir)).toBeNull();
  });

  test("a connection refused before an account was named", () => {
    expect(classifyRejection(raw("", "198.51.100.9", 1130), directory())).toEqual({
      address: "198.51.100.9",
      account: null,
      reason: "address-not-allowed",
      databaseId: null,
    });
  });

  test("grouping counts repeats and keeps the first and last time", () => {
    const groups = groupRejections(
      [
        { at: NOW - 5000, user: "alpha_u", address: "203.0.113.7", code: 1045 },
        { at: NOW - 1000, user: "alpha_u", address: "203.0.113.7", code: 1045 },
        { at: NOW - 3000, user: "alpha_u", address: "203.0.113.8", code: 1045 },
      ],
      directory(),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ address: "203.0.113.7", count: 2, firstAt: NOW - 5000, lastAt: NOW - 1000 });
  });

  test("allow this address is offered only for an address the pattern does not match", () => {
    const lookup = (id: string) =>
      id === "db_beta" ? { displayName: "Shop", connectionsFrom: "10.9.%" } : { displayName: "Other", connectionsFrom: "%" };
    const base = { account: "beta_u", databaseId: "db_beta", count: 3, firstAt: NOW, lastAt: NOW };
    const allowed = toRejectedConnection({ ...base, address: "203.0.113.7", reason: "address-not-allowed" }, lookup);
    expect(allowed.canAllow).toBe(true);
    expect(allowed.databaseName).toBe("Shop");
    expect(allowed.explanation).toContain("10.9.%");
    expect(allowed.explanation).toContain("Docker or a VPN");
    const wrong = toRejectedConnection({ ...base, address: "10.9.1.2", reason: "wrong-password" }, lookup);
    expect(wrong.canAllow).toBe(false);
  });

  test("every reason has a sentence", () => {
    for (const reason of ["address-not-allowed", "wrong-password", "unknown-account", "closed-for-operation", "other"] as const) {
      expect(explainRejection({ address: "203.0.113.7", account: "x", reason }, "%").length).toBeGreaterThan(20);
    }
  });
});

describe("host patterns", () => {
  test("MariaDB wildcards, netmasks and prefixes", () => {
    expect(hostPatternMatches("%", "203.0.113.7")).toBe(true);
    expect(hostPatternMatches("203.0.113.%", "203.0.113.7")).toBe(true);
    expect(hostPatternMatches("203.0.113.%", "203.0.114.7")).toBe(false);
    expect(hostPatternMatches("198.51.100._", "198.51.100.5")).toBe(true);
    expect(hostPatternMatches("198.51.100._", "198.51.100.50")).toBe(false);
    expect(hostPatternMatches("198.51.100.0/255.255.255.0", "198.51.100.77")).toBe(true);
    expect(hostPatternMatches("198.51.100.0/255.255.255.0", "198.51.101.77")).toBe(false);
    expect(hostPatternMatches("198.51.100.0/24", "198.51.100.77")).toBe(true);
    expect(hostPatternMatches("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(hostPatternMatches("203.0.113.7", "203.0.113.70")).toBe(false);
    expect(hostPatternMatches("localhost", "127.0.0.1")).toBe(false);
    expect(hostPatternMatches("100.%", "100.64.0.1")).toBe(true);
  });
});
