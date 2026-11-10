import type {
  AppAuthSession,
  Checkpoint,
  CheckpointListResponse,
  DashboardSummary,
  Database,
  DatabaseCredentials,
  ImportCreateDatabaseResponse,
  ImportUploadResponse,
  Job,
} from "@lambdata/shared";
import { ApiClient, HttpError } from "./client";
import { fieldNotesSqlite } from "./fixtures";

export interface Account {
  email: string;
  password: string;
  displayName: string;
}

export const ACCOUNTS = {
  admin: { email: "avery.chen@example.com", password: "visual-test-admin", displayName: "Avery Chen" },
  owner: { email: "priya.nair@example.com", password: "visual-test-owner", displayName: "Priya Nair" },
  viewer: { email: "marcus.lee@example.com", password: "visual-test-viewer", displayName: "Marcus Lee" },
} satisfies Record<string, Account>;

export interface Seeded {
  storefront: Database;
  replica: Database;
  fieldNotes: Database;
  supportDesk: Database;
  analytics: Database;
  storefrontHead: Checkpoint;
  storefrontOlder: Checkpoint;
}

type Log = (message: string) => void;

async function sql(client: ApiClient, db: Database, statements: string[]): Promise<void> {
  for (const statement of statements) await client.post(`/api/databases/${db.id}/query`, { sql: statement });
}

async function createDatabase(
  client: ApiClient,
  body: { displayName: string; kind?: "standard" | "mirror"; versioned?: boolean; showInVitals?: boolean; connectionsFrom?: string },
) {
  return client.post<{ database: Database; credentials: DatabaseCredentials }>("/api/databases", body);
}

async function checkpoint(client: ApiClient, db: Database, message: string): Promise<void> {
  await client.get(`/api/databases/${db.id}/checkpoints/status?refresh=1`);
  const { job } = await client.post<{ job: Job }>(`/api/databases/${db.id}/checkpoints`, { message });
  await client.waitForJob(job);
}

async function checkpoints(client: ApiClient, db: Database): Promise<Checkpoint[]> {
  return (await client.get<CheckpointListResponse>(`/api/databases/${db.id}/checkpoints`)).checkpoints;
}

async function refetch(client: ApiClient, db: Database): Promise<Database> {
  return (await client.get<{ database: Database }>(`/api/databases/${db.id}`)).database;
}

function rows<T>(items: T[], render: (item: T, index: number) => string): string {
  return items.map(render).join(", ");
}

export const LAN_CLIENT = { "X-Forwarded-For": "192.168.1.20" };

