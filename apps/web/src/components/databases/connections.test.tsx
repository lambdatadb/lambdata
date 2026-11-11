import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StaticRouter } from "react-router-dom/server";
import type { DatabaseCredentials, DatabasePortStatus, RejectedConnection, User } from "@lambdata/shared";
import { fixtureDatabase } from "../../pages/dev/jobFixtures";
import { AuthProvider } from "../../lib/auth";
import { queryKeys } from "../../lib/queries";
import { reachFromSystem, type DatabaseReach } from "../../lib/connections";
import { databaseEndpoints, revealedCredentials } from "../../lib/useConnectionInfo";
import { ConnectionFacts } from "../../pages/database/OverviewTab";
import { AddressLine } from "../../pages/dashboard/AddressSubtitle";
import { CredentialsFields } from "./CredentialsReveal";
import { NOT_YET_TITLE, THIS_MACHINE_TEXT } from "./ReachNotice";
import { AllowAddressSummary, RejectionRow, allowAddressRequest } from "./RejectedConnections";
import { SwitchConsequences, databasePortSummary } from "../network/DatabaseConnectionsCard";
import { manifestHost } from "./CreateDatabaseDialog";

declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  not: { toContain(expected: unknown): void; toBe(expected: unknown): void };
};

const ADMIN: User = {
  id: "user_avery",
  email: "admin@example.com",
  displayName: "Avery Chen",
  role: "admin",
  experienceLevel: "advanced",
  dataViewEnabled: false,
  colorTheme: "lime",
  vitalsChartStyle: "area",
  createdAt: 0,
  lastLoginAt: null,
} as User;

function render(node: ReactElement, user: User | null = ADMIN): string {
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.auth, { user });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <StaticRouter location="/">{node}</StaticRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

const CREDENTIALS: DatabaseCredentials = {
  host: "0.0.0.0",
  port: 3307,
  schema: "storefront",
  user: "storefront",
  password: "Throwaway_Test_Pw_1",
  mysqlCli: "mysql -h 0.0.0.0 -P 3307 -u storefront -p storefront",
  jdbc: "jdbc:mysql://0.0.0.0:3307/storefront?user=storefront&password=Throwaway_Test_Pw_1",
  uri: "mysql://storefront:Throwaway_Test_Pw_1@0.0.0.0:3307/storefront",
} as DatabaseCredentials;

const PAGE_HOST = "db.example.com";
const info = (reach: DatabaseReach) => ({ host: reach === "this-machine" ? "127.0.0.1" : PAGE_HOST, port: 3307, reach });

test("the reachability state follows the server's answer", () => {
  expect(reachFromSystem(undefined)).toBe("outside");
  expect(reachFromSystem({ outsideConnections: undefined, inContainer: undefined })).toBe("outside");
  expect(reachFromSystem({ outsideConnections: true, inContainer: true })).toBe("outside");
  expect(reachFromSystem({ outsideConnections: false, inContainer: true })).toBe("not-yet");
  expect(reachFromSystem({ outsideConnections: false, inContainer: false })).toBe("this-machine");
});

test("outside connections on: today's address", () => {
  const endpoints = databaseEndpoints(info("outside"), "100.64.0.9", fixtureDatabase);
  expect(endpoints.map((e) => [e.label, e.host])).toEqual([
    ["LAN", PAGE_HOST],
    ["Tailnet", "100.64.0.9"],
  ]);
  const html = render(<ConnectionFacts db={fixtureDatabase} endpoints={endpoints} reach="outside" isAdmin />);
  expect(html).toContain(`value="${PAGE_HOST}"`);
  expect(html).toContain('value="100.64.0.9"');
  expect(text(html)).not.toContain(NOT_YET_TITLE);
  expect(revealedCredentials(CREDENTIALS, false, info("outside"), null).credentials.uri).toContain(`@${PAGE_HOST}:3307`);
  expect(manifestHost(info("outside"))).toBe(`${PAGE_HOST}:3307`);
});

test("outside connections off in a container: no usable host, a link to the switch", () => {
  const endpoints = databaseEndpoints(info("not-yet"), "100.64.0.9", fixtureDatabase);
  expect(endpoints.length).toBe(1);
  expect(endpoints[0]!.reachable).toBe(false);
  const html = render(<ConnectionFacts db={fixtureDatabase} endpoints={endpoints} reach="not-yet" isAdmin />);
  expect(text(html)).toContain(NOT_YET_TITLE);
  expect(html).toContain('href="/network#database-connections"');
  expect(html).not.toContain(PAGE_HOST);
  expect(html).not.toContain("100.64.0.9");
  expect(html).toContain('value="storefront"');

  const viewer = text(render(<ConnectionFacts db={fixtureDatabase} endpoints={endpoints} reach="not-yet" isAdmin={false} />));
  expect(viewer).toContain("ask an admin");

  const revealed = revealedCredentials(CREDENTIALS, false, info("not-yet"), "100.64.0.9");
  expect(revealed.reach).toBe("not-yet");
  const fields = text(render(<CredentialsFields credentials={revealed.credentials} reach="not-yet" isAdmin />));
  expect(fields).toContain(NOT_YET_TITLE);
  expect(fields).toContain("Host (not reachable yet)");
  expect(fields).toContain("not reachable yet");
  expect(fields).toContain("Password");

  const line = render(<AddressLine reach="not-yet" host={PAGE_HOST} port={3307} tailnetIp="100.64.0.9" />);
  expect(text(line)).toContain("cannot connect yet");
  expect(text(line)).not.toContain("3307");
  expect(text(render(<>{manifestHost(info("not-yet"))}</>))).toBe("not reachable yet");
});

