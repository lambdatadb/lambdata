import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  AccessPolicy,
  CloudflareAccessTestResponse,
  NetworkStatusResponse,
} from "@lambdata/shared";
import { audit } from "../db/queries";
import { requireAuth, requireRole, type AuthVariables } from "../auth/middleware";
import { env } from "../env";
import { decryptSecret, encryptSecret } from "../util/crypto";
import { parseJson } from "../util/validate";
import { tailscaleManager, tailscaleServeSet, tailscaleStatus } from "../tailscale/cli";
import {
  effectivePolicy,
  loadNetworkConfig,
  markAccessVerified,
  policyLockedByEnv,
  saveAccessConfig,
  savePolicy,
  savePublicUrls,
  saveServeUrl,
  saveTrustedProxies,
  saveTunnelAutostart,
  saveTunnelMode,
  saveTunnelTokenEnc,
  type AccessConfig,
  type NetworkConfig,
} from "../network/config";
import { classifyRequest, type ClassifyOverrides } from "../network/classify";
import { accessVerifierFor, resetAccessVerifier, TEAM_DOMAIN_SUFFIX } from "../network/cfAccess";
import { cloudflaredBinary, extractTunnelToken, startTunnel, stopTunnel, tunnelState, TunnelError } from "../network/cloudflared";
import { evaluateAccess, lockoutMessage } from "../network/policy";
import { normalizeOrigin } from "../network/origins";
import { formatCidr, parseCidr, type Cidr } from "../network/ip";
import { buildNetworkStatus } from "../network/status";

export const networkRoute = new Hono<{ Variables: AuthVariables }>();

networkRoute.use("*", requireAuth);

const admin = requireRole("admin");

const MAX_PUBLIC_URLS = 20;
const MAX_TRUSTED_PROXIES = 32;

const policySchema = z
  .object({
    allowLan: z.boolean(),
    allowTailnet: z.boolean(),
    allowCloudflare: z.boolean(),
    requireCloudflareAccess: z.boolean(),
    restrictAppApis: z.boolean(),
  })
  .strict();

const policyBody = z.object({ policy: policySchema }).strict();

const originSchema = z.string().transform((value, ctx) => {
  const origin = normalizeOrigin(value);
  if (!origin) {
    ctx.addIssue({ code: "custom", message: `"${value.slice(0, 80)}" is not an origin like https://db.example.com` });
    return z.NEVER;
  }
  return origin;
});

const proxySchema = z.string().transform((value, ctx) => {
  const cidr = parseCidr(value);
  if (!cidr) {
    ctx.addIssue({ code: "custom", message: `"${value.slice(0, 80)}" is not an IP address or CIDR range` });
    return z.NEVER;
  }
  if ((cidr.family === 4 && cidr.prefix < 8) || (cidr.family === 6 && cidr.prefix < 16)) {
    ctx.addIssue({ code: "custom", message: `"${value.slice(0, 80)}" is too broad to trust as a proxy` });
    return z.NEVER;
  }
  return formatCidr(cidr);
});

const addressesBody = z
  .object({
    publicUrls: z.array(originSchema).max(MAX_PUBLIC_URLS),
    trustedProxies: z.array(proxySchema).max(MAX_TRUSTED_PROXIES).optional(),
  })
  .strict();

const tunnelBody = z
  .object({
    mode: z.enum(["off", "managed", "external"]),
    token: z.string().max(8192).optional(),
  })
  .strict();

const teamDomainSchema = z.string().transform((value, ctx) => {
  let s = value.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s.includes(".")) s = `${s}${TEAM_DOMAIN_SUFFIX}`;
  const team = s.endsWith(TEAM_DOMAIN_SUFFIX) ? s.slice(0, -TEAM_DOMAIN_SUFFIX.length) : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(team)) {
    ctx.addIssue({ code: "custom", message: "team domain must look like <team>.cloudflareaccess.com" });
    return z.NEVER;
  }
  return s;
});

const audienceSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{32,128}$/, "audience must be the application's AUD tag (a long hexadecimal string)");

const accessBody = z
  .object({
    teamDomain: teamDomainSchema.nullable(),
    audience: audienceSchema.nullable(),
  })
  .strict();

const serveBody = z.object({ enabled: z.boolean() }).strict();

async function respond(c: Context): Promise<Response> {
  const res: NetworkStatusResponse = { status: await buildNetworkStatus(c) };
  return c.json(res);
}

async function assertNotLockedOut(
  c: Context,
  action: string,
  next: { policy?: AccessPolicy; overrides?: ClassifyOverrides },
): Promise<void> {
  const policy = next.policy ?? effectivePolicy();
  const info = await classifyRequest(c, next.overrides ?? {});
  const verdict = evaluateAccess(policy, info, c.req.path, c.req.method);
  if (!verdict.allowed) throw new HTTPException(409, { message: lockoutMessage(info, verdict, action) });
}

