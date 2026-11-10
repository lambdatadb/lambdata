import type { Job } from "@lambdata/shared";

export class HttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} answered ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export class ApiClient {
  private cookies = new Map<string, string>();

  constructor(
    readonly base: string,
    private readonly defaults: Record<string, string> = {},
  ) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private remember(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq > 0) this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  }

  async raw(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = new Headers({ ...this.defaults, ...init.headers });
    const cookie = this.cookieHeader();
    if (cookie) headers.set("Cookie", cookie);
    const res = await fetch(`${this.base}${path}`, { method, body: init.body, headers });
    this.remember(res);
    return res;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.raw(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw new HttpError(method, path, res.status, parsed);
    return parsed as T;
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, body ?? {}, headers);
  }

  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body ?? {});
  }

  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body ?? {});
  }

  async login(email: string, password: string): Promise<void> {
    await this.post("/api/auth/login", { email, password });
  }

  async waitForJob(job: Job, timeoutMs = 120_000): Promise<Job> {
    const started = Date.now();
    let current = job;
    while (current.status === "queued" || current.status === "running") {
      if (Date.now() - started > timeoutMs) throw new Error(`job ${job.id} (${job.kind}) did not finish in time`);
      await Bun.sleep(250);
      current = (await this.get<{ job: Job }>(`/api/jobs/${job.id}`)).job;
    }
    if (current.status === "failed") throw new Error(`job ${job.id} (${job.kind}) failed: ${current.error}`);
    return current;
  }
}
