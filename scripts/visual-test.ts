import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "puppeteer-core";
import type {
  CheckpointDetailResponse,
  CheckpointListResponse,
  CodeObjectFailure,
  Database,
  HealthDetail,
  Job,
  NetworkStatusResponse,
  NotificationDestination,
  NotificationDestinationListResponse,
  UnconvertedSnapshot,
} from "@lambdata/shared";
import {
  fixtureCatalog,
  fixtureDeliveries,
  fixtureDestinations,
  fixtureTestNotFound,
  fixtureTestOk,
} from "../apps/web/src/pages/dev/notificationFixtures";
import { Recorder, capture, clickText, launch, openPage, settle, signIn } from "./lib/browser";
import { HttpError, type ApiClient } from "./lib/client";
import { legacyCrmSqlite } from "./lib/fixtures";
import { fixtureSetAside } from "../apps/web/src/pages/dev/setAsideFixtures";
import { seedForNotifications, signatureMatches, startReceiver, waitForRequest, type Receiver } from "./lib/notify";
import { ACCOUNTS, LAN_CLIENT, completeSetup, seed, type Account, type Seeded } from "./lib/seed";
import { prepareRoot, readSetupToken, startStack, type Stack } from "./lib/stack";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const shotsDir = process.env.SHOTS_DIR ? resolve(process.env.SHOTS_DIR) : null;
if (!shotsDir) {
  console.error("Set SHOTS_DIR to the directory the screenshots should go to, for example:");
  console.error("  SHOTS_DIR=/tmp/lambdata-shots bun run scripts/visual-test.ts");
  process.exit(2);
}
const root = resolve(process.env.VISUAL_ROOT ?? (process.platform === "win32" ? join(process.env.TEMP ?? "C:\\Temp", "lambdata-visual") : "/tmp/lambdata-visual"));
const widths = (process.env.WIDTHS ?? "1440,390").split(",").map(Number).filter((w) => w > 0);
const ports = {
  apiPort: Number(process.env.VISUAL_API_PORT ?? 4901),
  dbPort: Number(process.env.VISUAL_DB_PORT ?? 4902),
  webPort: Number(process.env.VISUAL_WEB_PORT ?? 5186),
};
const tours = new Set((process.env.VISUAL_TOURS ?? "setup,base,closeout,notifications").split(",").map((t) => t.trim()).filter(Boolean));
const receiverPort = Number(process.env.VISUAL_RECEIVER_PORT ?? 4903);

const recorder = new Recorder();
const shots: string[] = [];
const log = (message: string) => console.log(`[visual] ${message}`);

function slug(db: Database): string {
  return db.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const debug = process.env.VISUAL_DEBUG === "1";
let lastMark = Date.now();

function mark(label: string): void {
  if (debug) console.log(`[visual] ${String(Date.now() - lastMark).padStart(6)} ms  ${label}`);
  lastMark = Date.now();
}

async function shoot(page: Page, name: string, width: number, full = true): Promise<void> {
  const path = await capture(page, shotsDir!, `${name}-${width}`, recorder, { full });
  shots.push(path);
  mark(`captured ${name}-${width}`);
}

async function visit(page: Page, base: string, path: string): Promise<void> {
  await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 30_000 }).catch(() => undefined);
  mark(`loaded ${path}`);
  await settle(page);
  mark(`settled ${path}`);
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await Bun.sleep(400);
}

async function waitForText(page: Page, text: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
  await settle(page, 300);
}

async function databaseTabs(page: Page, base: string, db: Database, width: number, prefix: string): Promise<void> {
  await visit(page, base, `/databases/${db.id}`);
  const hrefs = await page.$$eval('[role="tablist"] a[role="tab"]', (els) => els.map((el) => [el.textContent?.trim().toLowerCase() ?? "", el.getAttribute("href") ?? ""]));
  for (const [tab, href] of hrefs) {
    await visit(page, base, href!);
    await shoot(page, `${prefix}-${slug(db)}-${tab}`, width);
  }
}

async function upload(page: Page, selector: string, file: string, readyText: string): Promise<void> {
  const input = await page.waitForSelector(selector, { timeout: 10_000 });
  await (input as unknown as { uploadFile: (path: string) => Promise<void> }).uploadFile(file);
  await waitForText(page, readyText, 60_000);
}

async function paletteCheck(page: Page, width: number, db: Database): Promise<void> {
  await page.keyboard.press("/");
  await page.waitForSelector("[cmdk-input]", { timeout: 10_000 });
  await settle(page, 400);
  await shoot(page, "palette", width, false);
  const titles = await page.$$eval("[cmdk-item]", (els) => els.map((el) => el.textContent?.trim() ?? ""));
  const expected = [
    "Create checkpoint",
    "Open history",
    `Replace data in ${db.displayName} from file`,
    "Open query console",
    "New database",
    "New mirror database",
    "Import database from file",
    "Open network access",
    "Go to Data API",
    "Toggle theme",
  ];
  for (const title of expected) {
    if (!titles.some((t) => t.startsWith(title))) recorder.add("missing", `command palette has no “${title}”`);
  }
  await closeOverlay(page);
}

