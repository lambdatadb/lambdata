// Drives Chrome through each authenticated route, captures console errors + screenshots.
import puppeteer from "puppeteer-core";

const BASE = process.env.KILNDB_BASE ?? "http://localhost:5173";
const OUT_DIR =
  process.env.OUT_DIR ??
  (process.platform === "win32" ? `${process.env.TEMP}\\kilndb-shots` : "/tmp/kilndb-shots");
const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome");
const EMAIL = process.env.KILNDB_EMAIL ?? "";
const PASSWORD = process.env.KILNDB_PASSWORD ?? "";

await Bun.write(`${OUT_DIR}/.keep`, "");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 2 });

// Public screenshots should never inherit private tailnet details from the
// machine that happens to generate them.
await page.setRequestInterception(true);
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (path === "/api/tailscale/status") {
    void request.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ installed: false, running: false, hostname: null, tailnetIp: null }),
    });
    return;
  }
  void request.continue();
});

const allLogs: { route: string; level: string; text: string }[] = [];
page.on("console", (msg) => {
  allLogs.push({ route: page.url(), level: msg.type(), text: msg.text() });
});
page.on("pageerror", (err) => {
  allLogs.push({ route: page.url(), level: "error", text: String(err) });
});

async function visit(route: string, name: string, waitForSel?: string) {
  console.log(`\n--- ${name} (${route}) ---`);
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 15000 });
  if (waitForSel) {
    try {
      await page.waitForSelector(waitForSel, { timeout: 4000 });
    } catch {
      console.log(`  ! selector "${waitForSel}" not found`);
    }
  }
  await Bun.sleep(400);
  const errs = allLogs.filter((l) => l.route.includes(route) && (l.level === "error" || l.level === "warning"));
  if (errs.length) {
    for (const e of errs) console.log(`  [${e.level}] ${e.text.slice(0, 200)}`);
  } else {
    console.log(`  console: clean`);
  }
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path: path as `${string}.png`, fullPage: false });
  console.log(`  screenshot: ${path}`);

  // Find the visible H1 + first chrome label as a sanity proof of which page rendered
  const proof = await page.evaluate(() => {
    const h1 = document.querySelector("h1")?.textContent?.trim() ?? null;
    const eyebrow =
      document.querySelector(".mono-caps")?.textContent?.trim() ??
      document.querySelector('[class*="tracking-"]')?.textContent?.trim() ??
      null;
    return { h1, eyebrow };
  });
  console.log(`  proof: h1="${proof.h1}" eyebrow="${proof.eyebrow}"`);
  allLogs.length = 0;
}

// 1) Login
await visit("/login", "01-login", 'input[placeholder="you@example.com"]');
if (EMAIL) {
  await page.type('input[placeholder="you@example.com"]', EMAIL);
  await page.type('input[type="password"]', PASSWORD);
}
await page.click('button[type="submit"]');
await page.waitForFunction(() => window.location.pathname === "/", { timeout: 10000 });
await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});

// 2-6) Each authenticated route
await visit("/", "02-dashboard", "h1");
await visit("/databases", "03-databases", "h1");
await visit("/auth", "04-auth", "h1");
await visit("/data-api", "05-data-api", "h1");
await visit("/storage", "06-storage", "h1");
await visit("/realtime", "07-realtime", "h1");
await visit("/functions", "08-functions", "h1");
await visit("/users", "09-users", "h1");
await visit("/activity", "09b-activity", "h1");
await visit("/tailscale", "10-tailscale", "h1");
await visit("/settings", "11-settings", "h1");

// 7) Click into the first database
await page.goto(`${BASE}/databases`, { waitUntil: "networkidle0" });
const links = await page.$$eval("a[href^='/databases/']", (els) =>
  els.map((a) => (a as HTMLAnchorElement).pathname).filter((p) => p !== "/databases"),
);
console.log(`\nFound DB links: ${links.length}`);
if (links[0]) {
  await visit(links[0], "12-database-detail", "h1");
}

// 8) Snap each tab on detail page
if (links[0]) {
  for (const tab of ["Overview", "Query", "Snapshots", "Sync", "Metrics", "Danger"]) {
    await page.goto(`${BASE}${links[0]}`, { waitUntil: "networkidle0" });
    const clicked = await page.evaluate((label) => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
      );
      if (btn) (btn as HTMLButtonElement).click();
      return !!btn;
    }, tab);
    if (clicked) {
      await Bun.sleep(400);
      const path = `${OUT_DIR}/13-detail-tab-${tab.toLowerCase()}.png`;
      await page.screenshot({ path: path as `${string}.png`, fullPage: false });
      console.log(`  ${tab}: snapped → ${path}`);
    } else {
      console.log(`  ${tab}: tab not found`);
    }
  }
}

await browser.close();
console.log(`\nALL DONE. Screenshots in ${OUT_DIR}`);
