import { existsSync } from "node:fs";
import { env } from "../env";

const SERVER_CANDIDATES = ["mariadbd", "mysqld"];
const ADMIN_CANDIDATES = ["mariadb-admin", "mysqladmin"];
const CLIENT_CANDIDATES = ["mariadb", "mysql"];
const DUMP_CANDIDATES = ["mariadb-dump", "mysqldump"];
const INSTALL_DB_CANDIDATES = ["mariadb-install-db", "mysql_install_db"];
const UPGRADE_CANDIDATES = ["mariadb-upgrade", "mysql_upgrade"];

const EXTRA_PATHS = [
  "/opt/homebrew/opt/mariadb/bin",
  "/opt/homebrew/bin",
  "/usr/local/opt/mariadb/bin",
  "/usr/local/bin",
  "/usr/local/mysql/bin",
  "/usr/sbin",
  "/usr/bin",
  "/usr/libexec",
];

function which(cmd: string): string | null {
  const fromPath = Bun.which(cmd);
  if (fromPath) return fromPath;
  for (const dir of EXTRA_PATHS) {
    const candidate = `${dir}/${cmd}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findFirst(list: string[]): string | null {
  for (const c of list) {
    const found = which(c);
    if (found) return found;
  }
  return null;
}

export interface MariaDbBinaries {
  server: string;
  admin: string;
  client: string;
  dump: string;
  installDb: string;
  upgrade: string | null;
}

export function locateBinariesSync(): MariaDbBinaries {
  const server = env.mariadbBin ?? findFirst(SERVER_CANDIDATES);
  if (!server) {
    throw new Error(
      "MariaDB server binary not found. Install MariaDB (e.g. `brew install mariadb` on macOS, `apt install mariadb-server` on Linux) or set LAMBDATA_MARIADB_BIN.",
    );
  }
  const admin = findFirst(ADMIN_CANDIDATES);
  const client = findFirst(CLIENT_CANDIDATES);
  const dump = findFirst(DUMP_CANDIDATES);
  const installDb = findFirst(INSTALL_DB_CANDIDATES);
  if (!admin || !client || !dump || !installDb) {
    throw new Error(
      "MariaDB tooling incomplete (need mysqladmin/mysql/mysqldump/mariadb-install-db). Install full MariaDB package.",
    );
  }
  return { server, admin, client, dump, installDb, upgrade: findFirst(UPGRADE_CANDIDATES) };
}

export async function locateBinaries(): Promise<MariaDbBinaries> {
  return locateBinariesSync();
}
