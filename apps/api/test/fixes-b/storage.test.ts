import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authHeaders, seedUser, useTempMetadata, type SeededUser, type TempMetadata } from "../harness/sqlite";
import { buildApp } from "../../src/server";
import { storageObjects } from "../../src/db/queries";
import { env } from "../../src/env";
import { MAX_UPLOAD_BYTES, contentDisposition } from "../../src/routes/storage";

let md: TempMetadata;
let app: ReturnType<typeof buildApp>;
let admin: SeededUser;
let bucketId: string;
let bucketName: string;

beforeAll(async () => {
  md = useTempMetadata();
  app = buildApp();
  admin = seedUser("admin");
  bucketName = `pub-${Date.now().toString(36)}`;
  const res = await app.request("/api/storage/buckets", {
    method: "POST",
    headers: await authHeaders(admin, { "Content-Type": "application/json" }),
    body: JSON.stringify({ name: bucketName, public: true }),
  });
  expect(res.status).toBe(200);
  bucketId = (await res.json()).bucket.id;
});

afterAll(() => md.cleanup());

function uploadsDir(): string {
  return join(env.storageDir, ".uploads");
}

function pendingUploads(): string[] {
  return existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : [];
}

async function upload(name: string, type: string, content: string | Uint8Array, query = ""): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([content as BlobPart], name, { type }));
  return app.request(`/api/storage/buckets/${bucketId}/objects${query}`, {
    method: "POST",
    headers: await authHeaders(admin),
    body: form,
  });
}

async function uploadObject(name: string, type: string, content: string | Uint8Array): Promise<{ id: string; name: string }> {
  const res = await upload(name, type, content, "?upsert=1");
  expect(res.status).toBe(200);
  return (await res.json()).object;
}

