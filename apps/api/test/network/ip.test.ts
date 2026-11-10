import { describe, expect, test } from "bun:test";
import {
  cidrContains,
  formatCidr,
  isLoopbackIp,
  isTailnetIp,
  normalizeIp,
  parseCidr,
  parseIp,
} from "../../src/network/ip";

describe("ip parsing", () => {
  test("normalizes v4, v6 and v4-mapped addresses", () => {
    expect(normalizeIp("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeIp("::ffff:10.0.0.7")).toBe("10.0.0.7");
    expect(normalizeIp("[::1]")).toBe("::1");
    expect(normalizeIp("FD7A:115C:A1E0:0:0:0:0:1")).toBe("fd7a:115c:a1e0::1");
    expect(normalizeIp("fe80::1%en0")).toBe("fe80::1");
    expect(normalizeIp("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
  });

  test("rejects garbage", () => {
    for (const bad of ["", "unknown", "1.2.3", "1.2.3.256", "01.2.3.4", "1::2::3", "12345::", "1.2.3.4.5", ":1:2:3:4:5:6:7"]) {
      expect(parseIp(bad)).toBeNull();
    }
  });

  test("classifies loopback and tailnet ranges", () => {
    expect(isLoopbackIp(parseIp("127.0.0.1")!)).toBe(true);
    expect(isLoopbackIp(parseIp("127.8.9.10")!)).toBe(true);
    expect(isLoopbackIp(parseIp("::1")!)).toBe(true);
    expect(isLoopbackIp(parseIp("::ffff:127.0.0.1")!)).toBe(true);
    expect(isLoopbackIp(parseIp("10.0.0.1")!)).toBe(false);
    expect(isTailnetIp(parseIp("100.64.0.1")!)).toBe(true);
    expect(isTailnetIp(parseIp("100.127.255.254")!)).toBe(true);
    expect(isTailnetIp(parseIp("100.128.0.1")!)).toBe(false);
    expect(isTailnetIp(parseIp("100.63.255.255")!)).toBe(false);
    expect(isTailnetIp(parseIp("fd7a:115c:a1e0:ab12::1")!)).toBe(true);
    expect(isTailnetIp(parseIp("fd7a:115c:a1e1::1")!)).toBe(false);
  });

  test("parses and matches CIDR ranges", () => {
    const docker = parseCidr("172.16.0.0/12")!;
    expect(cidrContains(docker, parseIp("172.17.0.5")!)).toBe(true);
    expect(cidrContains(docker, parseIp("172.32.0.1")!)).toBe(false);
    expect(cidrContains(docker, parseIp("::1")!)).toBe(false);
    expect(formatCidr(parseCidr("10.1.2.3/8")!)).toBe("10.0.0.0/8");
    expect(formatCidr(parseCidr("192.168.1.5")!)).toBe("192.168.1.5");
    expect(formatCidr(parseCidr("2001:db8::1/32")!)).toBe("2001:db8::/32");
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/x")).toBeNull();
    expect(parseCidr("nope/8")).toBeNull();
  });
});