async function adminTour(context: BrowserContext, base: string, data: Seeded, scratch: string, width: number): Promise<void> {
  const page = await openPage(context, recorder, width);
  await signIn(page, base, ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const crm = legacyCrmSqlite(scratch);

  const pages: [string, string][] = [
    ["/", "dashboard"],
    ["/databases", "databases"],
    ["/auth", "auth"],
    ["/data-api", "data-api"],
    ["/storage", "storage"],
    ["/realtime", "realtime"],
    ["/functions", "functions"],
    ["/activity", "activity"],
    ["/users", "users"],
    ["/network", "network"],
    ["/settings", "settings"],
  ];
  for (const [path, name] of pages) {
    await visit(page, base, path);
    await shoot(page, name, width);
  }

  await visit(page, base, "/databases");
  await clickText(page, "List");
  await settle(page, 300);
  await shoot(page, "databases-list", width);
  await clickText(page, "Grid");

  for (const db of [data.storefront, data.replica, data.fieldNotes]) await databaseTabs(page, base, db, width, "database");

  await visit(page, base, `/databases/${data.storefront.id}/history/new`);
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await shoot(page, "dialog-create-checkpoint", width, false);
  await visit(page, base, `/databases/${data.storefront.id}/history/${encodeURIComponent(data.storefrontHead.id)}`);
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await settle(page, 400);
  await shoot(page, "drawer-checkpoint", width, false);
  await visit(page, base, `/databases/${data.storefront.id}/history`);
  await page.click(`[aria-label="Actions for ${data.storefrontOlder.shortHash}"]`);
  await Bun.sleep(300);
  await clickText(page, "Roll back to this", "[role=menuitem]");
  await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 10_000 });
  await settle(page, 600);
  await shoot(page, "dialog-rollback", width, false);
  await closeOverlay(page);

  await visit(page, base, `/databases/${data.analytics.id}`);
  await clickText(page, "Rotate password");
  await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 10_000 });
  await shoot(page, "dialog-rotate-password", width, false);
  await clickText(page, "Rotate password", '[role="alertdialog"] button, [role="dialog"] button');
  await waitForText(page, "I've saved it");
  await shoot(page, "dialog-credentials", width, false);
  await clickText(page, "I've saved it");

  await visit(page, base, `/databases/${data.fieldNotes.id}/import`);
  await upload(page, 'main input[type="file"]', crm, "Replace data…");
  await shoot(page, "database-field-notes-import-plan", width);
  await clickText(page, "Replace data…");
  await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 10_000 });
  await shoot(page, "dialog-replace-data", width, false);
  await closeOverlay(page);
  await clickText(page, "Choose another file");

  for (const type of ["standard", "mirror", "import"]) {
    await visit(page, base, `/databases?new=${type}`);
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    await settle(page, 300);
    await shoot(page, `dialog-create-${type}`, width, false);
  }
  await upload(page, '[role="dialog"] input[type="file"]', crm, "Access and options");
  await shoot(page, "dialog-create-import-plan", width, false);
  await clickText(page, "Cancel", '[role="dialog"] button');

  await visit(page, base, `/databases/${data.storefront.id}`);
  await paletteCheck(page, width, data.storefront);

  await page.click('header [aria-label="Background jobs"], header [aria-label$="running job"], header [aria-label$="running jobs"]');
  await settle(page, 300);
  await shoot(page, "popover-jobs", width, false);
  await closeOverlay(page);
  await page.click('header [aria-label^="Activity"]');
  await settle(page, 300);
  await shoot(page, "popover-activity", width, false);
  await closeOverlay(page);

  await visit(page, base, "/auth");
  await clickText(page, "New app user");
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await shoot(page, "dialog-new-app-user", width, false);
  await closeOverlay(page);
  await visit(page, base, "/users");
  await clickText(page, "Add user");
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await shoot(page, "dialog-add-user", width, false);
  await closeOverlay(page);

  if (width < 1024) {
    await visit(page, base, "/");
    await page.click('[aria-label="Open navigation"]');
    await settle(page, 400);
    await shoot(page, "navigation", width, false);
    await closeOverlay(page);
  }
  await page.close();
}

async function roleTour(context: BrowserContext, base: string, account: Account, role: string, dbs: Database[], width: number): Promise<void> {
  const page = await openPage(context, recorder, width);
  await signIn(page, base, account.email, account.password);
  for (const [path, name] of [
    ["/", "dashboard"],
    ["/databases", "databases"],
    ["/data-api", "data-api"],
    ["/storage", "storage"],
    ["/functions", "functions"],
    ["/network", "network"],
    ["/settings", "settings"],
  ] as const) {
    await visit(page, base, path);
    await shoot(page, `${role}-${name}`, width);
  }
  for (const db of dbs) await databaseTabs(page, base, db, width, role);
  await page.close();
}

async function setupScreens(base: string, width: number, setupToken: string): Promise<void> {
  const browser = await launch();
  try {
    const context = await browser.createBrowserContext();
    const page = await openPage(context, recorder, width);
    await page.setExtraHTTPHeaders(LAN_CLIENT);
    await visit(page, base, "/");
    await page.waitForSelector("#setup-token input", { timeout: 15_000 });
    await shoot(page, "setup-token", width);
    await page.type("#setup-token input", setupToken);
    await page.keyboard.press("Enter");
    await waitForText(page, "Where should LambData keep its data?");
    const checked = await page
      .waitForFunction(() => /Writable|Will be created|Exists, /.test(document.body.innerText), { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!checked) {
      const text = await page.evaluate(() => document.body.innerText);
      recorder.add(
        "missing",
        /can only be checked from the server itself/.test(text)
          ? "the setup wizard's folder check was refused: the setup token was not accepted"
          : "the setup wizard did not show the folder check",
      );
    }
    await settle(page, 300);
    await shoot(page, "setup-storage", width);
    await page.close();
  } finally {
    await browser.close();
  }
}

interface MockRule {
  method?: string;
  path: string;
  search?: Record<string, string | null>;
  status?: number;
  bodies: unknown[];
}

interface SeenRequest {
  method: string;
  path: string;
  body: string | null;
  contentType: string | null;
}

type MockWindow = Window & { __ldMocks?: MockRule[]; __ldSeen?: SeenRequest[] };

const mockScripts = new WeakMap<Page, string>();

async function installMockFetch(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const w = window as MockWindow;
    const original = window.fetch.bind(window);
    const counters = new Map<number, number>();
    w.__ldSeen = [];
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.origin);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const rules = w.__ldMocks ?? [];
      const index = rules.findIndex(
        (rule) =>
          (rule.method ?? "GET") === method &&
          rule.path === url.pathname &&
          Object.entries(rule.search ?? {}).every(([key, value]) => (value === null ? !url.searchParams.has(key) : url.searchParams.get(key) === value)),
      );
      if (index < 0) return original(input, init);
      const rule = rules[index]!;
      const count = counters.get(index) ?? 0;
      counters.set(index, count + 1);
      w.__ldSeen!.push({
        method,
        path: url.pathname,
        body: typeof init?.body === "string" ? init.body : init?.body === undefined ? null : "[binary]",
        contentType: new Headers(init?.headers).get("content-type"),
      });
      const body = rule.bodies[Math.min(count, rule.bodies.length - 1)];
      return new Response(JSON.stringify(body), { status: rule.status ?? 200, headers: { "content-type": "application/json" } });
    };
  });
}

