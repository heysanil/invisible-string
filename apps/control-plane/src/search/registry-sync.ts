/**
 * Registry → Meilisearch sync ETL (connectors redesign spec §5).
 *
 * Mirrors the official MCP registry into the DISPOSABLE `mcp_registry` index
 * on a fixed cadence (REGISTRY_SYNC_INTERVAL_MS, default 6 h): page the
 * upstream `/v0.1/servers` list, map every row through
 * {@link syncEntryToAction}, apply the batched upserts/deletes, and only then
 * advance the `registry_sync_state` cursor. The first run (no cursor) is a
 * FULL resync — which is also the recovery path for a wiped/empty index;
 * later runs send `updated_since` (+ `include_deleted=true`, so upstream
 * deletions evict their documents).
 *
 * Single-runner semantics ride the schedule-ticker pattern: the whole run
 * executes inside one transaction holding `pg_try_advisory_xact_lock`, so
 * concurrent instances (or an interval tick overlapping a slow run) lose the
 * try-lock and report `{ran: false}` — normal, never an error. A failed page
 * or index task aborts the run WITHOUT advancing the cursor: everything is
 * re-fetched next run (upserts are idempotent by document id).
 *
 * SSRF stance: like resources/registry.ts, this module only ever fetches the
 * resolved registry base URL (the hardcoded REGISTRY_HOST, or the dev/CI-only
 * MCP_REGISTRY_BASE_URL stub override) — never a caller-supplied URL.
 */
import { eq, sql } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { Logger } from "@invisible-string/shared";

import type { Db } from "../db";
import { ensureRegistryIndex, REGISTRY_INDEX, type MeiliClient } from "./meili";
import { syncEntryToAction, type RegistryDocument } from "./registry-docs";

/** Default sync cadence (REGISTRY_SYNC_INTERVAL_MS): 6 hours. */
export const DEFAULT_REGISTRY_SYNC_INTERVAL_MS = 21_600_000;

/** The single `registry_sync_state` row this ETL owns. */
const SYNC_STATE_ID = "official";

/** Upstream page size (the registry caps at 100). */
const PAGE_LIMIT = 100;

/** Per-page fetch timeout (mirrors resources/registry.ts). */
const PAGE_TIMEOUT_MS = 10_000;

/** Max wait for a Meilisearch batch task (full-resync batches are large). */
const MEILI_TASK_TIMEOUT_MS = 120_000;

export interface RegistrySyncOutcome {
  /** False = lost the advisory lock (another instance is syncing) — normal. */
  ran: boolean;
  pages: number;
  upserted: number;
  deleted: number;
}

export interface RegistrySync {
  /** Immediate run, then the interval cadence (idempotent). */
  start(): void;
  /** Stop the interval and wait for an in-flight run to finish. */
  stop(): Promise<void>;
  /** One full sync pass (exposed for tests + operational resyncs). */
  runOnce(): Promise<RegistrySyncOutcome>;
}

export interface RegistrySyncDeps {
  db: Db;
  meili: MeiliClient;
  /** Resolved registry origin (REGISTRY_HOST, or the MCP_REGISTRY_BASE_URL stub). */
  registryBaseUrl: string;
  logger: Logger;
  intervalMs: number;
}

/** One upstream list page, already shape-checked. */
interface RegistryPage {
  servers: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createRegistrySync(deps: RegistrySyncDeps): RegistrySync {
  const { db, meili, logger, intervalMs } = deps;
  const base = deps.registryBaseUrl.replace(/\/+$/, "");

  async function fetchPage(url: URL): Promise<RegistryPage> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `registry sync: page fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`registry sync: upstream responded ${res.status}`);
    }
    const body = asObject((await res.json().catch(() => null)) as unknown);
    if (!body) {
      throw new Error("registry sync: upstream returned a non-object body");
    }
    const servers = Array.isArray(body.servers)
      ? body.servers
          .map((entry) => asObject(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    const metadata = asObject(body.metadata);
    const nextCursor =
      typeof metadata?.nextCursor === "string" && metadata.nextCursor !== ""
        ? metadata.nextCursor
        : null;
    return { servers, nextCursor };
  }

  async function runOnce(): Promise<RegistrySyncOutcome> {
    return db.transaction(async (tx) => {
      // One syncer platform-wide: the xact lock releases on commit/rollback,
      // so a crashed run can never wedge the sync (same pattern as the
      // schedule ticker's per-trigger claims).
      const lockRows = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtext('registry_sync')::bigint) as locked`,
      );
      const locked =
        (lockRows as unknown as Array<{ locked: unknown }>)[0]?.locked === true;
      if (!locked) return { ran: false, pages: 0, upserted: 0, deleted: 0 };

