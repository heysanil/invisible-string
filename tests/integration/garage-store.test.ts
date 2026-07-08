/**
 * Live Garage round-trip for the artifact store (gated).
 *
 * Skips cleanly unless TEST_S3_ENDPOINT is set (same pattern as the
 * TEST_DATABASE_URL-gated suites). Local + CI runs point it at the dev
 * compose garage service:
 *
 *   docker compose up -d --wait garage
 *   TEST_S3_ENDPOINT=http://localhost:3900 bun test tests/integration/garage-store.test.ts
 */
import { describe, expect, test } from "bun:test";

import { createArtifactStore } from "../../apps/control-plane/src/artifacts";

const endpoint = process.env.TEST_S3_ENDPOINT;
const describeGated = endpoint ? describe : describe.skip;

describeGated("garage artifact store (live)", () => {
  const store = createArtifactStore({
    endpoint: endpoint!,
    accessKeyId:
      process.env.S3_ACCESS_KEY_ID ?? "GKdeadbeefdeadbeefdeadbeefdeadbeef",
    secretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ??
      "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
    bucket: process.env.S3_BUCKET ?? "artifacts",
    region: process.env.S3_REGION ?? "us-east-1",
  });
  const key = `artifacts/__garage_roundtrip_${crypto.randomUUID()}.tar.gz`;

  test("put → exists → get → presigned fetch round-trip", async () => {
    const payload = new TextEncoder().encode("garage-roundtrip-proof");
    await store.put(key, payload);

    expect(await store.exists(key)).toBe(true);
    expect(await store.exists(`${key}.missing`)).toBe(false);

    const body = new Uint8Array(await store.getArrayBuffer(key));
    expect(new TextDecoder().decode(body)).toBe("garage-roundtrip-proof");

    // Presigned GET is exactly what a worker does on ensure-agent:
    // a plain fetch with no credentials.
    const url = store.presignGetUrl(key, { expiresInSeconds: 60 });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("garage-roundtrip-proof");
  });
});
