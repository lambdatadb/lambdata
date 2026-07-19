import { existsSync } from "node:fs";
import { env } from "../env";

const SERVER_CANDIDATES = ["mariadbd", "mysqld"];
const ADMIN_CANDIDATES = ["mariadb-admin", "mysqladmin"];
const CLIENT_CANDIDATES = ["mariadb", "mysql"];
const DUMP_CANDIDATES = ["mariadb-dump", "mysqldump"];
const INSTALL_DB_CANDIDATES = ["mariadb-install-db", "mysql_install_db"];

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

async function which(cmd: string): Promise<string | null> {
  const fromPath = Bun.which(cmd);
  if (fromPath) return fromPath;
  for (const dir of EXTRA_PATHS) {
    const candidate = `${dir}/${cmd}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function findFirst(list: string[]): Promise<string | null> {
  for (const c of list) {
    const found = await which(c);
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
}

export async function locateBinaries(): Promise<MariaDbBinaries> {
  const server = env.mariadbBin ?? (await findFirst(SERVER_CANDIDATES));
  if (!server) {
    throw new Error(
      "MariaDB server binary not found. Install MariaDB (e.g. `brew install mariadb` on macOS, `apt install mariadb-server` on Linux) or set KILNDB_MARIADB_BIN.",
    );
  }
  const admin = await findFirst(ADMIN_CANDIDATES);
  const client = await findFirst(CLIENT_CANDIDATES);
  const dump = await findFirst(DUMP_CANDIDATES);
  const installDb = await findFirst(INSTALL_DB_CANDIDATES);
  if (!admin || !client || !dump || !installDb) {
    throw new Error(
      "MariaDB tooling incomplete (need mysqladmin/mysql/mysqldump/mariadb-install-db). Install full MariaDB package.",
    );
  }
  return { server, admin, client, dump, installDb };
}