      // The index is disposable: recreate + re-apply settings when missing,
      // so a wiped Meilisearch heals on the next run without operator action.
      await ensureRegistryIndex(meili);

      const stateRows = await tx
        .select()
        .from(schema.registrySyncState)
        .where(eq(schema.registrySyncState.id, SYNC_STATE_ID));
      const lastUpdatedSince = stateRows[0]?.lastUpdatedSince ?? null;
      // Start-time cursor, captured BEFORE fetching: entries updated mid-run
      // land after their page was read but before this timestamp, so the next
      // incremental run re-fetches them instead of losing them.
      const syncStartedAt = new Date();

      const upserts: RegistryDocument[] = [];
      const deletions: string[] = [];
      let pages = 0;
      let cursor: string | null = null;
      do {
        const url = new URL(`${base}/v0.1/servers`);
        url.searchParams.set("limit", String(PAGE_LIMIT));
        url.searchParams.set("version", "latest");
        if (lastUpdatedSince) {
          url.searchParams.set("updated_since", lastUpdatedSince.toISOString());
          // Incremental runs must see upstream deletions to evict their docs
          // (the full first run has nothing to evict from an empty index).
          url.searchParams.set("include_deleted", "true");
        }
        if (cursor) url.searchParams.set("cursor", cursor);
        const page = await fetchPage(url); // throws → run aborts, cursor stays
        pages += 1;
        for (const entry of page.servers) {
          const action = syncEntryToAction(entry);
          if (action.kind === "upsert") upserts.push(action.doc);
          else if (action.kind === "delete") deletions.push(action.id);
        }
        cursor = page.nextCursor;
      } while (cursor);

      const index = meili.index(REGISTRY_INDEX);
      if (upserts.length > 0) {
        const task = await index
          .addDocuments(upserts)
          .waitTask({ timeout: MEILI_TASK_TIMEOUT_MS });
        if (task.status !== "succeeded") {
          throw new Error(
            `registry sync: addDocuments ${task.status}: ${task.error?.message ?? "unknown error"}`,
          );
        }
      }
      if (deletions.length > 0) {
        const task = await index
          .deleteDocuments(deletions)
          .waitTask({ timeout: MEILI_TASK_TIMEOUT_MS });
        if (task.status !== "succeeded") {
          throw new Error(
            `registry sync: deleteDocuments ${task.status}: ${task.error?.message ?? "unknown error"}`,
          );
        }
      }

      // Full success only: advance the incremental cursor.
      await tx
        .insert(schema.registrySyncState)
        .values({
          id: SYNC_STATE_ID,
          lastUpdatedSince: syncStartedAt,
          lastSyncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.registrySyncState.id,
          set: { lastUpdatedSince: syncStartedAt, lastSyncedAt: new Date() },
        });

      return {
        ran: true,
        pages,
        upserted: upserts.length,
        deleted: deletions.length,
      };
    });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  /** Fire one tracked run; failures degrade search only — log and carry on. */
  function kick(): void {
    inFlight = runOnce()
      .then((outcome) => {
        if (!outcome.ran) return;
        logger.info("registry_sync.completed", {
          fields: {
            pages: outcome.pages,
            upserted: outcome.upserted,
            deleted: outcome.deleted,
          },
        });
      })
      .catch((error) => {
        logger.warn("registry_sync.failed", {
          msg: "registry sync run failed — community search may serve stale results",
          err: error,
        });
      });
  }

  return {
    start() {
      if (started) return;
      started = true;
      kick();
      // Overlap-safe: a tick that fires while a slow run is still in flight
      // loses the advisory try-lock and no-ops.
      timer = setInterval(kick, intervalMs);
    },
    async stop() {
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
    },
    runOnce,
  };
}
