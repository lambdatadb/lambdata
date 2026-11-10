export const TWO_POW_53 = 9007199254740992n;

export function sqlString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\u0000/g, "\\0").replace(/\u001a/g, "\\Z")}'`;
}

export function hexLiteral(bytes: Uint8Array): string {
  return `X'${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}'`;
}

export function doubleLiteral(x: number): string {
  if (!Number.isFinite(x)) throw new Error("non-finite REAL cannot be stored as DOUBLE");
  if (Object.is(x, -0)) return "-0e0";
  return x.toExponential();
}

export function plainDecimal(x: number): string {
  const negative = x < 0 || Object.is(x, -0);
  const s = Math.abs(x).toString();
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) throw new Error(`cannot render ${s} as a decimal`);
  const intPart = m[1]!;
  const fracPart = m[2] ?? "";
  const exp = Number(m[3] ?? 0);
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/, "");
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return negative && out !== "0" ? `-${out}` : out;
}

export function decimalShape(x: number): { intDigits: number; fracDigits: number } {
  const plain = plainDecimal(x).replace(/^-/, "");
  const [i, f = ""] = plain.split(".");
  return { intDigits: i === "0" ? 0 : i!.length, fracDigits: f.length };
}

export function integerDigits(v: bigint): number {
  const s = (v < 0n ? -v : v).toString();
  return s === "0" ? 0 : s.length;
}

export function realAsText(x: number): string {
  if (x === Infinity) return "Inf";
  if (x === -Infinity) return "-Inf";
  if (Object.is(x, -0)) return "-0.0";
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return x.toFixed(1);
  return String(x);
}

export function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}