test("outside connections off on a local install: 127.0.0.1, this machine only", () => {
  const endpoints = databaseEndpoints(info("this-machine"), "100.64.0.9", fixtureDatabase);
  expect(endpoints.map((e) => [e.label, e.host])).toEqual([["This machine", "127.0.0.1"]]);
  const html = render(<ConnectionFacts db={fixtureDatabase} endpoints={endpoints} reach="this-machine" isAdmin />);
  expect(html).toContain('value="127.0.0.1"');
  expect(text(html)).toContain(THIS_MACHINE_TEXT);
  expect(html).not.toContain("100.64.0.9");
  const revealed = revealedCredentials(CREDENTIALS, true, info("this-machine"), "100.64.0.9");
  expect(revealed.credentials.host).toBe("127.0.0.1");
  expect(revealed.credentials.mysqlCli).toContain("-h 127.0.0.1");
  expect(revealed.tailnetMissing).toBe(false);
  const fields = text(render(<CredentialsFields credentials={revealed.credentials} reach="this-machine" />));
  expect(fields).toContain("Host (this machine only)");
  expect(text(render(<AddressLine reach="this-machine" host="127.0.0.1" port={3307} tailnetIp={null} />))).toContain(
    "127.0.0.1:3307",
  );
});

const REJECTION: RejectedConnection = {
  address: "203.0.113.7",
  account: "storefront",
  databaseId: fixtureDatabase.id,
  databaseName: "Storefront",
  reason: "address-not-allowed",
  explanation:
    "The sign-in came from 203.0.113.7, which this database's “connections from” setting (10.9.%) does not allow. Behind Docker or a VPN the address MariaDB sees can differ from the client's own address.",
  count: 12,
  firstAt: Date.now() - 3_600_000,
  lastAt: Date.now() - 120_000,
  canAllow: true,
};

function findButton(node: ReactNode, label: string): { onClick: () => void } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { children?: ReactNode; onClick?: () => void };
  if (props.children === label && props.onClick) return { onClick: props.onClick };
  return findButton(props.children, label);
}

test("a rejected connection shows when, how often, the address and why", () => {
  const html = text(render(<ul><RejectionRow rejection={REJECTION} canAllow onAllow={() => {}} /></ul>));
  expect(html).toContain("203.0.113.7");
  expect(html).toContain("12 times");
  expect(html).toContain("2m ago");
  expect(html).toContain("Behind Docker or a VPN");
  expect(html).toContain("Allow this address");
  const readOnly = text(render(<ul><RejectionRow rejection={REJECTION} canAllow={false} onAllow={() => {}} /></ul>));
  expect(readOnly).not.toContain("Allow this address");
  const matched = text(render(<ul><RejectionRow rejection={{ ...REJECTION, canAllow: false }} canAllow onAllow={() => {}} /></ul>));
  expect(matched).not.toContain("Allow this address");
});

test("allow this address: confirm shows the current and new value, then replaces it", async () => {
  let picked: RejectedConnection | null = null;
  const button = findButton(RejectionRow({ rejection: REJECTION, canAllow: true, onAllow: (r) => (picked = r) }), "Allow this address");
  expect(button === null).toBe(false);
  button!.onClick();
  expect(picked).toEqual(REJECTION);

  const summary = text(render(<AllowAddressSummary current="10.9.%" next={REJECTION.address} />));
  expect(summary).toContain("replaces the current");
  expect(summary).toContain("Current 10.9.%");
  expect(summary).toContain("New 203.0.113.7");

  const calls: { url: string; method: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), body: String(init.body) });
    return new Response(JSON.stringify({ database: { ...fixtureDatabase, connectionsFrom: "203.0.113.7" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const res = await allowAddressRequest(fixtureDatabase.id, REJECTION.address);
    expect(res.database?.connectionsFrom).toBe("203.0.113.7");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(calls).toEqual([
    { url: `/api/databases/${fixtureDatabase.id}`, method: "PATCH", body: JSON.stringify({ connectionsFrom: "203.0.113.7" }) },
  ]);
});

test("the switch explains the restart and the published port", () => {
  const port: DatabasePortStatus = {
    bind: "127.0.0.1",
    port: 3307,
    outsideConnections: false,
    source: "default",
    lockedByEnv: false,
    inContainer: true,
    rejectionsSupported: true,
  };
  expect(databasePortSummary(port)).toContain("cannot connect yet");
  const on = text(render(<SwitchConsequences port={port} turningOn />));
  expect(on).toContain("drop for a moment");
  expect(on).toContain("-p 3307:3307");
  expect(on).toContain("MariaDB Port");
  const local = text(render(<SwitchConsequences port={{ ...port, inContainer: false }} turningOn />));
  expect(local).not.toContain("-p 3307:3307");
  expect(databasePortSummary({ ...port, inContainer: false })).toBe("Only clients on this machine can connect.");
});
