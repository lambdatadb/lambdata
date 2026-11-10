import { isInsideTestRoot, testRoot } from "./isolate";
import { harnessState, type MetadataLease } from "./state";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setDataDir } from "../../src/env";
import { closeDb, db, reopenDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { POINTER_PATH } from "../../src/util/pointer";
import { users } from "../../src/db/queries";
import { COOKIE_NAME, signJwt } from "../../src/auth/jwt";
import { newId } from "../../src/util/id";
import type { Role } from "@lambdata/shared";

export interface TempMetadata {
  dataDir: string;
  cleanup(): void;
}

function assertIsolated(): void {
  if (!isInsideTestRoot(POINTER_PATH)) {
    throw new Error(
      `refusing to run: the data-dir pointer ${POINTER_PATH} is outside the test sandbox ${testRoot()}; import a test harness before any src module`,
    );
  }
}

function quoteTable(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function resetMetadataInPlace(): void {
  const tables = db
    .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    .all() as { name: string }[];
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const { name } of tables) {
        if (name === "schema_migrations") continue;
        if (name === "settings") {
          db.query(`DELETE FROM settings WHERE key NOT LIKE 'mariadb\\_%' ESCAPE '\\'`).run();
          continue;
        }
        db.exec(`DELETE FROM ${quoteTable(name)}`);
      }
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function sharedWithInstance(): TempMetadata {
  const instance = harnessState.instance!;
  resetMetadataInPlace();
  let cleaned = false;
  return {
    dataDir: instance.dataDir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (harnessState.instance === instance) resetMetadataInPlace();
    },
  };
}

export function useTempMetadata(opts: { migrate?: boolean } = {}): TempMetadata {
  assertIsolated();
  if (harnessState.instance) {
    if (opts.migrate === false) {
      throw new Error("useTempMetadata({ migrate: false }) cannot run while a MariaDB test instance owns the metadata store");
    }
    return sharedWithInstance();
  }
  const dataDir = mkdtempSync(join(testRoot(), "md-"));
  closeDb();
  setDataDir(dataDir);
  reopenDb();
  if (opts.migrate !== false) migrate();
  const lease: MetadataLease = { dataDir, released: false };
  harnessState.metadata = lease;
  return {
    dataDir,
    cleanup() {
      if (lease.released) return;
      lease.released = true;
      if (harnessState.metadata === lease) harnessState.metadata = null;
      const instance = harnessState.instance;
      if (instance && instance.dataDir === dataDir) {
        resetMetadataInPlace();
        instance.removeDirOnStop = true;
        return;
      }
      closeDb();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface SeededUser {
  id: string;
  email: string;
  role: Role;
}

let userCounter = 0;

export function seedUser(role: Role, email?: string): SeededUser {
  const id = newId("u");
  const address = email ?? `${role}-${++userCounter}-${id.slice(-6)}@example.test`;
  users.insert({
    id,
    email: address,
    passwordHash: "unused",
    displayName: `${role} ${userCounter}`,
    role,
    experienceLevel: "advanced",
  });
  return { id, email: address, role };
}

export async function authHeaders(user: SeededUser, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await signJwt(user.id, user.role);
  return { Cookie: `${COOKIE_NAME}=${token}`, ...extra };
}
