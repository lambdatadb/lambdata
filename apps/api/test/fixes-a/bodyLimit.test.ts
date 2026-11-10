import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { DEFAULT_BODY_LIMIT_BYTES, bodyLimitFor, buildApp } from "../../src/server";
import { settings } from "../../src/db/queries";
import { MAX_UPLOAD_BYTES, storageTooLargeMessage } from "../../src/routes/storage";
import { newId } from "../../src/util/id";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let bucketId: string;

const BOUNDARY = "lambdata-limit-test";

beforeAll(async () => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  settings.set("setup_complete", "1");
  const res = await app.request("/api/storage/buckets", {
    method: "POST",
    headers: await authHeaders(admin, { "Content-Type": "application/json" }),
    body: JSON.stringify({ name: `limits-${newId().slice(-8)}` }),
  });
  bucketId = ((await res.json()) as { bucket: { id: string } }).bucket.id;
});

afterAll(() => md.cleanup());

function head(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="huge.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe("Storage uploads answer one message whether or not they declare their length", () => {
  test("declared length over the limit", async () => {
    const res = await app.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(admin, {
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        "Content-Length": String(MAX_UPLOAD_BYTES * 2),
      }),
      body: head(),
    });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toBe(storageTooLargeMessage());
  });

  test("chunked body over the limit", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(head());
        if (sent > MAX_UPLOAD_BYTES + 4 * chunk.length) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(admin, { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toBe(storageTooLargeMessage());
  }, 60_000);

  test("every other route stays bounded, including the JSON routes next to the upload routes", () => {
    expect(bodyLimitFor("POST", "/api/storage/buckets/b1/objects")).toBeNull();
    expect(bodyLimitFor("POST", "/api/imports/uploads")).toBeNull();
    expect(bodyLimitFor("POST", "/api/imports/uploads/upl_1/create-database")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitFor("PUT", "/api/storage/buckets/b1/objects")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitFor("POST", "/api/storage/buckets")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitFor("POST", "/api/storage/buckets/b1/objects/o1")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(bodyLimitFor("PATCH", "/api/settings")).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });
});
