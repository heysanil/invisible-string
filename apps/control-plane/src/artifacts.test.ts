import { describe, expect, test } from "bun:test";

import {
  artifactKeyForHash,
  createArtifactStore,
  createMemoryArtifactStore,
} from "./artifacts";

describe("artifactKeyForHash", () => {
  test("content-addressed tarball key", () => {
    expect(artifactKeyForHash("deadbeef")).toBe("artifacts/deadbeef.tar.gz");
  });
});

describe("createArtifactStore (Bun S3, offline-verifiable parts)", () => {
  const store = createArtifactStore({
    endpoint: "http://localhost:9000",
    accessKeyId: "dev",
    secretAccessKey: "devdevdev",
    bucket: "artifacts",
  });

  test("presigned GET URLs are computed locally and carry a signature", () => {
    const url = store.presignGetUrl("artifacts/abc.tar.gz", {
      expiresInSeconds: 60,
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://localhost:9000");
    expect(parsed.pathname).toContain("artifacts/abc.tar.gz");
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
  });
});

describe("createMemoryArtifactStore", () => {
  test("round-trips bytes and reports existence", async () => {
    const store = createMemoryArtifactStore();
    expect(await store.exists("k")).toBeFalse();
    await store.put("k", "hello");
    expect(await store.exists("k")).toBeTrue();
    const text = new TextDecoder().decode(await store.getArrayBuffer("k"));
    expect(text).toBe("hello");
    expect(store.presignGetUrl("k")).toContain("/k");
  });
});
