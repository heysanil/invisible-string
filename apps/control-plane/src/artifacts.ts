/**
 * Object-store client for build artifacts (docs/PLAN.md Phase 1 task 3).
 *
 * S3-compatible (Garage in the compose stack) via Bun's built-in S3 client.
 * Artifacts are content-addressed tarballs: `artifacts/<hash>.tar.gz`.
 * Workers download them through short-lived presigned GET URLs — the control
 * plane never streams artifact bytes through itself on the dispatch path.
 *
 * Config comes from env (see `loadRuntimeConfig`): S3_ENDPOINT,
 * S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET (default "artifacts",
 * created by the garage service's GARAGE_DEFAULT_* env), optional S3_REGION.
 */
import { S3Client } from "bun";

export interface ArtifactStoreConfig {
  /** e.g. http://localhost:3900 (Garage) — path-style addressing is used. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket name (the garage service auto-creates "artifacts"). */
  bucket: string;
  region?: string;
}

/** Canonical object key for a build tarball. */
export function artifactKeyForHash(contentHash: string): string {
  return `artifacts/${contentHash}.tar.gz`;
}

export interface PresignOptions {
  /** URL validity in seconds (default 3600 — long enough for a slow pull). */
  expiresInSeconds?: number;
}

/**
 * Minimal artifact-store surface the build service and dispatcher consume.
 * Interface (not the concrete Bun client) so tests can run in-memory.
 */
export interface ArtifactStore {
  put(key: string, data: Uint8Array | string): Promise<void>;
  getArrayBuffer(key: string): Promise<ArrayBuffer>;
  exists(key: string): Promise<boolean>;
  /** Presigned GET URL a worker can download without credentials. */
  presignGetUrl(key: string, options?: PresignOptions): string;
}

const DEFAULT_PRESIGN_EXPIRES_SECONDS = 3600;

export function createArtifactStore(config: ArtifactStoreConfig): ArtifactStore {
  const client = new S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    // Garage serves buckets at <endpoint>/<bucket> (path style), not as a
    // virtual-host subdomain.
    virtualHostedStyle: false,
  });

  return {
    async put(key, data) {
      await client.write(key, data);
    },
    async getArrayBuffer(key) {
      return client.file(key).arrayBuffer();
    },
    async exists(key) {
      return client.exists(key);
    },
    presignGetUrl(key, options) {
      return client.presign(key, {
        expiresIn: options?.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRES_SECONDS,
        method: "GET",
      });
    },
  };
}

/**
 * In-memory ArtifactStore for tests (unit + the fake-agent integration loop —
 * Garage is only exercised in the compose integration stage).
 */
export function createMemoryArtifactStore(
  baseUrl = "http://artifacts.test",
): ArtifactStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key, data) {
      objects.set(
        key,
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      );
    },
    async getArrayBuffer(key) {
      const found = objects.get(key);
      if (!found) throw new Error(`artifact not found: ${key}`);
      return found.slice().buffer as ArrayBuffer;
    },
    async exists(key) {
      return objects.has(key);
    },
    presignGetUrl(key) {
      return `${baseUrl}/${key}?signature=test`;
    },
  };
}
