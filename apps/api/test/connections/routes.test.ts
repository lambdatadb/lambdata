import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { NetworkStatusResponse, RejectedConnectionsResponse } from "@lambdata/shared";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { peerEnv } from "../network/helpers";
import { buildApp } from "../../src/server";
import { databases } from "../../src/db/queries";
import { ingestLines, setCapture, stopRejectionCapture } from "../../src/connections/capture";
import { clearRejections } from "../../src/connections/store";
import { AUDIT_12_2 } from "./fixtures";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let owner: SeededUser;
let otherOwner: SeededUser;
let viewer: SeededUser;

function seedDatabase(id: string, mysqlUser: string, connectionsFrom: string, ownerUserId: string): void {
  databases.insert({
    id,
    name: id,
    displayName: `Display ${id}`,
    ownerUserId,
    kind: "standard",
    mysqlUser,
    mysqlPasswordEnc: "unused",
    connectionsFrom,
    tailscaleExposed: false,
    lanExposed: true,
  });
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function get<T>(user: SeededUser, path: string, method = "GET"): Promise<{ status: number; body: T }> {
  const res = await app.request(path, { method, headers: await authHeaders(user) }, peerEnv("127.0.0.1"));
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(() => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  owner = seedUser("db_owner");
  otherOwner = seedUser("db_owner");
  viewer = seedUser("viewer");
  seedDatabase("db_alpha", "alpha_u", "%", owner.id);
  seedDatabase("db_beta", "beta_u", "10.9.%", owner.id);
  seedDatabase("db_gamma", "gamma_u", "203.0.113.%", otherOwner.id);
});

afterAll(() => {
  stopRejectionCapture();
  md.cleanup();
});

beforeEach(() => {
  clearRejections();
  setCapture({ mode: "audit", path: `${md.dataDir}/absent-audit.log` });
  ingestLines("audit", AUDIT_12_2.map((l) => l.replace(/^\d{8}/, today())));
});

describe("rejected connections", () => {
  test("a database lists its own rejections with an explanation", async () => {
    const { status, body } = await get<RejectedConnectionsResponse>(owner, "/api/databases/db_beta/rejected-connections");
    expect(status).toBe(200);
    expect(body.supported).toBe(true);
    expect(body.rejections).toHaveLength(1);
    expect(body.rejections[0]).toMatchObject({
      address: "203.0.113.7",
      account: "beta_u",
      databaseId: "db_beta",
      databaseName: "Display db_beta",
      reason: "address-not-allowed",
      count: 1,
      canAllow: true,
    });
  });

  test("repeated wrong passwords are counted in one row", async () => {
    const { body } = await get<RejectedConnectionsResponse>(viewer, "/api/databases/db_alpha/rejected-connections");
    expect(body.rejections.map((r) => [r.reason, r.count, r.canAllow])).toEqual([["wrong-password", 2, false]]);
  });

  test("an owner cannot read another owner's database", async () => {
    expect((await get(owner, "/api/databases/db_gamma/rejected-connections")).status).toBe(403);
    const { body } = await get<RejectedConnectionsResponse>(otherOwner, "/api/databases/db_gamma/rejected-connections");
    expect(body.rejections[0]?.reason).toBe("closed-for-operation");
  });

  test("the network list is for admins and includes unknown accounts", async () => {
    expect((await get(owner, "/api/network/rejected-connections")).status).toBe(403);
    const { body } = await get<RejectedConnectionsResponse>(admin, "/api/network/rejected-connections");
    const unknown = body.rejections.filter((r) => r.reason === "unknown-account");
    expect(unknown.map((r) => r.account)).toEqual(["nobody"]);
    expect(body.rejections.some((r) => r.account === "root")).toBe(false);
  });

  test("admins can clear the list", async () => {
    expect((await get(viewer, "/api/network/rejected-connections", "DELETE")).status).toBe(403);
    const cleared = await get<RejectedConnectionsResponse>(admin, "/api/network/rejected-connections", "DELETE");
    expect(cleared.status).toBe(200);
    const { body } = await get<RejectedConnectionsResponse>(admin, "/api/network/rejected-connections");
    expect(body.rejections).toEqual([]);
    expect(body.since).not.toBeNull();
  });

  test("without a capture source the list says it is not supported", async () => {
    setCapture({ mode: "none", path: null });
    const { body } = await get<RejectedConnectionsResponse>(owner, "/api/databases/db_alpha/rejected-connections");
    expect(body.supported).toBe(false);
    expect(body.since).toBeNull();
  });
});

describe("network status", () => {
  test("includes the database port", async () => {
    const { body } = await get<NetworkStatusResponse>(viewer, "/api/network/status");
    expect(body.status.databasePort).toMatchObject({ port: expect.any(Number), outsideConnections: false, source: "default" });
  });
});