export async function completeSetup(apiUrl: string, dataDir: string, setupToken: string, log: Log): Promise<ApiClient> {
  log("Running first-time setup with the token from the server log, as a browser on the local network would");
  const lan = new ApiClient(apiUrl, LAN_CLIENT);
  await lan.post("/api/setup/token", { setupToken });
  await lan.post("/api/setup/data-dir", { path: dataDir, setupToken });
  await lan.post("/api/setup/complete", {
    email: ACCOUNTS.admin.email,
    password: ACCOUNTS.admin.password,
    displayName: ACCOUNTS.admin.displayName,
    experienceLevel: "advanced",
    setupToken,
  });
  const admin = new ApiClient(apiUrl);
  await admin.login(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  return admin;
}

const SCHEDULER_FIRST_TICK_MS = 3 * 60_000 + 15_000;

export async function seed(admin: ApiClient, apiUrl: string, scratch: string, bootedAt: number, log: Log): Promise<Seeded> {
  const seedStartedAt = Math.max(bootedAt, Date.now());
  log("Adding console users");
  await admin.post("/api/users", { ...ACCOUNTS.owner, role: "db_owner" });
  await admin.post("/api/users", { ...ACCOUNTS.viewer, role: "viewer" });
  await admin.post("/api/users", { email: "lena.hoffmann@example.com", password: "visual-test-lena", displayName: "Lena Hoffmann", role: "db_owner" });

  log("Creating Storefront with a branched history");
  const storefrontCreated = await createDatabase(admin, { displayName: "Storefront", versioned: true });
  let storefront = storefrontCreated.database;
  await sql(admin, storefront, [
    "CREATE TABLE products (id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(32) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, price_cents INT NOT NULL, stock INT NOT NULL DEFAULT 0)",
    "CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE, city VARCHAR(80), joined_on DATE NOT NULL)",
    "CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, placed_at DATETIME NOT NULL, status VARCHAR(16) NOT NULL, total_cents INT NOT NULL)",
    `INSERT INTO products (sku, name, price_cents, stock) VALUES ${rows(
      [
        ["MUG-001", "Stoneware mug", 1800, 140],
        ["TEA-014", "Loose leaf sencha", 1250, 80],
        ["NBK-220", "Dot grid notebook", 1400, 210],
        ["PEN-030", "Brass fountain pen", 6400, 35],
        ["BAG-105", "Waxed canvas tote", 5200, 48],
        ["CND-008", "Cedar candle", 2200, 96],
      ],
      ([sku, name, price, stock]) => `('${sku}', '${name}', ${price}, ${stock})`,
    )}`,
    `INSERT INTO customers (name, email, city, joined_on) VALUES ${rows(
      [
        ["Maya Patel", "maya.patel@example.com", "Leeds"],
        ["Jonas Weber", "jonas.weber@example.com", "Hamburg"],
        ["Lucia Romero", "lucia.romero@example.com", "Valencia"],
        ["Kenji Watanabe", "kenji.watanabe@example.com", "Osaka"],
        ["Amara Okafor", "amara.okafor@example.com", "Lagos"],
        ["Noah Fischer", "noah.fischer@example.com", "Zurich"],
        ["Elena Costa", "elena.costa@example.com", "Porto"],
      ],
      ([name, email, city], i) => `('${name}', '${email}', '${city}', DATE_SUB(CURDATE(), INTERVAL ${300 - i * 37} DAY))`,
    )}`,
  ]);
  await checkpoint(admin, storefront, "Initial catalog and customers");
  await sql(admin, storefront, [
    `INSERT INTO orders (customer_id, placed_at, status, total_cents) VALUES ${rows(
      Array.from({ length: 24 }, (_, i) => i),
      (i) =>
        `(${(i % 7) + 1}, DATE_SUB(NOW(), INTERVAL ${i * 19} HOUR), '${i % 5 === 0 ? "refunded" : i % 3 === 0 ? "shipped" : "delivered"}', ${1800 + ((i * 1370) % 9000)})`,
    )}`,
  ]);
  await checkpoint(admin, storefront, "Import October orders");
  await sql(admin, storefront, ["UPDATE products SET price_cents = ROUND(price_cents * 1.08)"]);
  await checkpoint(admin, storefront, "Raise prices by 8 percent");
  const older = (await checkpoints(admin, storefront)).find((cp) => cp.message === "Import October orders");
  if (!older) throw new Error("the orders checkpoint is missing");
  log("Rolling Storefront back and branching");
  const restore = await admin.post<{ job: Job }>(`/api/databases/${storefront.id}/checkpoints/${older.id}/restore`);
  await admin.waitForJob(restore.job);
  await sql(admin, storefront, [
    "UPDATE products SET price_cents = price_cents + 100 WHERE sku IN ('MUG-001', 'CND-008')",
    "INSERT INTO products (sku, name, price_cents, stock) VALUES ('GFT-050', 'Gift card', 5000, 999)",
  ]);
  await checkpoint(admin, storefront, "Add gift cards and adjust two prices");
  storefront = await refetch(admin, storefront);
  const storefrontCheckpoints = await checkpoints(admin, storefront);
  const head = storefrontCheckpoints.find((cp) => cp.isBase);
  if (!head) throw new Error("Storefront has no HEAD checkpoint");

  log("Creating Storefront Replica and syncing it");
  const rotated = await admin.post<{ credentials: DatabaseCredentials }>(`/api/databases/${storefront.id}/rotate-password`);
  let replica = (await createDatabase(admin, { displayName: "Storefront Replica", kind: "mirror", versioned: true })).database;
  await admin.put(`/api/databases/${replica.id}/sync`, {
    sourceKind: "mysql",
    sourceHost: "127.0.0.1",
    sourcePort: rotated.credentials.port,
    sourceUser: rotated.credentials.user,
    sourcePassword: rotated.credentials.password,
    sourceDatabase: rotated.credentials.schema,
    intervalSeconds: 3600,
    enabled: true,
  });
  const sync = await admin.post<{ job: Job }>(`/api/databases/${replica.id}/sync/run`);
  await admin.waitForJob(sync.job);
  replica = await refetch(admin, replica);

  log("Importing Field Notes from a SQLite file");
  const file = Bun.file(fieldNotesSqlite(scratch));
  const res = await admin.raw("POST", "/api/imports/uploads", {
    body: await file.arrayBuffer(),
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("field-notes.sqlite") },
  });
  if (!res.ok) throw new HttpError("POST", "/api/imports/uploads", res.status, await res.text());
  const upload = ((await res.json()) as ImportUploadResponse).upload;
  await admin.get(`/api/imports/uploads/${upload.id}/plan`);
  const imported = await admin.post<ImportCreateDatabaseResponse>(`/api/imports/uploads/${upload.id}/create-database`, {
    displayName: "Field Notes",
    versioned: true,
  });
  await admin.waitForJob(imported.job);
  const fieldNotes = await refetch(admin, imported.database);

  log("Creating Analytics Events");
  const analytics = (await createDatabase(admin, { displayName: "Analytics Events" })).database;
  await sql(admin, analytics, [
    "CREATE TABLE events (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, path VARCHAR(255), occurred_at DATETIME NOT NULL, INDEX (name), INDEX (occurred_at))",
    `INSERT INTO events (name, path, occurred_at) VALUES ${rows(
      Array.from({ length: 180 }, (_, i) => i),
      (i) => `('${["page_view", "add_to_cart", "checkout", "search"][i % 4]}', '/shop/${["mugs", "tea", "paper", "bags"][i % 4]}', DATE_SUB(NOW(), INTERVAL ${i * 7} MINUTE))`,
    )}`,
  ]);

  log("Creating Support Desk as Priya Nair");
  const owner = new ApiClient(apiUrl);
  await owner.login(ACCOUNTS.owner.email, ACCOUNTS.owner.password);
  const supportDesk = (await createDatabase(owner, { displayName: "Support Desk", versioned: true })).database;
  await sql(owner, supportDesk, [
    "CREATE TABLE tickets (id INT AUTO_INCREMENT PRIMARY KEY, subject VARCHAR(200) NOT NULL, requester VARCHAR(120) NOT NULL, status VARCHAR(16) NOT NULL, opened_at DATETIME NOT NULL)",
    `INSERT INTO tickets (subject, requester, status, opened_at) VALUES ${rows(
      [
        ["Order arrived damaged", "Jonas Weber", "open"],
        ["Change delivery address", "Lucia Romero", "solved"],
        ["Gift card not applied", "Elena Costa", "pending"],
        ["Invoice copy needed", "Noah Fischer", "solved"],
        ["Pen nib replacement", "Kenji Watanabe", "open"],
      ],
      ([subject, who, status], i) => `('${subject}', '${who}', '${status}', DATE_SUB(NOW(), INTERVAL ${i * 11} HOUR))`,
    )}`,
  ]);
  await checkpoint(owner, supportDesk, "Ticket table with the first requests");

  log("Adding app users, a policy and a denied request");
  const appUsers = [
    ["hana.sato@example.com", "Hana Sato"],
    ["tomas.silva@example.com", "Tomás Silva"],
    ["grace.okoro@example.com", "Grace Okoro"],
  ];
  for (const [email, displayName] of appUsers) {
    await admin.post("/api/app-auth/users", { email, password: "visual-test-app-user", displayName });
  }
  await admin.patch(`/api/data-policies/${storefront.name}/products`, {
    selectEnabled: true,
    insertEnabled: false,
    updateEnabled: false,
    deleteEnabled: false,
  });
  const token = await admin.post<{ session: AppAuthSession }>("/api/app-auth/token", {
    email: appUsers[0]![0],
    password: "visual-test-app-user",
  });
  const bearer = { Authorization: `Bearer ${token.session.accessToken}` };
  const asApp = (path: string, init: RequestInit = {}) =>
    fetch(`${apiUrl}${path}`, { ...init, headers: { ...bearer, ...(init.headers as Record<string, string> | undefined) } });
  await asApp(`/api/data/${storefront.name}/products?limit=3`);
  for (let i = 0; i < 3; i++) await asApp(`/api/data/${storefront.name}/customers?limit=5`);
  await asApp(`/api/data/${storefront.name}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: 1, placed_at: "2026-11-01 10:00:00", status: "paid", total_cents: 1800 }),
  });

  log("Adding storage buckets and objects");
  const images = await admin.post<{ bucket: { id: string } }>("/api/storage/buckets", { name: "product-images", public: true });
  const exportsBucket = await admin.post<{ bucket: { id: string } }>("/api/storage/buckets", { name: "exports", public: false });
  const swatches: [string, string][] = [
    ["stoneware-mug.svg", "#C6F24E"],
    ["sencha-tin.svg", "#4EC9B0"],
    ["canvas-tote.svg", "#F2A65A"],
  ];
  for (const [name, color] of swatches) {
    const form = new FormData();
    form.append("name", name);
    form.append(
      "file",
      new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="${color}"/></svg>`], {
        type: "image/svg+xml",
      }),
      name,
    );
    await admin.raw("POST", `/api/storage/buckets/${images.bucket.id}/objects`, { body: form });
  }
  const csv = ["id,customer,total", "1001,Maya Patel,18.00", "1002,Jonas Weber,52.00", "1003,Lucia Romero,64.00"].join("\n");
  const form = new FormData();
  form.append("name", "orders-2026-10.csv");
  form.append("file", new Blob([csv], { type: "text/csv" }), "orders-2026-10.csv");
  await admin.raw("POST", `/api/storage/buckets/${exportsBucket.bucket.id}/objects`, { body: form });

  log("Adding a function and a secret");
  await admin.post("/api/functions", { name: "order-summary", verifyJwt: true });
  await admin.put("/api/functions/order-summary/source", {
    source: [
      "export default async function handler(req, ctx) {",
      "  const url = new URL(req.url);",
      "  const days = Number(url.searchParams.get(\"days\") ?? 7);",
      "  console.log(\"summary requested\", days);",
      "  return Response.json({ ok: true, days, generatedAt: new Date().toISOString() });",
      "}",
      "",
    ].join("\n"),
  });
  await admin.post("/api/functions/secrets", { name: "WEBHOOK_SIGNING_KEY", value: crypto.randomUUID() });
  for (const days of [7, 30]) await asApp(`/functions/v1/order-summary?days=${days}`);

  const firstTick = seedStartedAt + SCHEDULER_FIRST_TICK_MS;
  if (Date.now() < firstTick) {
    log(`Waiting ${Math.ceil((firstTick - Date.now()) / 1000)}s for the first automatic checkpoint run, so it does not land mid-capture`);
    await Bun.sleep(firstTick - Date.now());
  }
  for (let i = 0; i < 120; i++) {
    const active = await admin.get<{ jobs: Job[] }>("/api/jobs?active=1&limit=50");
    if (active.jobs.length === 0) break;
    await Bun.sleep(500);
  }
  log("Leaving uncommitted changes in Storefront");
  await sql(admin, storefront, [
    "INSERT INTO orders (customer_id, placed_at, status, total_cents) VALUES (3, NOW(), 'paid', 6900), (6, NOW(), 'paid', 2200)",
  ]);
  await admin.get(`/api/databases/${storefront.id}/checkpoints/status?refresh=1`);

  log("Waiting for the metrics collector to sample every database");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const summary = await admin.get<DashboardSummary>("/api/dashboard/summary");
    if (summary.latestMetrics.every((m) => m.collectedAt !== null)) break;
    await Bun.sleep(3_000);
  }

  return {
    storefront: await refetch(admin, storefront),
    replica,
    fieldNotes,
    supportDesk,
    analytics,
    storefrontHead: head,
    storefrontOlder: older,
  };
}
