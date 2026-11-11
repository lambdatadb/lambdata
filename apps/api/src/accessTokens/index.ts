import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AccessTokenVia, Database, IngressKind } from "@lambdata/shared";
import { ACCESS_TOKEN_PREFIX } from "@lambdata/shared";
import { accessTokens, databases, type StoredAccessToken } from "../db/queries";
import type { IngressInfo } from "../network/classify";

export interface AccessTokenRequest {
  token: StoredAccessToken;
  via: AccessTokenVia;
  ingress: IngressKind;
  checks: IngressKind[];
  clientIp: string;
  info: IngressInfo;
}

declare module "hono" {
  interface ContextVariableMap {
    accessToken: AccessTokenRequest | undefined;
    accessTokenDetail: string | undefined;
  }
}

const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_LENGTH = 43;
export const PREFIX_LENGTH = 9;
export const ACTOR_EMAIL_DOMAIN = "access-tokens.invalid";

export function generateSecret(): string {
  const out: string[] = [];
  const limit = 256 - (256 % SECRET_ALPHABET.length);
  while (out.length < SECRET_LENGTH) {
    const bytes = new Uint8Array(SECRET_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue;
      out.push(SECRET_ALPHABET[b % SECRET_ALPHABET.length]!);
      if (out.length === SECRET_LENGTH) break;
    }
  }
  return `${ACCESS_TOKEN_PREFIX}${out.join("")}`;
}

export function hashSecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

const SECRET_PATTERN = /(?<![A-Za-z0-9_])ld_[A-Za-z0-9]{40,}(?![A-Za-z0-9_])/g;

export function scrubSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "ld_[hidden]");
}

export function cleanActivityText(raw: string | undefined | null, max: number): string | null {
  if (!raw) return null;
  const text = scrubSecrets(raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim());
  if (!text) return null;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

export function accessTokenForUser(userId: string | null | undefined): { id: string; name: string } | null {
  if (!userId) return null;
  return accessTokens.nameForActor(userId);
}

export function currentAccessToken(c: Context): AccessTokenRequest | null {
  return c.get("accessToken") ?? null;
}

type DatabaseRef = Pick<Database, "id" | "ownerUserId"> & { createdByTokenId?: string | null };

export function tokenCanSeeDatabase(token: StoredAccessToken, row: DatabaseRef): boolean {
  if (token.databaseIds !== null && !token.databaseIds.includes(row.id)) return false;
  if (token.preset === "builder") return row.ownerUserId === token.actorUserId || row.createdByTokenId === token.id;
  return true;
}

export function tokenSeesEverything(token: StoredAccessToken): boolean {
  return token.preset !== "builder" && token.databaseIds === null;
}

export function visibleToRequest<T extends DatabaseRef>(c: Context, list: T[]): T[] {
  const req = currentAccessToken(c);
  if (!req) return list;
  return list.filter((row) => tokenCanSeeDatabase(req.token, row));
}

export function mayRevealCredentials(c: Context): boolean {
  const req = currentAccessToken(c);
  if (!req) return true;
  return req.token.preset !== "read_only" && req.token.revealCredentials;
}

const reserved = new Map<string, number>();

export function reserveDatabaseSlot(c: Context): () => void {
  const req = currentAccessToken(c);
  if (!req) return () => {};
  const token = req.token;
  if (token.databaseIds !== null) {
    throw new HTTPException(403, {
      message: "This access token is limited to particular databases, so it cannot create new ones.",
    });
  }
  const max = token.maxDatabases;
  const inFlight = reserved.get(token.id) ?? 0;
  if (max !== null && databases.countCreatedByToken(token.id) + inFlight >= max) {
    throw new HTTPException(403, {
      message: `This access token has reached its limit of ${max} database${max === 1 ? "" : "s"}. Delete one it created, or ask an admin to raise the limit.`,
    });
  }
  reserved.set(token.id, inFlight + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (reserved.get(token.id) ?? 1) - 1;
    if (left > 0) reserved.set(token.id, left);
    else reserved.delete(token.id);
  };
}

export interface McpOrigin {
  tokenId: string;
  ingress: IngressKind;
  checks: IngressKind[];
  clientIp: string;
  info: IngressInfo;
}

const mcpRequests = new WeakMap<Request, McpOrigin>();

export function markMcpRequest(request: Request, outer: Context): void {
  const req = currentAccessToken(outer);
  if (!req) throw new Error("only a request that came in with an access token can make MCP requests");
  mcpRequests.set(request, {
    tokenId: req.token.id,
    ingress: req.ingress,
    checks: [...req.checks],
    clientIp: req.clientIp,
    info: req.info,
  });
}

export function mcpOriginOf(request: Request): McpOrigin | null {
  return mcpRequests.get(request) ?? null;
}
