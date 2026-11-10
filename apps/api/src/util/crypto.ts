import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { env } from "../env";

let cachedKey: CryptoKey | null = null;

export function freshBytes(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(n));
}

export function copyToFresh(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = freshBytes(src.byteLength);
  out.set(src);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = freshBytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = (4 - (s.length % 4)) % 4;
  return fromBase64((s + "=".repeat(pad)).replaceAll("-", "+").replaceAll("_", "/"));
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  let raw: Uint8Array<ArrayBuffer>;
  if (existsSync(env.masterKeyPath)) {
    raw = copyToFresh(readFileSync(env.masterKeyPath));
  } else {
    raw = freshBytes(32);
    crypto.getRandomValues(raw);
    writeFileSync(env.masterKeyPath, raw);
    chmodSync(env.masterKeyPath, 0o600);
  }
  cachedKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return cachedKey;
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await getKey();
  const iv = freshBytes(12);
  crypto.getRandomValues(iv);
  const ptBytes = copyToFresh(new TextEncoder().encode(plain));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ptBytes));
  const out = freshBytes(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toBase64(out);
}

export async function decryptSecret(enc: string): Promise<string> {
  const key = await getKey();
  const buf = fromBase64(enc);
  const iv = copyToFresh(buf.slice(0, 12));
  const ct = copyToFresh(buf.slice(12));
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  return new TextDecoder().decode(pt);
}
