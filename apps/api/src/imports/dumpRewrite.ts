export class DumpRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpRejectedError";
  }
}

export interface RewriteSummary {
  ownDatabase: string | null;
  databaseStatements: number;
  definers: number;
  replicationStatements: number;
  privilegeStatements: number;
}

const CODE = 0;
const SQ = 1;
const DQ = 2;
const BT = 3;
const LINE = 4;
const BLOCK = 5;

const LOOKAHEAD = 64 * 1024;
const BATCH_BYTES = 1024 * 1024;
const SANDBOX_LINE = "/*M!999999\\- enable the sandbox mode */";
const DEFINER_RE =
  /^DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"\\]|\\[\s\S]|"")*"|[^\s@=*/;,()'"`]+)\s*@\s*(?:`(?:[^`]|``)*`|'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"\\]|\\[\s\S]|"")*"|[^\s@=*/;,()'"`]+)/i;
const DEFINER_CURRENT_RE = /^DEFINER\s*=\s*CURRENT_USER\b/i;
const encoder = new TextEncoder();
const REPLACEMENT = encoder.encode("DEFINER=CURRENT_USER");

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
}

function isIdentByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x24 || b >= 0x80;
}

function isLetter(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

function latin1(buf: Uint8Array, start: number, end: number): string {
  const s = Math.max(0, Math.min(start, buf.length));
  const e = Math.max(s, Math.min(end, buf.length));
  return Buffer.from(buf.buffer, buf.byteOffset + s, e - s).toString("latin1");
}

interface StatementToken {
  kind: "word" | "name";
  text: string;
}

function statementTokens(text: string): StatementToken[] {
  const out: StatementToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const m = /^\/\*M?!\d*/.exec(text.slice(i, i + 16));
      if (m) {
        i += m[0].length;
        continue;
      }
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "*" && text[i + 1] === "/") {
      i += 2;
      continue;
    }
    if (c === "-" && text[i + 1] === "-" && (i + 2 >= n || /\s/.test(text[i + 2]!))) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "`" || c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < n) {
        const d = text[j]!;
        if (d === "\\" && c !== "`") {
          value += text[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === c) {
          if (text[j + 1] === c) {
            value += c;
            j += 2;
            continue;
          }
          break;
        }
        value += d;
        j++;
      }
      out.push({ kind: "name", text: value });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !/[\s`'"/#;*()]/.test(text[j]!)) j++;
    if (j === i) {
      out.push({ kind: "word", text: c });
      i++;
      continue;
    }
    out.push({ kind: "word", text: text.slice(i, j) });
    i = j;
  }
  return out;
}

type Special =
  | { kind: "database"; verb: "USE" | "CREATE" | "DROP"; name: string }
  | { kind: "replication" }
  | null;

function classifyStatement(text: string): Special {
  const tokens = statementTokens(text);
  const w = (k: number) => (tokens[k]?.kind === "word" ? tokens[k]!.text.toUpperCase() : "");
  const nameAt = (k: number): string | null => {
    const t = tokens[k];
    if (!t) return null;
    if (t.kind === "name") return t.text;
    return /^[A-Za-z0-9_$\u0080-￿]+$/.test(t.text) ? t.text : null;
  };
  const first = w(0);
  if (first === "USE") {
    const name = nameAt(1);
    return name !== null && tokens.length === 2 ? { kind: "database", verb: "USE", name } : null;
  }
  if ((first === "CREATE" || first === "DROP") && (w(1) === "DATABASE" || w(1) === "SCHEMA")) {
    let k = 2;
    if (w(k) === "IF") {
      k++;
      if (w(k) === "NOT") k++;
      if (w(k) === "EXISTS") k++;
    }
    const name = nameAt(k);
    if (name === null) return null;
    return { kind: "database", verb: first, name };
  }
  if (first === "SET") {
    const compact = text.replace(/\/\*M?!\d*|\*\//g, " ").replace(/\s+/g, "").toUpperCase();
    if (/^SET(@@(GLOBAL|SESSION)\.)?(GTID_PURGED|SQL_LOG_BIN)(:=|=)/.test(compact)) return { kind: "replication" };
  }
  return null;
}

export class DumpRewriter {
  private state = CODE;
  private exec = false;
  private atStart = true;
  private delimiter: Uint8Array = encoder.encode(";");
  private carry: Uint8Array = new Uint8Array(0);
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private prevByte = 0x0a;
  private first = true;
  private finished = false;
  readonly summary: RewriteSummary = {
    ownDatabase: null,
    databaseStatements: 0,
    definers: 0,
    replicationStatements: 0,
    privilegeStatements: 0,
  };
  readonly rejections: string[] = [];

  constructor(private readonly opts: { collectRejections?: boolean } = {}) {}

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.finished) throw new Error("rewriter already finished");
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes < BATCH_BYTES) return [];
    return this.process(false);
  }

  finish(): Uint8Array[] {
    if (this.finished) return [];
    const out = this.process(true);
    this.finished = true;
    return out;
  }

  private reject(message: string): void {
    if (this.opts.collectRejections) {
      if (!this.rejections.includes(message)) this.rejections.push(message);
      return;
    }
    throw new DumpRejectedError(message);
  }

  private takeBuffer(): Uint8Array {
    const total = this.carry.byteLength + this.pendingBytes;
    const buf = new Uint8Array(total);
    buf.set(this.carry, 0);
    let offset = this.carry.byteLength;
    for (const p of this.pending) {
      buf.set(p, offset);
      offset += p.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;
    return buf;
  }

  private matchDelimiter(buf: Uint8Array, i: number): boolean {
    const d = this.delimiter;
    if (i + d.length > buf.length) return false;
    for (let k = 0; k < d.length; k++) if (buf[i + k] !== d[k]) return false;
    return true;
  }

  private statementEnd(buf: Uint8Array, start: number, limit: number): number {
    let state = CODE;
    for (let i = start; i < limit; i++) {
      const b = buf[i]!;
      if (state === CODE) {
        if (b === 0x27) state = SQ;
        else if (b === 0x22) state = DQ;
        else if (b === 0x60) state = BT;
        else if (this.matchDelimiter(buf, i)) return i;
      } else if (state === SQ || state === DQ) {
        if (b === 0x5c) i++;
        else if ((state === SQ && b === 0x27) || (state === DQ && b === 0x22)) state = CODE;
      } else if (state === BT && b === 0x60) state = CODE;
    }
    return -1;
  }

  private process(final: boolean): Uint8Array[] {
    const buf = this.takeBuffer();
    const n = buf.length;
    const limit = final ? n : Math.max(0, n - LOOKAHEAD);
    const out: Uint8Array[] = [];
    let emitFrom = 0;
    let i = 0;
    if (this.first) {
      if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        i = 3;
        emitFrom = 3;
      }
      if (n > 0) this.first = false;
    }
    const emit = (to: number) => {
      if (to > emitFrom) out.push(buf.subarray(emitFrom, to));
    };
    while (i < limit) {
      const b = buf[i]!;
      switch (this.state) {
        case SQ:
        case DQ: {
          const q = this.state === SQ ? 0x27 : 0x22;
          while (i < limit) {
            const c = buf[i]!;
            if (c === 0x5c) {
              i += 2;
              continue;
            }
            if (c === q) {
              if (buf[i + 1] === q) {
                i += 2;
                continue;
              }
              this.state = CODE;
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        case BT: {
          while (i < limit) {
            if (buf[i] === 0x60) {
              if (buf[i + 1] === 0x60) {
                i += 2;
                continue;
              }
              this.state = CODE;
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        case LINE: {
          while (i < limit && buf[i] !== 0x0a) i++;
          if (i < limit) {
            this.state = CODE;
            i++;
          }
          continue;
        }
        case BLOCK: {
          while (i < limit) {
            if (buf[i] === 0x2a && buf[i + 1] === 0x2f) {
              this.state = CODE;
              i += 2;
              break;
            }
            i++;
          }
          continue;
        }
      }
      if (this.atStart) {
        if (isSpace(b)) {
          i++;
          continue;
        }
        if (b === 0x23 || (b === 0x2d && buf[i + 1] === 0x2d && (i + 2 >= n || isSpace(buf[i + 2]!) || buf[i + 2]! < 0x20))) {
          this.state = LINE;
          i++;
          continue;
        }
        if (b === 0x2f && buf[i + 1] === 0x2a) {
          if (latin1(buf, i, i + SANDBOX_LINE.length) === SANDBOX_LINE) {
            i += SANDBOX_LINE.length;
            continue;
          }
          const isExec = buf[i + 2] === 0x21 || (buf[i + 2] === 0x4d && buf[i + 3] === 0x21);
          if (!isExec) {
            this.state = BLOCK;
            i += 2;
            continue;
          }
          if (this.handleSpecial(buf, i, n, final, out, emit, (to) => (emitFrom = to), (to) => (i = to))) continue;
          this.atStart = false;
          continue;
        }
        if (isLetter(b)) {
          let j = i;
          while (j < n && j - i < 16 && isLetter(buf[j]!)) j++;
          const word = latin1(buf, i, j).toUpperCase();
          if (word === "DELIMITER" && j < n && (buf[j] === 0x20 || buf[j] === 0x09)) {
            let k = j;
            while (k < n && (buf[k] === 0x20 || buf[k] === 0x09)) k++;
            let e = k;
            while (e < n && !isSpace(buf[e]!)) e++;
            if (e > k) this.delimiter = buf.slice(k, e);
            let nl = e;
            while (nl < n && buf[nl] !== 0x0a) nl++;
            i = Math.min(n, nl + 1);
            this.atStart = true;
            continue;
          }
          if (word === "USE" || word === "CREATE" || word === "DROP" || word === "SET") {
            if (this.handleSpecial(buf, i, n, final, out, emit, (to) => (emitFrom = to), (to) => (i = to))) continue;
          }
          if (word === "GRANT" || word === "REVOKE" || (word === "CREATE" && /^CREATE\s+(USER|ROLE)\b/i.test(latin1(buf, i, i + 32)))) {
            this.summary.privilegeStatements++;
          }
        }
        this.atStart = false;
        continue;
      }
      if (b === 0x27) {
        this.state = SQ;
        i++;
        continue;
      }
      if (b === 0x22) {
        this.state = DQ;
        i++;
        continue;
      }
      if (b === 0x60) {
        this.state = BT;
        i++;
        continue;
      }
      if (b === 0x23) {
        this.state = LINE;
        i++;
        continue;
      }
      if (b === 0x2d && buf[i + 1] === 0x2d && (i + 2 >= n || isSpace(buf[i + 2]!) || buf[i + 2]! < 0x20)) {
        this.state = LINE;
        i += 2;
        continue;
      }
      if (b === 0x2f && buf[i + 1] === 0x2a) {
        if (buf[i + 2] === 0x21 || (buf[i + 2] === 0x4d && buf[i + 3] === 0x21)) {
          this.exec = true;
          i += buf[i + 2] === 0x21 ? 3 : 4;
          continue;
        }
        this.state = BLOCK;
        i += 2;
        continue;
      }
      if (b === 0x2a && buf[i + 1] === 0x2f && this.exec) {
        this.exec = false;
        i += 2;
        continue;
      }
      if (this.matchDelimiter(buf, i)) {
        i += this.delimiter.length;
        this.atStart = true;
        this.exec = false;
        continue;
      }
      if ((b === 0x44 || b === 0x64) && !isIdentByte(i > 0 ? buf[i - 1]! : this.prevByte)) {
        const window = latin1(buf, i, Math.min(n, i + 600));
        if (!DEFINER_CURRENT_RE.test(window)) {
          const m = DEFINER_RE.exec(window);
          if (m) {
            emit(i);
            out.push(REPLACEMENT);
            i += Buffer.byteLength(m[0], "latin1");
            emitFrom = i;
            this.summary.definers++;
            continue;
          }
        }
      }
      i++;
    }
    if (i > n) i = n;
    emit(i);
    this.prevByte = i > 0 ? buf[i - 1]! : this.prevByte;
    this.carry = i < n ? buf.slice(i) : new Uint8Array(0);
    if (final && this.carry.byteLength > 0) {
      out.push(this.carry);
      this.carry = new Uint8Array(0);
    }
    return out;
  }

  private handleSpecial(
    buf: Uint8Array,
    i: number,
    n: number,
    final: boolean,
    out: Uint8Array[],
    emit: (to: number) => void,
    setEmitFrom: (to: number) => void,
    setIndex: (to: number) => void,
  ): boolean {
    const end = this.statementEnd(buf, i, Math.min(n, i + LOOKAHEAD));
    const stop = end < 0 ? Math.min(n, i + LOOKAHEAD) : end;
    if (end < 0 && !(final && stop === n)) return false;
    const text = latin1(buf, i, stop);
    const special = classifyStatement(text);
    if (!special) return false;
    const after = end < 0 ? stop : end + this.delimiter.length;
    if (special.kind === "database") {
      const own = this.summary.ownDatabase;
      if (own !== null && special.name !== own) {
        this.reject(
          `The dump switches to a second database (\`${special.name}\`, after \`${own}\`). LambData loads a dump into one database only; export a single database (without --all-databases or a list of databases) and try again.`,
        );
        return false;
      }
      this.summary.ownDatabase = special.name;
      this.summary.databaseStatements++;
    } else {
      this.summary.replicationStatements++;
    }
    emit(i);
    const lines = text.split("\n").length - 1;
    if (lines > 0) out.push(encoder.encode("\n".repeat(lines)));
    setEmitFrom(after);
    setIndex(after);
    this.atStart = true;
    return true;
  }
}

