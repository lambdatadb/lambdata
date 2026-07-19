import { statSync, openSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot, SnapshotTrigger } from "@kilndb/shared";
import { databases, snapshots } from "../db/queries";
import { env } from "../env";
import { newId } from "../util/id";
import {
  getMariaDbBinaries,
  getRootPassword,
  withRootConnection,
} from "../mariadb/controller";

function snapshotPath(databaseId: string, ts: number): string {
  return join(env.snapshotsDir, `${databaseId}_${ts}.sql`);
}

export async function createSnapshot(databaseId: string, trigger: SnapshotTrigger): Promise<Snapshot> {
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  const b = await getMariaDbBinaries();
  const rootPw = await getRootPassword();
  const ts = Date.now();
  const filePath = snapshotPath(databaseId, ts);
  const fd = openSync(filePath, "w");
  try {
    const proc = Bun.spawn(
      [
        b.dump,
        `--host=${env.mariadbBind}`,
        `--port=${env.mariadbPort}`,
        `--user=${env.rootUser}`,
        // Local MariaDB instance isn't TLS-configured; mariadb-dump 11.4+
        // requires TLS by default unless we opt out.
        "--skip-ssl",
        "--single-transaction",
        "--quick",
        "--routines",
        "--triggers",
        "--databases",
        row.name,
      ],
      { stdout: fd, stderr: "pipe", env: { ...process.env, MYSQL_PWD: rootPw } },
    );
    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`mysqldump failed (${exit}): ${err}`);
    }
  } finally {
    closeSync(fd);
  }
  const size = statSync(filePath).size;
  const snap: Snapshot = {
    id: newId("snap"),
    databaseId,
    filePath,
    sizeBytes: size,
    createdAt: ts,
    trigger,
  };
  snapshots.insert(snap);
  return snap;
}

export async function restoreSnapshot(databaseId: string, snap: Snapshot): Promise<void> {
  const row = databases.byId(databaseId);
  if (!row) throw new Error("database not found");
  await withRootConnection(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS \`${row.name}\``);
    await c.query(
      `CREATE DATABASE \`${row.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  });
  const b = await getMariaDbBinaries();
  const rootPw = await getRootPassword();
  const sql = readFileSync(snap.filePath);
  const proc = Bun.spawn(
    [
      b.client,
      `--host=${env.mariadbBind}`,
      `--port=${env.mariadbPort}`,
      `--user=${env.rootUser}`,
      "--skip-ssl",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MYSQL_PWD: rootPw },
    },
  );
  proc.stdin.write(sql);
  await proc.stdin.end();
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`mysql restore failed (${exit}): ${err}`);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSnapshotScheduler(): void {
  if (timer) return;
  timer = setInterval(async () => {
    // simple daily scheduled snapshot per DB; cuts after 7 retained.
    const all = databases.list();
    const now = Date.now();
    for (const d of all) {
      const list = snapshots.list(d.id);
      const lastScheduled = list.find((s) => s.trigger === "scheduled");
      if (!lastScheduled || now - lastScheduled.createdAt >= 24 * 60 * 60 * 1000) {
        try {
          await createSnapshot(d.id, "scheduled");
        } catch (err) {
          console.error("[snapshots] failed for", d.name, err);
        }
      }
      // retain last 7 scheduled
      const scheduled = snapshots.list(d.id).filter((s) => s.trigger === "scheduled");
      for (const old of scheduled.slice(7)) {
        try {
          unlinkSync(old.filePath);
        } catch {}
        snapshots.delete(old.id);
      }
    }
  }, 60 * 60 * 1000); // hourly check
}

export function stopSnapshotScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function snapshotSchedulerRunning(): boolean {
  return timer !== null;
}
