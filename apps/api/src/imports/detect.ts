export type DetectedFormat = { format: "sqlite"; compressed: false } | { format: "sql"; compressed: boolean };

export class UnsupportedFileError extends Error {
  readonly status: 415 | 422;

  constructor(message: string, status: 415 | 422 = 415) {
    super(message);
    this.name = "UnsupportedFileError";
    this.status = status;
  }
}

export const SNIFF_BYTES = 256 * 1024;
const ONLY = "only SQLite databases and MySQL/MariaDB dump files (.sql or .sql.gz) can be imported";
const SQLITE_MAGIC = "SQLite format 3\u0000";
const SQL_START_KEYWORDS = new Set([
  "SET",
  "CREATE",
  "DROP",
  "INSERT",
  "REPLACE",
  "USE",
  "LOCK",
  "UNLOCK",
  "ALTER",
  "START",
  "BEGIN",
  "COMMIT",
  "DELIMITER",
  "TRUNCATE",
]);

function startsWith(head: Uint8Array, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (head[offset + i] !== bytes[i]) return false;
  return true;
}

function ascii(head: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < Math.min(end, head.length); i++) out += String.fromCharCode(head[i]!);
  return out;
}

export function isSqliteHeader(head: Uint8Array): boolean {
  return ascii(head, 0, 16) === SQLITE_MAGIC;
}

function describeBinary(head: Uint8Array): string | null {
  const jet = ascii(head, 4, 19);
  if (jet === "Standard Jet DB" || jet === "Standard ACE DB") {
    return "This looks like a Microsoft Access database";
  }
  if (ascii(head, 0, 5) === "PGDMP") return "This looks like a PostgreSQL custom-format dump (pg_dump -Fc)";
  if (ascii(head, 0, 31).startsWith("** This file contains an SQLite")) {
    return "This is an SQLite 2 database; convert it to SQLite 3 first";
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return "This is a ZIP archive; extract the .db or .sql file from it and upload that";
  }
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "This is a 7-Zip archive; extract the file and upload that";
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21])) return "This is a RAR archive; extract the file and upload that";
  if (startsWith(head, [0x42, 0x5a, 0x68])) return "This file is bzip2-compressed; only gzip compression (.sql.gz) is supported";
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) {
    return "This file is xz-compressed; only gzip compression (.sql.gz) is supported";
  }
  if (startsWith(head, [0x28, 0xb5, 0x2f, 0xfd])) return "This file is zstd-compressed; only gzip compression (.sql.gz) is supported";
  if (ascii(head, 257, 262) === "ustar") return "This is a tar archive; extract the file and upload that";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "This is a PDF document";
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "This looks like a Microsoft Office document (or an old Access/Works file)";
  }
  if (ascii(head, 0, 4) === "H:2,") return "This looks like an H2 database";
  if (startsWith(head, [0x01, 0x0f, 0x00, 0x00])) return "This looks like a Microsoft SQL Server data file";
  return null;
}

function stripLeadingNoise(text: string): string {
  let s = text.replace(/^﻿/, "");
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl < 0 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("#")) {
      const nl = s.indexOf("\n");
      s = nl < 0 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*") && !s.startsWith("/*!") && !s.startsWith("/*M!")) {
      const end = s.indexOf("*/", 2);
      s = end < 0 ? "" : s.slice(end + 2);
    }
    if (s === before) return s;
  }
}

function classifyText(head: Uint8Array): { ok: true } | { ok: false; message: string; binary?: boolean } {
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) {
    return {
      ok: false,
      message:
        "This SQL file is UTF-16 encoded (Windows PowerShell writes dumps that way). Save it as UTF-8, or export with mysqldump --result-file, and upload it again",
    };
  }
  const probe = head.subarray(0, Math.min(head.length, 8192));
  if (probe.includes(0)) return { ok: false, binary: true, message: `This is not a text file; ${ONLY}` };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(0, Math.min(head.length, 65536)));
  if (/PostgreSQL database dump/i.test(text.slice(0, 4096)) || /\bpg_catalog\.set_config\b/.test(text)) {
    return { ok: false, message: `This looks like a PostgreSQL dump; ${ONLY}` };
  }
  const body = stripLeadingNoise(text);
  if (body === "") {
    return { ok: false, message: `No SQL statements were found at the start of this file; ${ONLY}` };
  }
  if (body.startsWith("/*!") || body.startsWith("/*M!")) return { ok: true };
  const first = /^([A-Za-z_]+)/.exec(body)?.[1]?.toUpperCase() ?? "";
  if (first === "PRAGMA") {
    return {
      ok: false,
      message:
        "This looks like a SQLite text dump (the output of sqlite3 .dump). Upload the SQLite database file itself instead; LambData reads it directly",
    };
  }
  if (/^USE\s+\[/i.test(body) || /^\s*GO\s*$/im.test(text.slice(0, 16384)) || /^SET\s+ANSI_NULLS\b/i.test(body)) {
    return { ok: false, message: `This looks like a Microsoft SQL Server script; ${ONLY}` };
  }
  if (body.startsWith("{") || body.startsWith("[")) return { ok: false, message: `This looks like JSON; ${ONLY}` };
  if (SQL_START_KEYWORDS.has(first)) return { ok: true };
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  if (/^[^,;]*(,[^,;]*){2,}$/.test(firstLine)) return { ok: false, message: `This looks like CSV text; ${ONLY}` };
  return { ok: false, message: `This text file does not start like a SQL dump; ${ONLY}` };
}

export async function readHead(path: string, maxBytes: number, compressed: boolean): Promise<Uint8Array> {
  let stream: ReadableStream<Uint8Array> = Bun.file(path).stream();
  if (compressed) stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, Math.min(value.byteLength, maxBytes - total));
      parts.push(take);
      total += take.byteLength;
    }
  } catch (err) {
    if (!compressed) throw err;
    if (total === 0) {
      throw new UnsupportedFileError(
        `This file starts like gzip but could not be decompressed: ${err instanceof Error ? err.message : String(err)}`,
        422,
      );
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function detectFormat(head: Uint8Array, path: string): Promise<DetectedFormat> {
  if (head.length === 0) throw new UnsupportedFileError("The uploaded file is empty", 422);
  if (isSqliteHeader(head)) return { format: "sqlite", compressed: false };
  if (startsWith(head, [0x1f, 0x8b])) {
    const inner = await readHead(path, SNIFF_BYTES, true);
    if (isSqliteHeader(inner)) {
      throw new UnsupportedFileError(
        "This is a gzip-compressed SQLite database. Decompress it and upload the .db file itself",
      );
    }
    if (startsWith(inner, [0x1f, 0x8b])) throw new UnsupportedFileError(`This file is compressed twice; ${ONLY}`);
    const binary = describeBinary(inner);
    if (binary) throw new UnsupportedFileError(`The gzip file contains something else: ${binary}; ${ONLY}`);
    const verdict = classifyText(inner);
    if (!verdict.ok) throw new UnsupportedFileError(`Inside the gzip file: ${verdict.message}`);
    return { format: "sql", compressed: true };
  }
  const binary = describeBinary(head);
  if (binary) throw new UnsupportedFileError(`${binary}; ${ONLY}`);
  const verdict = classifyText(head);
  if (!verdict.ok) {
    if (verdict.binary) {
      throw new UnsupportedFileError(
        `Unrecognised binary file: it is not a SQLite 3 database (an encrypted SQLite file such as SQLCipher also looks like this); ${ONLY}`,
      );
    }
    throw new UnsupportedFileError(verdict.message);
  }
  return { format: "sql", compressed: false };
}