export function rewriteSummaryWarnings(summary: RewriteSummary, rejections: string[], mysql8Collation: boolean): string[] {
  const warnings: string[] = [];
  if (summary.ownDatabase !== null) {
    warnings.push(
      `The dump names its own database (\`${summary.ownDatabase}\`) with CREATE DATABASE/USE. Those statements are skipped and everything loads into the new database instead.`,
    );
  }
  if (summary.definers > 0) {
    warnings.push(
      `${summary.definers} view, trigger or routine definition(s) name a DEFINER account. They are rewritten so the objects belong to this database's own user.`,
    );
  }
  if (summary.replicationStatements > 0) {
    warnings.push(
      `${summary.replicationStatements} replication setting(s) (SQL_LOG_BIN or GTID_PURGED) are skipped; they need server-wide privileges and do not affect the data.`,
    );
  }
  if (summary.privilegeStatements > 0) {
    warnings.push(
      "The dump contains GRANT, REVOKE or CREATE USER statements. Loading will stop at the first one, because the dump runs with access to its own database only.",
    );
  }
  if (mysql8Collation) {
    warnings.push(
      "The dump uses MySQL 8 collations (utf8mb4_0900_*), which older MariaDB versions do not know; if loading fails on them, re-export with --default-character-set=utf8mb4 and a utf8mb4_unicode_ci collation.",
    );
  }
  warnings.push(...rejections);
  return warnings;
}
