import { IMPORT_USER_PREFIX, createScopedAccount, dropScopedAccount } from "../mariadb/scopedAccount";
import { loadStream, MariaDbToolError } from "../mariadb/process";
import { DumpRejectedError, DumpRewriter, type RewriteSummary } from "./dumpRewrite";
import type { LoadReporter } from "./sqliteLoad";

const LOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const KILL_WAIT_MS = 2500;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function friendlyLoadError(message: string, user: string): string {
  let out = message.replaceAll(user, "the import account");
  const line = /at line (\d+)/.exec(message)?.[1];
  if (/ERROR (1044|1045|1142|1143|1227|1370|1410|1396|1211)\b/.test(message) || /Access denied/i.test(message)) {
    out += `. The dump tried to reach something outside its own database${line ? ` (line ${line})` : ""}; dumps are loaded with access to the new database only.`;
  } else if (/utf8mb4_0900|Unknown collation/i.test(message)) {
    out += ". The dump uses a collation this MariaDB does not know (MySQL 8 dumps use utf8mb4_0900_*).";
  }
  return out;
}

export interface SqlLoadResult {
  importUser: string;
  summary: RewriteSummary;
}

export async function loadSqlDumpIntoSchema(p: {
  path: string;
  compressed: boolean;
  sizeBytes: number;
  schema: string;
  reporter: LoadReporter;
  afterLoad?: (importUser: string) => Promise<void>;
}): Promise<SqlLoadResult> {
  const account = await createScopedAccount({ schemas: [p.schema], prefix: IMPORT_USER_PREFIX });
  try {
    const target = account.target;
    const rewriter = new DumpRewriter();
    const abort = new AbortController();
    let failure: unknown = null;
    let readBytes = 0;
    let lastReport = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        readBytes += chunk.byteLength;
        const now = performance.now();
        if (now - lastReport > 250) {
          lastReport = now;
          p.reporter.progress(0.02 + 0.9 * Math.min(1, readBytes / Math.max(1, p.sizeBytes)));
        }
        controller.enqueue(chunk);
      },
    });
    let source: ReadableStream<Uint8Array> = Bun.file(p.path).stream().pipeThrough(counter);
    if (p.compressed) source = source.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
    const reader = source.getReader();
    const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, err: unknown) => {
      failure = err;
      abort.abort();
      await new Promise((r) => setTimeout(r, KILL_WAIT_MS));
      controller.error(err);
    };
    const input = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              for (const piece of rewriter.finish()) controller.enqueue(piece);
              controller.close();
              return;
            }
            const pieces = rewriter.push(value);
            for (const piece of pieces) controller.enqueue(piece);
            if (pieces.length > 0) return;
          }
        } catch (err) {
          await fail(controller, err);
        }
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => {});
      },
    });
    p.reporter.stage("Loading the dump");
    try {
      await loadStream(target, p.schema, input, {
        args: ["--binary-mode", "--local-infile=0"],
        timeoutMs: LOAD_TIMEOUT_MS,
        signal: abort.signal,
      });
    } catch (err) {
      if (failure) throw failure instanceof DumpRejectedError ? failure : new Error(`Reading the dump failed: ${errorMessage(failure)}`);
      if (err instanceof MariaDbToolError) throw new Error(friendlyLoadError(err.message, account.user));
      throw err;
    }
    if (failure) throw failure instanceof DumpRejectedError ? failure : new Error(`Reading the dump failed: ${errorMessage(failure)}`);
    if (p.afterLoad) await p.afterLoad(account.user);
    return { importUser: account.user, summary: rewriter.summary };
  } finally {
    await dropScopedAccount(account).catch((err) => {
      p.reporter.warn(`Could not remove the temporary import account ${account.user}; it is removed at the next cleanup: ${errorMessage(err)}`);
    });
  }
}
