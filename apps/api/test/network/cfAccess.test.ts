import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AccessVerifier } from "../../src/network/cfAccess";
import {
  AUD,
  TEAM,
  accessClaims,
  makeRsaKey,
  signHs256,
  signRs256,
  startJwksServer,
  unsignedToken,
  type JwksServer,
  type TestKey,
} from "./helpers";

let keyA: TestKey;
let keyB: TestKey;
let keyC: TestKey;
let jwks: JwksServer;

beforeAll(async () => {
  keyA = await makeRsaKey("kid-a");
  keyB = await makeRsaKey("kid-b");
  keyC = await makeRsaKey("kid-c");
  jwks = startJwksServer([keyA.publicJwk]);
});

afterAll(() => jwks.stop());

function verifier(now?: () => number): AccessVerifier {
  return new AccessVerifier({ teamDomain: TEAM, audience: AUD }, { certsUrl: () => jwks.url, now });
}

describe("Cloudflare Access JWT verification", () => {
  test("accepts a valid token and returns the email", async () => {
    jwks.setKeys([keyA.publicJwk]);
    const v = verifier();
    const result = await v.verify(await signRs256(keyA, accessClaims()));
    expect(result).toMatchObject({ ok: true, email: "owner@example.test", subject: "user-1" });
  });

  test("accepts a string audience claim", async () => {
    const v = verifier();
    const result = await v.verify(await signRs256(keyA, accessClaims({ aud: AUD })));
    expect(result.ok).toBe(true);
  });

  test("rejects a wrong audience", async () => {
    const v = verifier();
    const result = await v.verify(await signRs256(keyA, accessClaims({ aud: ["b".repeat(64)] })));
    expect(result).toEqual({ ok: false, error: "token audience does not match" });
  });

  test("rejects a wrong issuer", async () => {
    const v = verifier();
    const result = await v.verify(await signRs256(keyA, accessClaims({ iss: "https://evil.cloudflareaccess.com" })));
    expect(result).toEqual({ ok: false, error: "token issuer does not match the team domain" });
  });

  test("rejects an expired token", async () => {
    const v = verifier();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const result = await v.verify(await signRs256(keyA, accessClaims({ exp: past, iat: past - 60, nbf: past - 60 })));
    expect(result).toEqual({ ok: false, error: "token has expired" });
  });

  test("rejects a token that is not valid yet", async () => {
    const v = verifier();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const result = await v.verify(await signRs256(keyA, accessClaims({ nbf: future })));
    expect(result).toEqual({ ok: false, error: "token is not valid yet" });
  });

  test("rejects a bad signature", async () => {
    const v = verifier();
    const forged = await signRs256(keyC, accessClaims(), { kid: "kid-a" });
    expect(await v.verify(forged)).toEqual({ ok: false, error: "token signature is invalid" });
    const good = await signRs256(keyA, accessClaims());
    const [h, , s] = good.split(".");
    const tampered = `${h}.${btoa(JSON.stringify(accessClaims({ email: "attacker@example.test" }))).replace(/=+$/, "")}.${s}`;
    expect((await v.verify(tampered)).ok).toBe(false);
  });

  test("an unknown kid triggers exactly one refetch, then is rate-limited", async () => {
    jwks.setKeys([keyA.publicJwk]);
    let clock = Date.now();
    const v = verifier(() => clock);
    const before = jwks.hits();
    expect((await v.verify(await signRs256(keyA, accessClaims()))).ok).toBe(true);
    expect(jwks.hits() - before).toBe(1);

    jwks.setKeys([keyA.publicJwk, keyB.publicJwk]);
    clock += 31_000;
    const rotated = await v.verify(await signRs256(keyB, accessClaims()));
    expect(rotated.ok).toBe(true);
    expect(jwks.hits() - before).toBe(2);

    const unknown = await v.verify(await signRs256(keyC, accessClaims()));
    expect(unknown).toEqual({ ok: false, error: "token is signed with an unknown key" });
    const again = await v.verify(await signRs256(keyC, accessClaims({ sub: "other" })));
    expect(again.ok).toBe(false);
    expect(jwks.hits() - before).toBe(2);
  });

  test("rejects alg none", async () => {
    const v = verifier();
    const result = await v.verify(unsignedToken(accessClaims(), "kid-a"));
    expect(result).toEqual({ ok: false, error: "unsupported token algorithm none" });
  });

  test("rejects HS256 signed with the public key material", async () => {
    const v = verifier();
    const secrets = [
      new TextEncoder().encode(JSON.stringify(keyA.publicJwk)),
      new TextEncoder().encode(keyA.publicJwk.n!),
    ];
    for (const secret of secrets) {
      const result = await v.verify(await signHs256(secret, accessClaims(), "kid-a"));
      expect(result).toEqual({ ok: false, error: "unsupported token algorithm HS256" });
    }
  });

  test("rejects a missing or malformed header", async () => {
    const v = verifier();
    expect((await v.verify(null)).ok).toBe(false);
    expect((await v.verify("")).ok).toBe(false);
    expect(await v.verify("not-a-jwt")).toEqual({ ok: false, error: "token is not a JWT" });
    expect(await v.verify("a.b.c")).toEqual({ ok: false, error: "token is malformed" });
  });

  test("fails closed when the keys cannot be fetched", async () => {
    const v = new AccessVerifier(
      { teamDomain: TEAM, audience: AUD },
      { certsUrl: () => "http://127.0.0.1:1/cdn-cgi/access/certs", fetchTimeoutMs: 1_000 },
    );
    const result = await v.verify(await signRs256(keyA, accessClaims()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("could not fetch Cloudflare Access signing keys");
  });
});
