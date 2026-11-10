import { timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 5;
const GROUP_LENGTH = 4;

let tokenDigest: Uint8Array | null = null;

function normalize(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function digest(value: string): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(value).digest());
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GROUPS * GROUP_LENGTH));
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]!);
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) groups.push(chars.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(""));
  return groups.join("-");
}

export function issueSetupToken(): string {
  const token = randomToken();
  tokenDigest = digest(normalize(token));
  return token;
}

export function setupTokenActive(): boolean {
  return tokenDigest !== null;
}

export function verifySetupToken(candidate: unknown): boolean {
  if (tokenDigest === null || typeof candidate !== "string") return false;
  const cleaned = normalize(candidate);
  if (cleaned.length === 0 || cleaned.length > 64) return false;
  return timingSafeEqual(digest(cleaned), tokenDigest);
}

export function expireSetupToken(): void {
  tokenDigest = null;
}

export function setupTokenBanner(token: string): string[] {
  const rule = "=".repeat(64);
  return [
    rule,
    `  LambData first-run setup token:  ${token}`,
    "",
    "  Open the LambData console in your browser and enter this token in the",
    "  setup wizard. It proves you run this server before the first admin",
    "  account is created. It works until setup is finished; restarting",
    "  LambData before then prints a new token and the old one stops working.",
    rule,
  ];
}

export function announceSetupToken(log: (line: string) => void = (line) => console.log(line)): string {
  const token = issueSetupToken();
  for (const line of setupTokenBanner(token)) log(line);
  return token;
}
