import { env } from "../env";
import { loadNetworkConfig } from "./config";

export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 255) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (!url.hostname) return null;
  return url.origin;
}

export function configuredOrigins(): string[] {
  const config = loadNetworkConfig();
  const out = [...config.publicUrls];
  if (config.serveUrl) {
    const serve = normalizeOrigin(config.serveUrl);
    if (serve) out.push(serve);
  }
  return out;
}

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (
    origin === env.webOrigin ||
    origin === `http://${env.host}:${env.port}` ||
    env.extraOrigins.includes(origin)
  ) {
    return true;
  }
  return configuredOrigins().includes(origin);
}