async function assertTunnelNotOnlyWayIn(c: Context, config: NetworkConfig, action: string): Promise<void> {
  if (config.tunnelMode !== "managed" || !tunnelState().running) return;
  const policy = effectivePolicy(config);
  if (policy.allowLan || policy.allowTailnet) return;
  const info = await classifyRequest(c);
  if (info.ingress !== "cloudflare") return;
  throw new HTTPException(409, {
    message: `Refusing to ${action}: you are connected through Cloudflare and the access policy allows no other way in, so this would cut off every remote connection. Allow LAN or Tailnet first.`,
  });
}

const EXTERNAL_NEEDS_PROXY =
  "Requiring Cloudflare Access with your own cloudflared (“Running elsewhere”) needs that cloudflared's address as a trusted proxy, otherwise LambData cannot tell tunnel traffic from LAN traffic. Add it under trusted proxies first.";

function externalWithoutProxy(mode: NetworkConfig["tunnelMode"], requireAccess: boolean, trusted: readonly Cidr[]): boolean {
  return mode === "external" && requireAccess && trusted.length === 0;
}

function userId(c: Context<{ Variables: AuthVariables }>): string {
  return c.get("user").id;
}

networkRoute.get("/status", async (c) => respond(c));

networkRoute.put("/policy", admin, async (c) => {
  const { policy } = await parseJson(c, policyBody);
  if (policyLockedByEnv()) {
    throw new HTTPException(409, {
      message: "The access policy is forced open by LAMBDATA_ACCESS_POLICY=open. Remove that variable and restart LambData to change it.",
    });
  }
  const config = loadNetworkConfig();
  if (policy.requireCloudflareAccess && !config.access) {
    throw new HTTPException(400, {
      message: "Configure Cloudflare Access (team domain and audience tag) before requiring it.",
    });
  }
  if (policy.requireCloudflareAccess && !config.storedPolicy.requireCloudflareAccess && config.accessVerifiedAt === null) {
    throw new HTTPException(400, {
      message: "Open the console through Cloudflare Access and run “Test my session” successfully before requiring Cloudflare Access.",
    });
  }
  if (externalWithoutProxy(config.tunnelMode, policy.requireCloudflareAccess, config.trustedCidrs)) {
    throw new HTTPException(400, { message: EXTERNAL_NEEDS_PROXY });
  }
  await assertNotLockedOut(c, "save this access policy", { policy });
  savePolicy(policy);
  audit.log(userId(c), "network.policy.update", null, { from: config.storedPolicy, to: policy });
  return respond(c);
});

networkRoute.put("/public-urls", admin, async (c) => {
  const body = await parseJson(c, addressesBody);
  const config = loadNetworkConfig();
  const publicUrls = [...new Set(body.publicUrls)];
  const trustedProxies = body.trustedProxies ? [...new Set(body.trustedProxies)] : undefined;
  if (trustedProxies) {
    const trustedCidrs = trustedProxies.map((p) => parseCidr(p)).filter((x): x is Cidr => x !== null);
    if (externalWithoutProxy(config.tunnelMode, effectivePolicy(config).requireCloudflareAccess, trustedCidrs)) {
      throw new HTTPException(400, { message: EXTERNAL_NEEDS_PROXY });
    }
    await assertNotLockedOut(c, "change the trusted proxies", { overrides: { trustedCidrs } });
  }
  savePublicUrls(publicUrls);
  if (trustedProxies) saveTrustedProxies(trustedProxies);
  audit.log(userId(c), "network.addresses.update", null, {
    publicUrls: { from: config.publicUrls, to: publicUrls },
    ...(trustedProxies ? { trustedProxies: { from: config.trustedProxies, to: trustedProxies } } : {}),
  });
  return respond(c);
});

networkRoute.put("/cloudflare/tunnel", admin, async (c) => {
  const body = await parseJson(c, tunnelBody);
  const config = loadNetworkConfig();
  let newToken: string | null | undefined;
  if (body.token !== undefined) {
    if (body.token.trim() === "") {
      newToken = null;
    } else {
      const token = extractTunnelToken(body.token);
      if (!token) {
        throw new HTTPException(400, {
          message: "That does not look like a Cloudflare Tunnel token. Copy the token (or the whole install command) from the tunnel's page in Cloudflare Zero Trust.",
        });
      }
      newToken = token;
    }
  }
  const tokenAfter = newToken === undefined ? config.tunnelTokenEnc : newToken;
  if (body.mode === "managed" && !tokenAfter) {
    throw new HTTPException(400, { message: "A tunnel token is required to run the tunnel from LambData." });
  }
  if (externalWithoutProxy(body.mode, effectivePolicy(config).requireCloudflareAccess, config.trustedCidrs)) {
    throw new HTTPException(400, { message: EXTERNAL_NEEDS_PROXY });
  }
  const stopping = config.tunnelMode === "managed" && (body.mode !== "managed" || newToken === null);
  if (stopping) await assertTunnelNotOnlyWayIn(c, config, "turn off the managed tunnel");

  if (newToken !== undefined) saveTunnelTokenEnc(newToken === null ? null : await encryptSecret(newToken));
  saveTunnelMode(body.mode);
  let restarted = false;
  if (body.mode !== "managed" || newToken === null) {
    saveTunnelAutostart(false);
    await stopTunnel();
  } else if (newToken && tunnelState().running) {
    await startTunnel(newToken);
    restarted = true;
  }
  audit.log(userId(c), "network.cloudflare.tunnel.update", null, {
    mode: { from: config.tunnelMode, to: body.mode },
    tokenUpdated: newToken !== undefined,
    restarted,
  });
  return respond(c);
});

