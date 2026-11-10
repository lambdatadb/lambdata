import { sha256Hex } from "./store";

export const LOAD_SQL_MODE = "NO_AUTO_VALUE_ON_ZERO,ALLOW_INVALID_DATES";

export const LOAD_PREAMBLE = [
  "/*!40101 SET NAMES utf8mb4 */;",
  "/*!40103 SET TIME_ZONE='+00:00' */;",
  "/*!40014 SET UNIQUE_CHECKS=0 */;",
  "/*!40014 SET FOREIGN_KEY_CHECKS=0 */;",
  `/*!40101 SET SQL_MODE='${LOAD_SQL_MODE}' */;`,
  "/*M!100201 SET CHECK_CONSTRAINT_CHECKS=0 */;",
  "/*!40111 SET SQL_NOTES=0 */;",
  "/*M!100616 SET NOTE_VERBOSITY=0 */;",
  "",
].join("\n");

const DOWNLOAD_PREAMBLE = [
  "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
  "/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;",
  "/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;",
  "/*!40101 SET NAMES utf8mb4 */;",
  "/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;",
  "/*!40103 SET TIME_ZONE='+00:00' */;",
  "/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;",
  "/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;",
  `/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='${LOAD_SQL_MODE}' */;`,
  "/*M!100201 SET @OLD_CHECK_CONSTRAINT_CHECKS=@@CHECK_CONSTRAINT_CHECKS, CHECK_CONSTRAINT_CHECKS=0 */;",
  "/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;",
  "/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;",
  "",
].join("\n");

export const DOWNLOAD_POSTAMBLE = [
  "",
  "/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;",
  "/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;",
  "/*M!100201 SET CHECK_CONSTRAINT_CHECKS=@OLD_CHECK_CONSTRAINT_CHECKS */;",
  "/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;",
  "/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;",
  "/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;",
  "/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;",
  "/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;",
  "/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;",
  "/*M!100616 SET NOTE_VERBOSITY=@OLD_NOTE_VERBOSITY */;",
  "",
  "-- End of LambData checkpoint",
  "",
].join("\n");

const AUTO_INCREMENT = / AUTO_INCREMENT=\d+/g;
const CONTROL = /[\u0000-\u001f\u007f]+/g;

export function schemaHash(createTable: string): string {
  return sha256Hex(createTable.replace(AUTO_INCREMENT, ""));
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(CONTROL, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function downloadHeader(p: {
  schema: string;
  hash: string;
  createdAt: number;
  trigger: string;
  message: string;
}): string {
  return [
    `-- LambData checkpoint ${p.hash.slice(0, 7)} of database ${oneLine(p.schema, 64)}`,
    `-- Commit ${p.hash}`,
    `-- Created ${new Date(p.createdAt).toISOString()} (${oneLine(p.trigger, 32)})`,
    `-- Message: ${oneLine(p.message, 500)}`,
    "-- Load into an empty database with: gunzip -c <file>.sql.gz | mariadb <database>",
    "",
    DOWNLOAD_PREAMBLE,
  ].join("\n");
}

export function legacyMessage(createdAt: number): string {
  const iso = new Date(createdAt).toISOString();
  return `Snapshot from ${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

const MAX_PROBE = 4096;
const LINE_PROBE = 256;

export async function* filterLines(
  input: AsyncIterable<Uint8Array>,
  drop: (lineStart: string) => boolean,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const probe = (bytes: Uint8Array) => drop(decoder.decode(bytes.subarray(0, Math.min(bytes.length, LINE_PROBE))));
  let carry: Uint8Array | null = null;
  let mode: "line" | "pass" | "skip" = "line";
  for await (const buf of input) {
    const out: Uint8Array[] = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(10, pos);
      if (mode !== "line") {
        const end = nl === -1 ? buf.length : nl + 1;
        if (mode === "pass") out.push(buf.subarray(pos, end));
        pos = end;
        if (nl !== -1) mode = "line";
        continue;
      }
      if (nl === -1) {
        const part = buf.subarray(pos);
        carry = carry ? Buffer.concat([carry, part]) : part.slice();
        if (carry.length > MAX_PROBE) {
          const keep = !probe(carry);
          if (keep) out.push(carry);
          carry = null;
          mode = keep ? "pass" : "skip";
        }
        pos = buf.length;
        continue;
      }
      const line: Uint8Array = carry ? Buffer.concat([carry, buf.subarray(pos, nl + 1)]) : buf.subarray(pos, nl + 1);
      carry = null;
      if (!probe(line)) out.push(line);
      pos = nl + 1;
    }
    if (out.length === 1) yield out[0]!.slice();
    else if (out.length > 1) yield Buffer.concat(out);
  }
  if (carry && !probe(carry)) yield carry;
}
