import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

type Proc = ReturnType<typeof Bun.spawn>;

const procs: { label: string; proc: Proc }[] = [
  { label: "api", proc: spawn(["bun", "run", "--hot", "src/index.ts"], join(root, "apps/api")) },
  { label: "web", proc: spawn(["bun", "run", "vite"], join(root, "apps/web")) },
];

for (const { label, proc } of procs) {
  void pipe(proc.stdout as ReadableStream<Uint8Array>, label);
  void pipe(proc.stderr as ReadableStream<Uint8Array>, label);
}

function spawn(cmd: string[], cwd: string): Proc {
  return Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
}

async function pipe(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const tag = label === "api" ? `\x1b[36m[${label}]\x1b[0m` : `\x1b[35m[${label}]\x1b[0m`;
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${tag} ${line}\n`);
  }
  if (buf) process.stdout.write(`${tag} ${buf}\n`);
}

let stopping = false;

async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    for (const { proc } of procs) proc.kill();
    await Promise.allSettled(procs.map(({ proc }) => proc.exited));
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const first = await Promise.race(procs.map(({ label, proc }) => proc.exited.then((code) => ({ label, code }))));
if (!stopping) {
  console.error(`[dev] ${first.label} exited with code ${first.code}; stopping the rest`);
  await shutdown(first.code === 0 ? 1 : first.code);
}
