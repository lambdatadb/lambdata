import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRoot } from "../harness/isolate";
import { resetTailscaleCaches, tailscaleBinary } from "../../src/tailscale/cli";
import { cloudflaredBinary } from "../../src/network/cloudflared";

export function peerEnv(address: string | null, port = 40_000): { server: { requestIP(req: Request): unknown } } {
  return {
    server: {
      requestIP: () => (address ? { address, family: address.includes(":") ? "IPv6" : "IPv4", port } : null),
    },
  };
}

function b64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

export async function makeRsaKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid },
  };
}

export async function signRs256(
  key: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }));
  const p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

export async function signHs256(secret: Uint8Array, payload: Record<string, unknown>, kid: string): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "HS256", kid, typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const raw = new Uint8Array(new ArrayBuffer(secret.byteLength));
  raw.set(secret);
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

export function unsignedToken(payload: Record<string, unknown>, kid: string): string {
  return `${b64url(JSON.stringify({ alg: "none", kid, typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.`;
}

export interface JwksServer {
  url: string;
  hits(): number;
  setKeys(keys: JsonWebKey[]): void;
  stop(): void;
}

export function startJwksServer(keys: JsonWebKey[]): JwksServer {
  let current = keys;
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/cdn-cgi/access/certs") return new Response("not found", { status: 404 });
      count += 1;
      return Response.json({ keys: current, public_cert: { kid: "x", cert: "unused" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/cdn-cgi/access/certs`,
    hits: () => count,
    setKeys(next) {
      current = next;
    },
    stop() {
      server.stop(true);
    },
  };
}

export const TEAM = "lambtest.cloudflareaccess.com";
export const AUD = "a".repeat(64);

export function accessClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [AUD],
    email: "owner@example.test",
    sub: "user-1",
    iss: `https://${TEAM}`,
    iat: now,
    nbf: now - 5,
    exp: now + 3600,
    type: "app",
    ...overrides,
  };
}

export function installFake(fixture: string, name: string, vars: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(testRoot(), `bin-${name}-`));
  const target = join(dir, name);
  const source = join(import.meta.dir, "fixtures", fixture);
  const runner = fixture.endsWith(".ts") ? `"${process.execPath}"` : "/bin/sh";
  const exports = Object.entries(vars)
    .map(([k, v]) => `export ${k}="${v}"\n`)
    .join("");
  writeFileSync(target, `#!/bin/sh\n${exports}exec ${runner} "${source}" "$@"\n`);
  chmodSync(target, 0o755);
  return dir;
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error("condition not met in time");
}

export const FAKE_TAILSCALE_STATUS = {
  BackendState: "Running",
  TUN: false,
  Self: { HostName: "box", DNSName: "box.tail1234.ts.net.", TailscaleIPs: ["100.88.0.1", "fd7a:115c:a1e0::1"] },
};

export interface FakeBin {
  state: string;
  restore(): void;
}

function prependPath(bin: string, envName: string, state: string): () => void {
  const prevPath = process.env.PATH;
  const prevState = process.env[envName];
  process.env.PATH = `${bin}:${prevPath ?? ""}`;
  process.env[envName] = state;
  return () => {
    process.env.PATH = prevPath;
    if (prevState === undefined) delete process.env[envName];
    else process.env[envName] = prevState;
  };
}

const NO_TAILSCALE = join(testRoot(), "no-real-tailscale");
const NO_CLOUDFLARED = join(testRoot(), "no-real-cloudflared");
process.env.LAMBDATA_TAILSCALE_BIN = NO_TAILSCALE;
process.env.LAMBDATA_CLOUDFLARED_BIN = NO_CLOUDFLARED;

export function useFakeTailscale(status: unknown = FAKE_TAILSCALE_STATUS): FakeBin {
  const state = mkdtempSync(join(testRoot(), "ts-state-"));
  writeFileSync(join(state, "status.json"), JSON.stringify(status));
  const bin = installFake("fake-tailscale.sh", "tailscale", { FAKE_TAILSCALE_DIR: state });
  const restorePath = prependPath(bin, "FAKE_TAILSCALE_DIR", state);
  process.env.LAMBDATA_TAILSCALE_BIN = join(bin, "tailscale");
  if (tailscaleBinary() !== join(bin, "tailscale")) throw new Error("refusing to run: the fake tailscale is not the one that resolves");
  return {
    state,
    restore() {
      restorePath();
      process.env.LAMBDATA_TAILSCALE_BIN = NO_TAILSCALE;
      resetTailscaleCaches();
    },
  };
}

export function useFakeCloudflared(): FakeBin {
  const state = mkdtempSync(join(testRoot(), "cf-state-"));
  const bin = installFake("fake-cloudflared.ts", "cloudflared");
  const restorePath = prependPath(bin, "TUNNEL_FAKE_DIR", state);
  delete process.env.LAMBDATA_CLOUDFLARED_BIN;
  const restore = (): void => {
    restorePath();
    process.env.LAMBDATA_CLOUDFLARED_BIN = NO_CLOUDFLARED;
  };
  if (cloudflaredBinary() !== join(bin, "cloudflared")) {
    restore();
    throw new Error("refusing to run: the fake cloudflared is not the one that resolves");
  }
  return { state, restore };
}

export function fakeTunnelToken(secret = "s3cr3t-tunnel-secret-value-0123456789"): string {
  return btoa(JSON.stringify({ a: "0123456789abcdef0123456789abcdef", t: "11111111-2222-3333-4444-555555555555", s: btoa(secret) }));
}
