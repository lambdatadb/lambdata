import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.TUNNEL_FAKE_DIR;
const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("cloudflared version 2025.1.0 (built 2025-01-01-0000 UTC)");
  process.exit(0);
}

if (!dir) {
  console.error("TUNNEL_FAKE_DIR missing");
  process.exit(2);
}

const record = (entry: Record<string, unknown>): void => {
  appendFileSync(join(dir, "runs.log"), `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

record({ args, token: process.env.TUNNEL_TOKEN ?? null, envKeys: Object.keys(process.env) });

const modeFile = join(dir, "mode");
const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "ok";

if (mode === "crash") {
  console.error('2025-01-01T00:00:00Z ERR Couldn\'t start tunnel error="Unauthorized: Invalid tunnel secret"');
  process.exit(1);
}

const metrics = args[args.indexOf("--metrics") + 1] ?? "127.0.0.1:0";
const sep = metrics.lastIndexOf(":");
Bun.serve({
  hostname: metrics.slice(0, sep),
  port: Number(metrics.slice(sep + 1)),
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/ready") return Response.json({ status: 200, readyConnections: 4, connectorId: "fake" });
    if (path === "/metrics") return new Response("cloudflared_tunnel_ha_connections 4\n");
    return new Response("not found", { status: 404 });
  },
});

console.error("2025-01-01T00:00:00Z INF Starting tunnel tunnelID=00000000-0000-0000-0000-000000000000");
console.error("2025-01-01T00:00:01Z INF Registered tunnel connection connIndex=0 location=ams01 protocol=quic");

process.on("SIGTERM", () => {
  record({ stopped: true });
  process.exit(0);
});

setInterval(() => undefined, 1_000);