networkRoute.post("/cloudflare/tunnel/start", admin, async (c) => {
  const config = loadNetworkConfig();
  if (config.tunnelMode !== "managed") {
    throw new HTTPException(409, { message: "Set the tunnel mode to “Managed here” before starting it." });
  }
  if (!config.tunnelTokenEnc) throw new HTTPException(409, { message: "Save a tunnel token first." });
  if (!cloudflaredBinary()) {
    throw new HTTPException(409, { message: "cloudflared is not installed on this server." });
  }
  try {
    await startTunnel(await decryptSecret(config.tunnelTokenEnc));
  } catch (err) {
    if (err instanceof TunnelError) throw new HTTPException(409, { message: err.message });
    throw err;
  }
  saveTunnelAutostart(true);
  audit.log(userId(c), "network.cloudflare.tunnel.start", null, null);
  return respond(c);
});

networkRoute.post("/cloudflare/tunnel/stop", admin, async (c) => {
  const config = loadNetworkConfig();
  await assertTunnelNotOnlyWayIn(c, config, "stop the tunnel");
  saveTunnelAutostart(false);
  await stopTunnel();
  audit.log(userId(c), "network.cloudflare.tunnel.stop", null, null);
  return respond(c);
});

networkRoute.put("/cloudflare/access", admin, async (c) => {
  const body = await parseJson(c, accessBody);
  if ((body.teamDomain === null) !== (body.audience === null)) {
    throw new HTTPException(400, { message: "Provide both the team domain and the audience tag, or clear both." });
  }
  const config = loadNetworkConfig();
  const next: AccessConfig | null =
    body.teamDomain && body.audience ? { teamDomain: body.teamDomain, audience: body.audience } : null;
  const unchanged =
    (next === null && config.access === null) ||
    (next !== null &&
      config.access !== null &&
      next.teamDomain === config.access.teamDomain &&
      next.audience === config.access.audience);
  if (unchanged) return respond(c);
  const policy = effectivePolicy(config);
  if (!next && config.storedPolicy.requireCloudflareAccess && !policyLockedByEnv()) {
    throw new HTTPException(409, { message: "Turn off “Require Cloudflare Access” before removing the Access settings." });
  }
  if (policy.requireCloudflareAccess) {
    await assertNotLockedOut(c, "change the Cloudflare Access settings", { overrides: { access: next } });
  }
  saveAccessConfig(next);
  resetAccessVerifier();
  audit.log(userId(c), "network.cloudflare.access.update", null, {
    teamDomain: next?.teamDomain ?? null,
    audience: next?.audience ?? null,
  });
  return respond(c);
});

networkRoute.post("/cloudflare/access/test", admin, async (c) => {
  const config = loadNetworkConfig();
  const result: CloudflareAccessTestResponse = { ok: false, email: null, error: null };
  if (!config.access) {
    result.error = "Cloudflare Access is not configured yet. Save the team domain and audience tag first.";
    return c.json(result);
  }
  const assertion = c.req.header("cf-access-jwt-assertion");
  if (!assertion) {
    result.error = "This request did not come through Cloudflare Access (it has no Cf-Access-Jwt-Assertion header). Open the console through its Cloudflare hostname and try again.";
    return c.json(result);
  }
  const verification = await accessVerifierFor(config.access).verify(assertion);
  if (verification.ok) {
    markAccessVerified(Date.now());
    result.ok = true;
    result.email = verification.email;
  } else {
    result.error = verification.error;
  }
  audit.log(userId(c), "network.cloudflare.access.test", null, { ok: result.ok, email: result.email, error: result.error });
  return c.json(result);
});

networkRoute.post("/tailscale/serve", admin, async (c) => {
  const { enabled } = await parseJson(c, serveBody);
  if (tailscaleManager() === "unraid") {
    throw new HTTPException(409, {
      message: "Tailscale is managed by Unraid. Turn Serve on or off in the LambData container template.",
    });
  }
  const ts = await tailscaleStatus();
  if (!ts.installed) throw new HTTPException(409, { message: "Tailscale is not installed on this server." });
  if (!ts.running) throw new HTTPException(409, { message: "Connect Tailscale before turning on Serve." });
  const r = await tailscaleServeSet(enabled, env.port);
  saveServeUrl(r.status.url);
  if (!r.ok) throw new HTTPException(400, { message: r.error ?? "tailscale serve failed" });
  audit.log(userId(c), enabled ? "network.tailscale.serve.enable" : "network.tailscale.serve.disable", null, {
    url: r.status.url,
  });
  return respond(c);
});