async function setMocks(page: Page, rules: MockRule[]): Promise<void> {
  const previous = mockScripts.get(page);
  if (previous) await page.removeScriptToEvaluateOnNewDocument(previous);
  const { identifier } = await page.evaluateOnNewDocument((r: MockRule[]) => {
    (window as MockWindow).__ldMocks = r;
  }, rules);
  mockScripts.set(page, identifier);
  await page.evaluate((r: MockRule[]) => {
    (window as MockWindow).__ldMocks = r;
  }, rules).catch(() => undefined);
}

async function shootElement(page: Page, selector: string, name: string, width: number): Promise<void> {
  recorder.at(`${name}-${width}`);
  const element = await page.$(selector);
  if (!element) {
    recorder.add("missing", `${selector} is not on the page`);
    return;
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) recorder.add("overflow", `${overflow}px wider than the viewport`);
  const path = `${shotsDir}/${name}-${width}.png`;
  await element.screenshot({ path: path as `${string}.png` });
  shots.push(path);
  mark(`captured ${name}-${width}`);
}

const CODE_FAILURES: CodeObjectFailure[] = [
  {
    kind: "view",
    name: "monthly_revenue",
    error: "The view reads reporting.fx_rates, a table outside this database, which LambData does not re-create automatically.",
  },
  { kind: "trigger", name: "orders_before_insert", error: "Unknown column 'discount_cents' in 'NEW'" },
];

const LIMITATIONS = [
  "view monthly_revenue could not be queried when this checkpoint was taken (it refers to a table, column or function that does not exist); rolling back keeps or re-creates it only where MariaDB accepts its definition",
];

function unconvertedFor(databaseId: string): UnconvertedSnapshot[] {
  const now = Date.now();
  return [
    {
      snapshotId: "visual-snap-1",
      databaseId,
      createdAt: now - 41 * 86_400_000,
      trigger: "scheduled",
      sizeBytes: 2_481_920,
      reason: "the snapshot file ends in the middle of a statement (gzip stream truncated at 2.3 MB); it cannot be loaded as it is",
      failedAt: now - 2 * 3_600_000,
      attempts: 3,
    },
    {
      snapshotId: "visual-snap-2",
      databaseId,
      createdAt: now - 58 * 86_400_000,
      trigger: "manual",
      sizeBytes: 1_102_336,
      reason: "the snapshot file is missing from the snapshots folder",
      failedAt: now - 2 * 3_600_000,
      attempts: 1,
    },
  ];
}

function mockJob(partial: Partial<Job> & Pick<Job, "id" | "kind" | "status">): Job {
  const now = Date.now();
  const finished = partial.status === "succeeded" || partial.status === "failed";
  return {
    databaseId: null,
    stage: null,
    progress: partial.status === "succeeded" ? 1 : null,
    error: null,
    errorCode: null,
    errorDetails: null,
    warnings: [],
    result: null,
    createdByUserId: null,
    createdAt: now - 5 * 60_000,
    startedAt: now - 5 * 60_000,
    finishedAt: finished ? now - 2 * 60_000 : null,
    ...partial,
  };
}