function multipartStream(boundary: string, parts: Uint8Array[], chunkSize: number, hang = false): ReadableStream<Uint8Array> {
  const whole = Buffer.concat(parts);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= whole.length) {
        if (hang) return new Promise(() => {});
        controller.close();
        return;
      }
      controller.enqueue(whole.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe("serving stored objects", () => {
  const cases = [
    { name: "evil.html", type: "text/html", inline: false },
    { name: "pic.svg", type: "image/svg+xml", inline: false },
    { name: "doc.pdf", type: "application/pdf", inline: false },
    { name: "data.json", type: "application/json", inline: false },
    { name: "photo.png", type: "image/png", inline: true },
    { name: "photo.jpg", type: "image/jpeg", inline: true },
    { name: "anim.gif", type: "image/gif", inline: true },
    { name: "pic.webp", type: "image/webp", inline: true },
    { name: "notes.txt", type: "text/plain", inline: true },
  ];

  test("public objects are inline only for safe types, always nosniff and sandboxed", async () => {
    for (const c of cases) {
      await uploadObject(c.name, c.type, "<script>alert(1)</script>");
      const res = await app.request(`/api/storage/public/${bucketName}/${c.name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const disposition = res.headers.get("content-disposition")!;
      expect(disposition.startsWith(c.inline ? "inline;" : "attachment;")).toBe(true);
      expect(await res.text()).toBe("<script>alert(1)</script>");
    }
    const text = await app.request(`/api/storage/public/${bucketName}/notes.txt`);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const png = await app.request(`/api/storage/public/${bucketName}/photo.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
    const forced = await app.request(`/api/storage/public/${bucketName}/photo.png?download=1`);
    expect(forced.headers.get("content-disposition")!.startsWith("attachment;")).toBe(true);
  });

  test("console downloads are attachments unless a safe type asks for inline", async () => {
    const png = await uploadObject("console.png", "image/png", "png");
    const html = await uploadObject("console.html", "text/html", "<b>x</b>");
    const get = async (id: string, query = "") =>
      app.request(`/api/storage/buckets/${bucketId}/objects/${id}/download${query}`, { headers: await authHeaders(admin) });
    for (const res of [await get(png.id), await get(html.id), await get(html.id, "?inline=1")]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")!.startsWith("attachment;")).toBe(true);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
    }
    const preview = await get(png.id, "?inline=1");
    expect(preview.headers.get("content-disposition")!.startsWith("inline;")).toBe(true);
  });

  test("a stored type with parameters or junk is reduced to its essence", async () => {
    await uploadObject("param.png", "image/png; foo=bar", "x");
    const row = storageObjects.byBucketAndName(bucketId, "param.png")!;
    expect(row.mimeType).toBe("image/png");
    const res = await app.request(`/api/storage/public/${bucketName}/param.png`);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("non-ASCII object names", () => {
  test("download headers encode the file name per RFC 6266 and 5987", async () => {
    const name = "résumé 日本 (v2).txt";
    const object = await uploadObject(name, "text/plain", "hello");
    expect(object.name).toBe(name);
    const res = await app.request(`/api/storage/buckets/${bucketId}/objects/${object.id}/download`, {
      headers: await authHeaders(admin),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="r_sum_ __ (v2).txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC%20%28v2%29.txt`,
    );
    const pub = await app.request(`/api/storage/public/${bucketName}/${encodeURIComponent(name)}`);
    expect(pub.status).toBe(200);
    expect(await pub.text()).toBe("hello");
  });

  test("contentDisposition never emits raw non-ASCII or quotes", () => {
    const value = contentDisposition("attachment", "a\"b\\c%dé😀\ud800.bin");
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
    expect(value).toBe(`attachment; filename="a_b_c_d___.bin"; filename*=UTF-8''a%22b%5Cc%25d%C3%A9%F0%9F%98%80%EF%BF%BD.bin`);
    expect(contentDisposition("inline", "plain name.png")).toBe(
      `inline; filename="plain name.png"; filename*=UTF-8''plain%20name.png`,
    );
  });

  test("control characters in names are refused", async () => {
    const res = await app.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(admin, { "Content-Type": "multipart/form-data; boundary=cc" }),
      body: `--cc\r\nContent-Disposition: form-data; name="file"; filename="bad\u0001name.txt"\r\n\r\nabc\r\n--cc--\r\n`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("control characters");
    expect(pendingUploads()).toEqual([]);
  });
});

describe("streaming uploads", () => {
  test("a chunked multipart upload with boundaries split across chunks is stored exactly", async () => {
    const boundary = "----fixesB" + Date.now();
    for (const { size, chunkSize } of [
      { size: 3 * 1024 * 1024 + 17, chunkSize: 0 },
      { size: 3 * 1024 * 1024 + 17, chunkSize: 4093 },
      { size: 40_000, chunkSize: 7 },
    ]) {
      const payload = new Uint8Array(size);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
      payload.set(Buffer.from(`\r\n--${boundary.slice(0, -2)}`), 1000);
      const parts = [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="raw.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        payload,
        Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nnested/streamed.bin\r\n--${boundary}--\r\n`),
      ];
      const body = chunkSize === 0 ? Buffer.concat(parts) : multipartStream(boundary, parts, chunkSize);
      const res = await app.request(`/api/storage/buckets/${bucketId}/objects?upsert=1`, {
        method: "POST",
        headers: await authHeaders(admin, { "Content-Type": `multipart/form-data; boundary=${boundary}` }),
        body,
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(200);
      const object = (await res.json()).object;
      expect(object.name).toBe("nested/streamed.bin");
      expect(object.sizeBytes).toBe(payload.length);
      const stored = storageObjects.byId(object.id)!;
      expect(Buffer.compare(readFileSync(join(env.storageDir, stored.relativePath)), Buffer.from(payload))).toBe(0);
    }
    expect(pendingUploads()).toEqual([]);
  }, 60_000);

  test("the file is written to disk while the request is still arriving", async () => {
    const boundary = "----fixesBprogress";
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.bin"\r\n\r\n`),
        );
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      },
    });
    const pending = app.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(admin, { "Content-Type": `multipart/form-data; boundary=${boundary}` }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    const deadline = Date.now() + 10_000;
    let partial = 0;
    while (Date.now() < deadline) {
      const files = pendingUploads();
      if (files.length === 1) partial = Bun.file(join(uploadsDir(), files[0]!)).size;
      if (partial >= 1024 * 1024) break;
      await Bun.sleep(25);
    }
    expect(partial).toBeGreaterThanOrEqual(1024 * 1024);
    controllerRef!.error(new Error("client went away"));
    const res = await pending;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("interrupted");
    expect(pendingUploads()).toEqual([]);
    expect(storageObjects.byBucketAndName(bucketId, "slow.bin")).toBeNull();
  }, 30_000);

  test("the size cap is enforced while streaming, before the body ends", async () => {
    const boundary = "----fixesBcap";
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.bin"\r\n\r\n`);
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(head);
        if (sent > MAX_UPLOAD_BYTES + chunk.length) return new Promise(() => {});
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(admin, { "Content-Type": `multipart/form-data; boundary=${boundary}` }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("The file is larger than the 250 MB limit for files in Storage.");
    expect(sent).toBeLessThan(MAX_UPLOAD_BYTES + 1024 * 1024);
    expect(pendingUploads()).toEqual([]);
    expect(storageObjects.byBucketAndName(bucketId, "huge.bin")).toBeNull();
  }, 120_000);

  test("a conflicting upload is refused and leaves nothing behind", async () => {
    await uploadObject("conflict.txt", "text/plain", "first");
    const res = await upload("conflict.txt", "text/plain", "second");
    expect(res.status).toBe(409);
    expect(pendingUploads()).toEqual([]);
    const pub = await app.request(`/api/storage/public/${bucketName}/conflict.txt`);
    expect(await pub.text()).toBe("first");
    await uploadObject("conflict.txt", "text/plain", "third");
    expect(await (await app.request(`/api/storage/public/${bucketName}/conflict.txt`)).text()).toBe("third");
  });

  test("malformed uploads get 400", async () => {
    const headers = await authHeaders(admin, { "Content-Type": "application/json" });
    const notMultipart = await app.request(`/api/storage/buckets/${bucketId}/objects`, { method: "POST", headers, body: "{}" });
    expect(notMultipart.status).toBe(400);
    const form = new FormData();
    form.append("name", "x.txt");
    const noFile = await app.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(admin),
      body: form,
    });
    expect(noFile.status).toBe(400);
    const truncated = await app.request(`/api/storage/buckets/${bucketId}/objects`, {
      method: "POST",
      headers: await authHeaders(admin, { "Content-Type": "multipart/form-data; boundary=zz" }),
      body: `--zz\r\nContent-Disposition: form-data; name="file"; filename="t.txt"\r\n\r\nabc`,
    });
    expect(truncated.status).toBe(400);
    expect(pendingUploads()).toEqual([]);
  });
});
