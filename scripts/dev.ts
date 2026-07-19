// Run API and web Vite dev server in parallel, streaming both to stdout.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const procs = [
  spawn("api", ["bun", "run", "--hot", "src/index.ts"], join(root, "apps/api")),
  spawn("web", ["bun", "run", "--cwd", "apps/web", "vite"], root),
];

function spawn(label: string, cmd: string[], cwd: string): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  pipe(proc.stdout, label);
  pipe(proc.stderr, label);
  return proc;
}

async function pipe(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const colorize = label === "api"
    ? (s: string) => `\x1b[36m[${label}]\x1b[0m ${s}`
    : (s: string) => `\x1b[35m[${label}]\x1b[0m ${s}`;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${colorize(line)}\n`);
    }
  }
  if (buf) process.stdout.write(`${colorize(buf)}\n`);
}

const shutdown = (): void => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race(procs.map((p) => p.exited));
shutdown();