async function closeoutTour(context: BrowserContext, base: string, data: Seeded, admin: ApiClient, width: number): Promise<void> {
  const page = await openPage(context, recorder, width);
  await installMockFetch(page);
  await signIn(page, base, ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const sf = data.storefront;
  const older = data.storefrontOlder;
  const list = await admin.get<CheckpointListResponse>(`/api/databases/${sf.id}/checkpoints`);
  const headId = list.checkpoints.find((cp) => cp.isBase)?.id ?? data.storefrontHead.id;
  const verifiedAt = Date.now() - 3 * 3_600_000;
  const decorated: CheckpointListResponse = {
    ...list,
    checkpoints: list.checkpoints.map((cp) =>
      cp.id === headId ? { ...cp, limitations: LIMITATIONS } : cp.id === older.id ? { ...cp, verifiedAt } : cp,
    ),
    unconverted: unconvertedFor(sf.id),
  };
  const health = await admin.get<HealthDetail>("/api/health/detail");
  const healthBody: HealthDetail = {
    ...health,
    checkpoints: { unconvertedSnapshots: 2, lastConversionError: "the snapshot file is missing from the snapshots folder" },
  };
  const refused = mockJob({
    id: "visual-refused",
    kind: "checkpoint.restore",
    status: "failed",
    databaseId: sf.id,
    progress: 0.55,
    stage: "Checking that every view, trigger and routine can be re-created",
    error: `Rolling back to ${older.shortHash} was stopped before anything changed: a trial run in the staging copy showed that some of its views, triggers or routines cannot be re-created here, so the live database was left exactly as it was. these could not be re-created: view monthly_revenue (the view reads reporting.fx_rates, a table outside this database, which LambData does not re-create automatically), trigger orders_before_insert (Unknown column 'discount_cents' in 'NEW').`,
    errorCode: "restore.code-unrestorable",
    errorDetails: { codeFailures: CODE_FAILURES },
  });
  const forcedRunning = mockJob({
    id: "visual-forced",
    kind: "checkpoint.restore",
    status: "running",
    databaseId: sf.id,
    progress: 0.3,
    stage: `Loading ${older.shortHash} into a staging copy`,
    startedAt: Date.now() - 4_000,
    createdAt: Date.now() - 4_000,
  });
  const forcedDone: Job = {
    ...forcedRunning,
    status: "succeeded",
    progress: 1,
    finishedAt: Date.now(),
    warnings: [
      `Rolled back anyway: the tables of ${older.shortHash} are back, but 2 view(s), trigger(s) or routine(s) could not be re-created and are now missing from the live database: view monthly_revenue, trigger orders_before_insert. Their previous definitions are in checkpoint ${data.storefrontHead.shortHash}, saved before this rollback.`,
      "could not re-create view monthly_revenue: The view reads reporting.fx_rates, a table outside this database, which LambData does not re-create automatically.",
      "view sales_summary is kept as recorded but cannot be queried: it refers to a table, column or function that does not exist",
    ],
    result: { restoredCheckpointId: older.id, safetyCheckpointId: headId, outcome: "done-with-errors", codeFailures: CODE_FAILURES },
  };
  const failedVerify = mockJob({
    id: "visual-failed",
    kind: "checkpoint.restore",
    status: "failed",
    databaseId: sf.id,
    error: `Rolling back to ${older.shortHash} was stopped before anything changed: after loading the checkpoint into a staging copy, it did not match what the checkpoint recorded, so the live database was left exactly as it was. table orders: 24 rows recorded, 23 loaded; table products: the checksum of the loaded rows differs from the one recorded.`,
    finishedAt: Date.now() - 30 * 60_000,
  });
  const syncJob = mockJob({
    id: "visual-sync",
    kind: "sync.run",
    status: "succeeded",
    databaseId: data.replica.id,
    warnings: ["could not re-create view monthly_revenue: The view reads reporting.fx_rates, a table outside this database, which LambData does not re-create automatically."],
    result: { status: "ok", tables: 3, preSyncCheckpointId: null, checkpointId: null, unchanged: false, outcome: "done-with-errors", codeFailures: CODE_FAILURES.slice(0, 1) },
  });
  const importRunning = mockJob({
    id: "visual-import",
    kind: "import.sql",
    status: "running",
    databaseId: data.fieldNotes.id,
    progress: 0.8,
    stage: "Loading the dump into a staging copy",
  });
  const importDone: Job = {
    ...importRunning,
    status: "succeeded",
    progress: 1,
    finishedAt: Date.now() - 60_000,
    warnings: [
      "The data was replaced, but 1 view(s), trigger(s), routine(s) or event(s) from the file could not be created and are missing from the database: trigger orders_before_insert (Unknown column 'discount_cents' in 'NEW').",
    ],
    result: {
      importId: "visual-import-record",
      tableCount: 2,
      rowCount: 30,
      safetyCheckpointId: null,
      checkpointId: null,
      durationMs: 2_400,
      outcome: "done-with-errors",
      codeFailures: CODE_FAILURES.slice(1),
    },
  };
  const shared: MockRule[] = [
    { path: "/api/health/detail", bodies: [healthBody] },
    { path: `/api/databases/${sf.id}/checkpoints`, bodies: [decorated] },
  ];

  await setMocks(page, [
    ...shared,
    { path: "/api/jobs", search: { databaseId: sf.id, limit: "8", active: null }, bodies: [{ jobs: [refused] }] },
    { path: "/api/jobs", search: { databaseId: sf.id, active: "1" }, bodies: [{ jobs: [] }] },
    { method: "POST", path: `/api/databases/${sf.id}/checkpoints/${older.id}/restore`, status: 202, bodies: [{ job: forcedRunning }] },
    { path: `/api/jobs/${forcedRunning.id}`, bodies: [{ job: forcedRunning }, { job: forcedDone }] },
  ]);
  await visit(page, base, `/databases/${sf.id}/history`);
  await waitForText(page, "Roll back anyway");
  await shoot(page, "closeout-history-refused", width);
  await clickText(page, "Roll back anyway…");
  await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
  await settle(page, 500);
  await shoot(page, "closeout-dialog-force-rollback", width, false);
  await clickText(page, "Roll back anyway", '[role="alertdialog"] button');
  await waitForText(page, "with errors", 20_000);
  await settle(page, 800);
  await shoot(page, "closeout-history-done-with-errors", width);
  const seen = await page.evaluate(() => (window as MockWindow).__ldSeen ?? []);
  const post = seen.find((s) => s.method === "POST" && s.path.endsWith("/restore"));
  if (!post) recorder.add("missing", "Roll back anyway sent no restore request");
  else if (post.body !== '{"allowCodeFailures":true}' || post.contentType !== "application/json") {
    recorder.add("missing", `Roll back anyway sent ${post.contentType ?? "no content type"} with body ${post.body ?? "none"}`);
  }

  const detail = await admin.get<CheckpointDetailResponse>(`/api/databases/${sf.id}/checkpoints/${encodeURIComponent(headId)}`);
  await setMocks(page, [
    ...shared,
    { path: "/api/jobs", search: { databaseId: sf.id, limit: "8", active: null }, bodies: [{ jobs: [] }] },
    {
      path: `/api/databases/${sf.id}/checkpoints/${headId}`,
      bodies: [{ ...detail, checkpoint: { ...detail.checkpoint, limitations: LIMITATIONS, verifiedAt } }],
    },
  ]);
  await visit(page, base, `/databases/${sf.id}/history/${encodeURIComponent(headId)}`);
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await waitForText(page, "Captured with a limitation");
  await shoot(page, "closeout-drawer-limitations", width, false);

  await visit(page, base, `/databases/${sf.id}/history/new`);
  await page.waitForSelector('[role="dialog"] button[role="checkbox"]', { timeout: 10_000 });
  await page.click('[role="dialog"] button[role="checkbox"]');
  await settle(page, 300);
  await shoot(page, "closeout-dialog-create-verify", width, false);
  await closeOverlay(page);

  await setMocks(page, [
    ...shared,
    { path: "/api/jobs", search: { databaseId: data.replica.id, limit: "8", active: null }, bodies: [{ jobs: [syncJob] }] },
  ]);
  await visit(page, base, `/databases/${data.replica.id}/sync`);
  await waitForText(page, "finished with errors");
  await shoot(page, "closeout-sync-done-with-errors", width);

  await setMocks(page, [
    ...shared,
    { path: "/api/jobs", search: { databaseId: data.fieldNotes.id, active: "1" }, bodies: [{ jobs: [importRunning] }, { jobs: [] }] },
    { path: `/api/jobs/${importRunning.id}`, bodies: [{ job: importDone }] },
  ]);
  await visit(page, base, `/databases/${data.fieldNotes.id}/import`);
  await waitForText(page, "Finished with errors");
  await shoot(page, "closeout-import-done-with-errors", width);

  await setMocks(page, [
    ...shared,
    {
      path: "/api/jobs",
      search: { limit: "10", databaseId: null, active: null },
      bodies: [{ jobs: [{ ...forcedDone, finishedAt: Date.now() - 60_000 }, refused, importDone, syncJob, failedVerify] }],
    },
  ]);
  await visit(page, base, "/");
  await waitForText(page, "could not be converted");
  await shoot(page, "closeout-dashboard-unconverted", width);
  await page.click('header [aria-label="Background jobs"], header [aria-label$="running job"], header [aria-label$="running jobs"]');
  await settle(page, 400);
  await shoot(page, "closeout-popover-jobs", width, false);
  await closeOverlay(page);

  await setMocks(page, shared.slice(0, 1));
  await visit(page, base, "/dev/kit#kit-operations");
  await page.waitForSelector('[data-kit="operation-states"]', { timeout: 15_000 });
  await page.evaluate(() => document.getElementById("kit-operations")?.scrollIntoView());
  await settle(page, 600);
  await shootElement(page, "#kit-operations", "closeout-kit-states", width);
  await clickText(page, "Roll back anyway…");
  await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
  await settle(page, 500);
  await shoot(page, "closeout-kit-force-dialog", width, false);
  await closeOverlay(page);
  await page.close();
}

async function scrollInDialog(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "start" }), selector);
  await Bun.sleep(350);
}

