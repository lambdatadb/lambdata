// Open the Databases page, click "New database", screenshot the dialog (empty + filled).
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 2 });

// Keep generated public assets independent of the host's private tailnet.
await page.setRequestInterception(true);
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (path === "/api/tailscale/status") {
    void request.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ installed: false, running: false, hostname: null, tailnetIp: null, managedBy: null }),
    });
    return;
  }
  void request.continue();
});

await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
if (EMAIL) {
  await page.type('input[placeholder="you@example.com"]', EMAIL);
  await page.type('input[type="password"]', PASSWORD);
}
await page.click('button[type="submit"]');
await page.waitForFunction(() => window.location.pathname === "/", { timeout: 10000 });
await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});

await page.goto(`${BASE}/databases`, { waitUntil: "networkidle0" });

// Click "New database"
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.includes("New database"),
  );
  (btn as HTMLButtonElement)?.click();
});
await Bun.sleep(500);
await page.screenshot({ path: `${OUT_DIR}/09-dialog-empty.png` as `${string}.png` });
console.log("dialog (empty) snapped");

// Type a name to populate the manifest
await page.evaluate(() => {
  const input = document.querySelector('input[placeholder="Customer Portal"]') as HTMLInputElement;
  if (input) {
    input.focus();
  }
});
await page.type('input[placeholder="Customer Portal"]', "Test Customer Portal");
await Bun.sleep(400);
await page.screenshot({ path: `${OUT_DIR}/10-dialog-filled.png` as `${string}.png` });
console.log("dialog (filled) snapped");

// Switch to Mirror, toggle Tailnet
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Mirror",
  );
  (btn as HTMLButtonElement)?.click();
});
await Bun.sleep(300);
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.includes("Tailnet only"),
  );
  (btn as HTMLButtonElement)?.click();
});
await Bun.sleep(400);
await page.screenshot({ path: `${OUT_DIR}/11-dialog-mirror-tailnet.png` as `${string}.png` });
console.log("dialog (mirror + tailnet) snapped");

await browser.close();
