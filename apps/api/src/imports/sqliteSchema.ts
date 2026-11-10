interface Token {
  kind: "word" | "ident" | "string" | "punct";
  text: string;
}

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "`" || c === "'") {
      let j = i + 1;
      let text = "";
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            text += c;
            j += 2;
            continue;
          }
          break;
        }
        text += sql[j];
        j++;
      }
      out.push({ kind: c === "'" ? "string" : "ident", text });
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      out.push({ kind: "ident", text: sql.slice(i + 1, end < 0 ? n : end) });
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (/[A-Za-z0-9_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j++;
      out.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ kind: "punct", text: c });
    i++;
  }
  return out;
}

const TABLE_CONSTRAINT_STARTS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

export function columnCollations(createSql: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (!createSql) return result;
  let tokens: Token[];
  try {
    tokens = tokenize(createSql);
  } catch {
    return result;
  }
  const open = tokens.findIndex((t) => t.kind === "punct" && t.text === "(");
  if (open < 0) return result;
  let depth = 0;
  let segment: Token[] = [];
  const segments: Token[][] = [];
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && t.text === "(") depth++;
    if (t.kind === "punct" && t.text === ")") {
      if (depth === 0) {
        segments.push(segment);
        break;
      }
      depth--;
    }
    if (depth === 0 && t.kind === "punct" && t.text === ",") {
      segments.push(segment);
      segment = [];
      continue;
    }
    segment.push(t);
  }
  for (const seg of segments) {
    const first = seg[0];
    if (!first) continue;
    if (first.kind === "word" && TABLE_CONSTRAINT_STARTS.has(first.text.toUpperCase())) continue;
    if (first.kind !== "word" && first.kind !== "ident" && first.kind !== "string") continue;
    for (let i = 1; i < seg.length - 1; i++) {
      const t = seg[i]!;
      if (t.kind === "word" && t.text.toUpperCase() === "COLLATE") {
        const next = seg[i + 1]!;
        if (next.kind !== "punct") result.set(asciiLower(first.text), next.text.toUpperCase());
      }
    }
  }
  return result;
}

export function isWithoutRowid(createSql: string | null): boolean {
  if (!createSql) return false;
  return /\)\s*(?:STRICT\s*,\s*)?WITHOUT\s+ROWID\b/i.test(createSql);
}

export function sqliteColumnKey(name: string): string {
  return asciiLower(name);
}