async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.click(selector, { count: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

async function openDialogFor(page: Page, base: string, path: string): Promise<void> {
  await visit(page, base, path);
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await settle(page, 400);
}

async function paletteNotifications(page: Page, width: number): Promise<void> {
  await page.keyboard.press("/");
  await page.waitForSelector("[cmdk-input]", { timeout: 10_000 });
  await page.type("[cmdk-input]", "notif");
  await settle(page, 400);
  await shoot(page, "notify-palette", width, false);
  const titles = await page.$$eval("[cmdk-item]", (els) => els.map((el) => el.textContent?.trim() ?? ""));
  for (const title of ["Add notification destination", "Go to Notifications"]) {
    if (!titles.some((t) => t.startsWith(title))) recorder.add("missing", `command palette has no “${title}”`);
  }
  await closeOverlay(page);
}

const notifyRule = (path: string, bodies: unknown[], extra: Partial<MockRule> = {}): MockRule => ({ path: `/api/notifications${path}`, bodies, ...extra });

async function notificationsTour(context: BrowserContext, base: string, databases: Database[], width: number): Promise<void> {
  const page = await openPage(context, recorder, width);
  await installMockFetch(page);
  await signIn(page, base, ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const now = Date.now();
  const list = fixtureDestinations(now, databases.map((d) => d.id));
  const catalog = notifyRule("/events", [fixtureCatalog]);

  const created: NotificationDestination = {
    ...list[1]!,
    id: "nd_new",
    name: "Home Assistant",
    target: "https://example.com",
    health: "new",
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    events: fixtureCatalog.events.filter((e) => e.defaultOn).map((e) => e.type),
    databaseIds: null,
  };
  await setMocks(page, [
    catalog,
    notifyRule("/destinations", [{ destinations: [] }, { destinations: [created] }]),
    notifyRule("/destinations", [{ destination: created }], { method: "POST", status: 201 }),
  ]);
  await visit(page, base, "/notifications");
  await waitForText(page, "Get a message when something happens");
  await shoot(page, "notify-empty", width);

  await clickText(page, "Discord", "main button");
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await settle(page, 400);
  await shoot(page, "notify-dialog-discord", width, false);
  await typeInto(page, '[role="dialog"] input[placeholder^="https://discord.com"]', "https://example.com/not-a-discord-hook");
  await page.click('[role="dialog"] [data-event-group="Databases"] button[role="checkbox"]');
  await clickText(page, "Add destination", '[role="dialog"] button');
  await settle(page, 700);
  await scrollInDialog(page, '[role="dialog"] form section:nth-of-type(2)');
  await shoot(page, "notify-dialog-discord-errors", width, false);
  await closeOverlay(page);

  await openDialogFor(page, base, "/notifications?add=");
  await shoot(page, "notify-dialog-pick", width, false);
  await closeOverlay(page);

  await openDialogFor(page, base, "/notifications?add=slack");
  await clickText(page, "Mattermost", '[role="dialog"] [role="radio"]');
  await settle(page, 300);
  await shoot(page, "notify-dialog-slack", width, false);
  await closeOverlay(page);

  await openDialogFor(page, base, "/notifications?add=ntfy");
  await clickText(page, "Suggest one", '[role="dialog"] button');
  await settle(page, 300);
  await shoot(page, "notify-dialog-ntfy", width, false);
  await closeOverlay(page);

  await openDialogFor(page, base, "/notifications?add=webhook");
  await typeInto(page, '[role="dialog"] input[placeholder="https://example.com/hooks/lambdata"]', "https://example.com/hooks/lambdata");
  await clickText(page, "Generate", '[role="dialog"] button');
  await clickText(page, "Add header", '[role="dialog"] button');
  await typeInto(page, '[role="dialog"] input[aria-label="Header 1 name"]', "X-Team");
  await typeInto(page, '[role="dialog"] input[aria-label="Header 1 value"]', "ops");
  const nameInput = '[role="dialog"] input[placeholder="Webhook"]';
  await typeInto(page, nameInput, "Home Assistant");
  await scrollInDialog(page, '[role="dialog"] input[placeholder="https://example.com/hooks/lambdata"]');
  await shoot(page, "notify-dialog-webhook", width, false);
  await page.click('[role="dialog"] [data-event-group="Mirrors"] button[aria-expanded]');
  await settle(page, 400);
  await scrollInDialog(page, '[role="dialog"] [data-event-group="Checkpoints"]');
  await shoot(page, "notify-dialog-events", width, false);
  await clickText(page, "Only the databases I pick", '[role="dialog"] label');
  await clickText(page, databases[0]!.displayName, '[role="dialog"] label');
  await scrollInDialog(page, '[role="dialog"] form section:nth-of-type(4)');
  await shoot(page, "notify-dialog-scope", width, false);
  await clickText(page, "Use your own", '[role="dialog"] button');
  await settle(page, 300);
  await scrollInDialog(page, '[role="dialog"] form section:nth-of-type(5)');
  await shoot(page, "notify-dialog-icon", width, false);
  await clickText(page, "Use the LambData icon", '[role="dialog"] button');
  await clickText(page, "Add destination", '[role="dialog"] button');
  await waitForText(page, "Home Assistant added");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 });
  await settle(page, 600);
  await shoot(page, "notify-added", width);
  const seen = await page.evaluate(() => (window as MockWindow).__ldSeen ?? []);
  const post = seen.find((s) => s.method === "POST" && s.path === "/api/notifications/destinations");
  if (!post) recorder.add("missing", "adding a webhook sent no create request");
  else {
    const body = JSON.parse(post.body ?? "{}");
    const config = body.config ?? {};
    const problems = [
      post.contentType !== "application/json" && `content type ${post.contentType}`,
      body.kind !== "webhook" && `kind ${body.kind}`,
      config.url !== "https://example.com/hooks/lambdata" && `url ${config.url}`,
      !/^[0-9a-f]{48}$/.test(config.secret ?? "") && "no generated secret",
      JSON.stringify(config.headers) !== '{"X-Team":"ops"}' && `headers ${JSON.stringify(config.headers)}`,
      JSON.stringify(body.databaseIds) !== JSON.stringify([databases[0]!.id]) && `databaseIds ${JSON.stringify(body.databaseIds)}`,
      body.iconUrl !== null && `iconUrl ${body.iconUrl}`,
      body.name !== "Home Assistant" && `name ${body.name}`,
    ].filter(Boolean);
    if (problems.length > 0) recorder.add("missing", `the create request was wrong: ${problems.join(", ")}`);
  }

  await setMocks(page, [
    catalog,
    notifyRule("/destinations", [{ destinations: list }]),
    notifyRule("/destinations/nd_home/deliveries", [{ deliveries: fixtureDeliveries(Date.now(), "nd_home") }], { search: { limit: "20" } }),
    notifyRule("/destinations/nd_ops/test", [fixtureTestOk], { method: "POST" }),
    notifyRule("/destinations/nd_home/test", [fixtureTestNotFound], { method: "POST" }),
    notifyRule("/destinations/nd_ops/deliveries", [{ deliveries: [] }], { search: { limit: "20" } }),
  ]);
  await visit(page, base, "/notifications");
  await waitForText(page, "Home automation");
  await shoot(page, "notify-list", width);
  await clickText(page, "Send test", '[data-destination="nd_ops"] button');
  await waitForText(page, "Test message sent");
  await clickText(page, "Send test", '[data-destination="nd_home"] button');
  await waitForText(page, "The test was not delivered");
  await page.evaluate(() => document.querySelector('[data-destination="nd_ops"]')?.scrollIntoView({ block: "start" }));
  await shoot(page, "notify-test-results", width);
  await page.click('[data-destination="nd_home"] button[aria-controls="deliveries-nd_home"]');
  await waitForText(page, "Sync failed: Game Mirror");
  await shoot(page, "notify-deliveries", width);

  await page.click('[data-destination="nd_home"] button[aria-label="Edit Home automation"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await settle(page, 400);
  await shoot(page, "notify-dialog-edit", width, false);
  await page.click('[role="dialog"] [aria-label="Replace the address"]');
  await page.click('[role="dialog"] [aria-label="Replace the signing secret"]');
  await settle(page, 300);
  await shoot(page, "notify-dialog-edit-replace", width, false);
  await closeOverlay(page);
  await page.click('[data-destination="nd_phone"] button[aria-label="Edit My phone"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await settle(page, 400);
  await shoot(page, "notify-dialog-edit-ntfy", width, false);
  await closeOverlay(page);
  await page.click('[aria-label="Delete Team chat"]');
  await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
  await settle(page, 400);
  await shoot(page, "notify-confirm-delete", width, false);
  await closeOverlay(page);

  await paletteNotifications(page, width);

  await visit(page, base, "/");
  await waitForText(page, "are failing");
  await shoot(page, "notify-dashboard-failing", width);
  if (width < 1024) {
    await page.click('[aria-label="Open navigation"]');
    await settle(page, 400);
    await shoot(page, "notify-navigation", width, false);
    await closeOverlay(page);
  }
  await page.close();

  const viewer = await openPage(context, recorder, width);
  await signIn(viewer, base, ACCOUNTS.viewer.email, ACCOUNTS.viewer.password);
  await visit(viewer, base, "/notifications");
  await waitForText(viewer, "Admins only");
  const navHasIt = await viewer.evaluate(() => !!document.querySelector('nav a[href="/notifications"]'));
  if (navHasIt) recorder.add("missing", "a viewer sees Notifications in the sidebar");
  await shoot(viewer, "notify-viewer", width);
  await viewer.close();
}

async function realNotificationsAvailable(admin: ApiClient): Promise<boolean> {
  try {
    await admin.get("/api/notifications/events");
    await admin.get<NotificationDestinationListResponse>("/api/notifications/destinations");
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    throw error;
  }
}

async function notificationsRealTour(context: BrowserContext, base: string, admin: ApiClient, receiver: Receiver, width: number): Promise<void> {
  const page = await openPage(context, recorder, width);
  await signIn(page, base, ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const suffix = String(width);

  await openDialogFor(page, base, "/notifications?add=webhook");
  await typeInto(page, '[role="dialog"] input[placeholder="https://example.com/hooks/lambdata"]', `${receiver.url}/hook-${suffix}`);
  await clickText(page, "Generate", '[role="dialog"] button');
  const secret = await page.$eval('[role="dialog"] input[placeholder="No secret"]', (el) => (el as HTMLInputElement).value);
  await typeInto(page, '[role="dialog"] input[placeholder="Webhook"]', `Local receiver ${suffix}`);
  await clickText(page, "Add destination", '[role="dialog"] button');
  await waitForText(page, `Local receiver ${suffix} added`);
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 });
  const destinations = (await admin.get<NotificationDestinationListResponse>("/api/notifications/destinations")).destinations;
  const hook = destinations.find((d) => d.name === `Local receiver ${suffix}`);
  if (!hook) throw new Error("the webhook destination created in the console is not in the API's list");
  const card = `[data-destination="${hook.id}"]`;
  await clickText(page, "Send test", `${card} button`);
  await page.waitForFunction((sel) => !!document.querySelector(`${sel} [data-test-result]`), { timeout: 20_000 }, card);
  const testHit = await waitForRequest(receiver, (r) => r.path === `/hook-${suffix}`);
  if (!testHit) recorder.add("missing", "the receiver got no test message");
  else if (!signatureMatches(testHit, secret)) recorder.add("missing", "the test message's X-LambData-Signature does not match the secret typed in the console");
  await settle(page, 400);
  await shoot(page, "notify-real-test", width);

  await openDialogFor(page, base, "/notifications?add=ntfy");
  await clickText(page, "Suggest one", '[role="dialog"] button');
  await typeInto(page, '[role="dialog"] input[placeholder="https://ntfy.sh"]', receiver.url);
  await typeInto(page, '[role="dialog"] input[placeholder="My phone"]', `Phone via receiver ${suffix}`);
  await clickText(page, "Add destination", '[role="dialog"] button');
  await waitForText(page, `Phone via receiver ${suffix} added`);
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 });

  await openDialogFor(page, base, "/notifications?add=webhook");
  await typeInto(page, '[role="dialog"] input[placeholder="https://example.com/hooks/lambdata"]', `${receiver.url}/missing-${suffix}`);
  await typeInto(page, '[role="dialog"] input[placeholder="Webhook"]', `Broken hook ${suffix}`);
  await clickText(page, "Add destination", '[role="dialog"] button');
  await waitForText(page, `Broken hook ${suffix} added`);
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 });

  const all = (await admin.get<NotificationDestinationListResponse>("/api/notifications/destinations")).destinations;
  for (const name of [`Phone via receiver ${suffix}`, `Broken hook ${suffix}`]) {
    const dest = all.find((d) => d.name === name);
    if (!dest) continue;
    await clickText(page, "Send test", `[data-destination="${dest.id}"] button`);
    await page.waitForFunction((sel) => !!document.querySelector(`${sel} [data-test-result]`), { timeout: 20_000 }, `[data-destination="${dest.id}"]`);
  }
  const ntfyHit = await waitForRequest(receiver, (r) => r.path === "/" && r.method === "POST" && r.body.includes('"topic"'));
  if (!ntfyHit) recorder.add("missing", "the receiver got no ntfy publish");

  const before = receiver.received.length;
  const db = await admin.post<{ database: Database }>("/api/databases", { displayName: `Notify Check ${suffix}` });
  const event = await waitForRequest(receiver, (r) => receiver.received.indexOf(r) >= before && r.path === `/hook-${suffix}` && r.body.includes("database.created"), 30_000);
  if (!event) recorder.add("missing", `creating ${db.database.displayName} sent nothing to the receiver`);
  await visit(page, base, "/notifications");
  await page.click(`${card} button[aria-controls="deliveries-${hook.id}"]`);
  await page.waitForSelector(`${card} [data-delivery-status]`, { timeout: 15_000 }).catch(() => undefined);
  await settle(page, 1_500);
  await shoot(page, "notify-real-list", width);
  await visit(page, base, "/");
  await shoot(page, "notify-real-dashboard", width);
  await page.close();
}

