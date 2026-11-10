export const MAX_IDENTIFIER_CHARS = 64;
const HASH_CHARS = 8;

function codePoints(s: string): string[] {
  return [...s];
}

function shortHash(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, HASH_CHARS);
}

export function foldIdentifier(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "s").toLowerCase().replace(/ +$/, "");
}

export function isPortableIdentifier(s: string): boolean {
  return /^[A-Za-z0-9_]{1,64}$/.test(s);
}

function sanitize(source: string, fallback: string): { name: string; reasons: string[] } {
  const reasons: string[] = [];
  let chars = codePoints(source);
  if (chars.some((c) => /[\u0000-\u001f\u007f]/.test(c))) {
    reasons.push("contains control characters");
    chars = chars.map((c) => (/[\u0000-\u001f\u007f]/.test(c) ? "_" : c));
  }
  if (chars.some((c) => c.codePointAt(0)! > 0xffff || /[\ud800-\udfff]/.test(c))) {
    reasons.push("contains characters outside the Basic Multilingual Plane, which MariaDB names cannot hold");
    chars = chars.map((c) => (c.codePointAt(0)! > 0xffff || /[\ud800-\udfff]/.test(c) ? "_" : c));
  }
  let name = chars.join("");
  if (/ +$/.test(name)) {
    reasons.push("ends with a space, which MariaDB does not allow");
    name = name.replace(/ +$/, "");
  }
  if (name === "") {
    if (source !== "") reasons.push("is blank");
    else reasons.push("is empty");
    name = fallback;
  }
  if (codePoints(name).length > MAX_IDENTIFIER_CHARS) {
    reasons.push(`is longer than ${MAX_IDENTIFIER_CHARS} characters`);
    name = `${codePoints(name)
      .slice(0, MAX_IDENTIFIER_CHARS - HASH_CHARS - 1)
      .join("")}_${shortHash(source)}`;
  }
  return { name, reasons };
}

function withSuffix(base: string, n: number): string {
  const suffix = `_${n}`;
  const room = MAX_IDENTIFIER_CHARS - suffix.length;
  return `${codePoints(base).slice(0, room).join("").replace(/ +$/, "")}${suffix}`;
}

export interface AllocatedName {
  targetName: string;
  renamed: boolean;
  reason: string | null;
}

export class NameAllocator {
  private readonly taken = new Set<string>();

  reserve(name: string): void {
    this.taken.add(foldIdentifier(name));
  }

  allocate(source: string, fallback: string): AllocatedName {
    const { name, reasons } = sanitize(source, fallback);
    let candidate = name;
    let n = 2;
    let collided = false;
    while (this.taken.has(foldIdentifier(candidate))) {
      collided = true;
      candidate = withSuffix(name, n++);
    }
    if (collided) reasons.push("collides with another name when compared the way MariaDB does (ignoring case and accents)");
    this.taken.add(foldIdentifier(candidate));
    const renamed = candidate !== source;
    return {
      targetName: candidate,
      renamed,
      reason: renamed ? reasons.join("; ") || "was adjusted" : null,
    };
  }
}

export function quoteMariaIdent(name: string): string {
  if (!name || codePoints(name).length > MAX_IDENTIFIER_CHARS || name.includes("\u0000")) {
    throw new Error(`invalid MariaDB identifier: ${name.slice(0, 80)}`);
  }
  return "`" + name.replaceAll("`", "``") + "`";
}
