import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse, type Page } from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome");

export interface Problem {
  shot: string;
  kind: "console" | "http" | "overflow" | "missing";
  detail: string;
}

const EXPECTED_HTTP: { method?: string; path: RegExp; status: number }[] = [
  { method: "GET", path: /^\/api\/auth\/me$/, status: 401 },
  { method: "GET", path: /^\/api\/imports\/limits$/, status: 404 },
  { method: "GET", path: /^\/api\/databases\/[^/]+\/set-aside$/, status: 403 },
];

export class Recorder {
  readonly problems: Problem[] = [];
  private current = "startup";

  at(name: string): void {
    this.current = name;
  }

  add(kind: Problem["kind"], detail: string): void {
    this.problems.push({ shot: this.current, kind, detail });
  }

  watch(page: Page): void {
    page.on("pageerror", (error) => this.add("console", String(error)));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/^Failed to load resource/.test(text)) return;
      this.add("console", text);
    });
    page.on("response", (response: HTTPResponse) => {
      const status = response.status();
      if (status < 400) return;
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/functions/")) return;
      const method = response.request().method();
      const expected = EXPECTED_HTTP.some((e) => e.status === status && e.path.test(url.pathname) && (!e.method || e.method === method));
      if (!expected) this.add("http", `${method} ${url.pathname} answered ${status}`);
    });
  }
}

const inflight = new WeakMap<Page, Map<HTTPRequest, number>>();

function track(page: Page): void {
  const pending = new Map<HTTPRequest, number>();
  inflight.set(page, pending);
  page.on("request", (request) => pending.set(request, Date.now()));
  page.on("requestfinished", (request) => pending.delete(request));
  page.on("requestfailed", (request) => pending.delete(request));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) pending.clear();
  });
}

export async function launch(): Promise<Browser> {
  return puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
}

export async function openPage(context: BrowserContext, recorder: Recorder, width: number): Promise<Page> {
  const page = await context.newPage();
  const mobile = width < 768;
  await page.setViewport({ width, height: mobile ? 844 : 900, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
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
    if (/^\/api\/(tailscale|network)\/.+/.test(path) && request.method() !== "GET") {
      void request.abort();
      return;
    }
    void request.continue();
  });
  recorder.watch(page);
  track(page);
  return page;
}

export async function settle(page: Page, ms = 500, timeoutMs = 10_000): Promise<void> {
  const pending = inflight.get(page);
  const started = Date.now();
  let quietSince = Date.now();
  while (pending && Date.now() - started < timeoutMs) {
    const now = Date.now();
    const active = [...pending.values()].filter((at) => now - at < 8_000).length;
    if (active > 0) quietSince = now;
    else if (now - quietSince >= 400) break;
    await Bun.sleep(50);
  }
  await Bun.sleep(ms);
}

export async function capture(page: Page, dir: string, name: string, recorder: Recorder, options: { full?: boolean } = {}): Promise<string> {
  mkdirSync(dir, { recursive: true });
  recorder.at(name);
  await Bun.sleep(350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) recorder.add("overflow", `${overflow}px wider than the viewport`);
  const viewport = page.viewport()!;
  const full = options.full !== false;
  if (full) {
    const height = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? main.scrollHeight + main.getBoundingClientRect().top : document.documentElement.scrollHeight;
    });
    if (height > viewport.height) {
      await page.setViewport({ ...viewport, height: Math.min(Math.ceil(height), 8000) });
      await Bun.sleep(300);
    }
  }
  const path = `${dir}/${name}.png`;
  await page.screenshot({ path: path as `${string}.png` });
  if (full) await page.setViewport(viewport);
  return path;
}

export async function clickText(page: Page, text: string, selector = "button, a, [role=menuitem], [role=tab], [role=option]"): Promise<void> {
  const clicked = await page.evaluate(
    (wanted, sel) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => el.getClientRects().length > 0);
      const label = (el: HTMLElement) => (el.innerText || el.textContent || "").trim();
      const target = elements.find((el) => label(el) === wanted) ?? elements.find((el) => label(el).startsWith(wanted));
      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      target.click();
      return true;
    },
    text,
    selector,
  );
  if (!clicked) throw new Error(`nothing to click labelled “${text}”`);
  await Bun.sleep(350);
}

export async function signIn(page: Page, base: string, email: string, password: string): Promise<void> {
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await settle(page, 200);
  const status = await page.evaluate(
    async (e, p) =>
      (
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: e, password: p }),
          credentials: "include",
        })
      ).status,
    email,
    password,
  );
  if (status !== 200) throw new Error(`sign-in as ${email} failed with HTTP ${status}`);
}