const LONG_NETWORK_WARNINGS = [
  "Requests reach LambData through a forwarder on this same machine (127.0.0.1), so every client looks like the server itself and the local-network switch cannot tell them apart. Connect directly, or add the forwarder under Trusted proxies so LambData reads the real client address from X-Forwarded-For.",
  "Cloudflare Access is required for the console, but the app-facing APIs (Data API, App Auth, functions, realtime and public files) stay reachable through the tunnel without it. Turn on Also restrict app-facing APIs if apps should go through Access as well.",
];

async function polishTour(context: BrowserContext, base: string, admin: ApiClient, width: number): Promise<void> {
  const page = await openPage(context, recorder, width);
  await installMockFetch(page);
  await signIn(page, base, ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const network = await admin.get<NetworkStatusResponse>("/api/network/status");
  await setMocks(page, [{ path: "/api/network/status", bodies: [{ status: { ...network.status, warnings: LONG_NETWORK_WARNINGS } }] }]);
  await visit(page, base, "/network");
  await waitForText(page, "Check these settings");
  await shoot(page, "polish-network-warnings", width, false);
  const above = await page.evaluate(() => {
    const alert = Array.from(document.querySelectorAll("main [class*='border-warn']")).find((el) => (el as HTMLElement).innerText.includes("Check these settings"));
    return alert ? alert.getBoundingClientRect().top < window.innerHeight : false;
  });
  if (!above) recorder.add("missing", "the network warnings are not visible without scrolling");

  await setMocks(page, []);
  await visit(page, base, "/settings#checkpoint-limits");
  await page.waitForSelector("#checkpoint-limits", { timeout: 10_000 });
  await page.evaluate(() => document.getElementById("checkpoint-limits")?.scrollIntoView({ block: "start" }));
  await settle(page, 400);
  await shootElement(page, "#checkpoint-limits", "polish-settings-limits", width);

  await visit(page, base, "/network#cloudflare-tunnel");
  await clickText(page, "Advanced: trusted proxies");
  await settle(page, 400);
  await page.evaluate(() => {
    const field = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.trim() === "Trusted proxies");
    field?.scrollIntoView({ block: "center" });
  });
  await settle(page, 300);
  await shoot(page, "polish-network-trusted-proxies", width, false);

  await visit(page, base, "/dev/kit#kit-operations");
  await page.waitForSelector('[data-kit="operation-states"]', { timeout: 15_000 });
  await page.evaluate(() => document.getElementById("kit-operations")?.scrollIntoView());
  await settle(page, 600);
  await shootElement(page, "#kit-operations", "polish-kit-operations", width);

  const databases = (await admin.get<{ databases: Database[] }>("/api/databases")).databases;
  const db = databases.find((d) => d.displayName === "Storefront") ?? (await admin.post<{ database: Database }>("/api/databases", { displayName: "Storefront" })).database;
  const real = await admin.raw("GET", `/api/databases/${db.id}/set-aside`);
  log(`GET /api/databases/:id/set-aside on the real backend answered ${real.status}`);
  const setAsideRule: MockRule = { path: `/api/databases/${db.id}/set-aside`, bodies: [{ schemas: fixtureSetAside() }] };
  await setMocks(page, [setAsideRule]);
  await visit(page, base, `/databases/${db.id}/history`);
  await waitForText(page, "Tables set aside");
  await shoot(page, "setaside-history", width);
  await clickText(page, "Move back as…", '[data-set-aside-table="orders"] button');
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  await page.click('[role="dialog"] input', { count: 3 });
  await page.keyboard.type("orders");
  await clickText(page, "Move back", '[role="dialog"] button[type="submit"]');
  await settle(page, 300);
  await shoot(page, "setaside-move-back-as", width, false);
  await closeOverlay(page);
  await clickText(page, "Delete all…", '[data-set-aside-kind="kept"] button');
  await page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
  await settle(page, 400);
  await shoot(page, "setaside-confirm-delete", width, false);
  await closeOverlay(page);
  await page.close();

  await admin.post("/api/users", { ...ACCOUNTS.viewer, role: "viewer" }).catch(() => undefined);
  const viewer = await openPage(context, recorder, width);
  await installMockFetch(viewer);
  await signIn(viewer, base, ACCOUNTS.viewer.email, ACCOUNTS.viewer.password);
  await setMocks(viewer, [setAsideRule]);
  await visit(viewer, base, `/databases/${db.id}/history`);
  await waitForText(viewer, "Tables set aside");
  await shoot(viewer, "setaside-viewer", width);
  await viewer.close();
}

let stack: Stack | null = null;
let receiver: Receiver | null = null;
let exitCode = 0;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`[visual] ${signal}: stopping the scratch install`);
    receiver?.stop();
    void (stack ? stack.stop() : Promise.resolve()).finally(() => process.exit(130));
  });
}
try {
  mkdirSync(shotsDir, { recursive: true });
  prepareRoot(root);
  log(`Booting a scratch install in ${root}`);
  stack = await startStack({ repo, root, ...ports });
  const setupToken = await readSetupToken(stack.logDir);
  if (tours.has("setup")) for (const width of widths) await setupScreens(stack.webUrl, width, setupToken);

  const admin = await completeSetup(stack.apiUrl, join(root, "data"), setupToken, log);
  const fullSeed = tours.has("base") || tours.has("closeout");
  const notifyTours = tours.has("notifications") || tours.has("notifications-real");
  const data = fullSeed ? await seed(admin, stack.apiUrl, root, stack.bootedAt, log) : null;
  const notifyDatabases = data ? [data.storefront, data.fieldNotes, data.replica] : notifyTours ? await seedForNotifications(admin, log) : [];
  let realNotifications = false;
  if (tours.has("notifications-real")) {
    realNotifications = await realNotificationsAvailable(admin);
    if (realNotifications) {
      receiver = startReceiver(receiverPort);
      log(`Real notifications routes answer; a local receiver listens on ${receiver.url}`);
    } else {
      log("Skipping the real notifications tour: /api/notifications answers 404 on this build");
    }
  }

  log("Capturing pages");
  const browser = await launch();
  try {
    for (const width of widths) {
      if (data && tours.has("base")) {
        const anonymous = await browser.createBrowserContext();
        const page = await openPage(anonymous, recorder, width);
        await visit(page, stack.webUrl, "/login");
        await shoot(page, "login", width);
        await anonymous.close();

        const adminContext = await browser.createBrowserContext();
        await adminTour(adminContext, stack.webUrl, data, root, width);
        await adminContext.close();

        const ownerContext = await browser.createBrowserContext();
        await roleTour(ownerContext, stack.webUrl, ACCOUNTS.owner, "owner", [data.supportDesk], width);
        await ownerContext.close();

        const viewerContext = await browser.createBrowserContext();
        await roleTour(viewerContext, stack.webUrl, ACCOUNTS.viewer, "viewer", [data.storefront], width);
        await viewerContext.close();
      }

      if (data && tours.has("closeout")) {
        const closeoutContext = await browser.createBrowserContext();
        await closeoutTour(closeoutContext, stack.webUrl, data, admin, width);
        await closeoutContext.close();
      }

      if (tours.has("polish")) {
        const polishContext = await browser.createBrowserContext();
        await polishTour(polishContext, stack.webUrl, admin, width);
        await polishContext.close();
      }

      if (tours.has("notifications")) {
        const notifyContext = await browser.createBrowserContext();
        await notificationsTour(notifyContext, stack.webUrl, notifyDatabases, width);
        await notifyContext.close();
      }

      if (realNotifications && receiver) {
        const realContext = await browser.createBrowserContext();
        await notificationsRealTour(realContext, stack.webUrl, admin, receiver, width);
        await realContext.close();
      }
    }
    if (receiver) log(`The local receiver got ${receiver.received.length} requests`);
  } finally {
    await browser.close();
  }

  log(`${shots.length} screenshots in ${shotsDir}`);
  if (recorder.problems.length === 0) {
    log("No console errors, unexpected HTTP errors, missing commands or horizontal overflow.");
  } else {
    exitCode = 1;
    log(`${recorder.problems.length} problems:`);
    for (const problem of recorder.problems) console.log(`  ${problem.shot.padEnd(42)} ${problem.kind.padEnd(8)} ${problem.detail}`);
  }
} catch (error) {
  exitCode = 1;
  console.error(`[visual] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (stack) console.error(`[visual] Server logs: ${stack.logDir}`);
} finally {
  receiver?.stop();
  if (stack) await stack.stop();
  if (process.env.KEEP_VISUAL_ROOT !== "1" && exitCode === 0) rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
