/**
 * Skill CRUD (CONTEXT pillar) + file attachments, both scopes.
 *
 * Attachments are stored in the object store under
 * `skills/<skillId>/<filename>`; the `skills.files` jsonb column records
 * `{ name, key, mediaType }` (matching {@link SkillFileDto}). At publish the
 * compile path fetches the bytes and the compiler emits a packaged skill
 * directory (compile-service.ts). Re-uploading a filename replaces it.
 */
import { normalize } from "node:path";

import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  createSkillRequestSchema,
  updateSkillRequestSchema,
  SKILL_FILE_MAX_BYTES,
  type DeleteResourceResponse,
  type GetSkillResponse,
  type ListSkillsResponse,
  type SkillFileDto,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { errors } from "../runtime/errors";
import {
  parseBody,
  scopeInsertValues,
  scopeWhere,
  skillDto,
  type ResourceDeps,
  type Scope,
} from "./common";

/** A skill may carry at most this many attachments (server-side rule). */
export const SKILL_FILE_MAX_COUNT = 10;

type Row = typeof schema.skills.$inferSelect;

async function loadOwned(db: Db, scope: Scope, id: string): Promise<Row> {
  const rows = await db
    .select()
    .from(schema.skills)
    .where(and(eq(schema.skills.id, id), scopeWhere(schema.skills, scope)))
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.notFound("skill");
  return row;
}

/** Reject absolute paths / traversal in an attachment filename. */
export function assertSafeAttachmentName(name: string): void {
  const normalized = normalize(name);
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.startsWith("/") ||
    name.includes("\0") ||
    normalized.startsWith("..") ||
    normalized.split("/").includes("..")
  ) {
    throw errors.skillFileInvalid(`unsafe attachment filename: "${name}"`);
  }
}

/** Object-store key for one skill attachment. */
export function skillFileKey(skillId: string, name: string): string {
  return `skills/${skillId}/${name}`;
}

export async function listSkills(
  deps: ResourceDeps,
  scope: Scope,
): Promise<ListSkillsResponse> {
  const rows = await deps.db
    .select()
    .from(schema.skills)
    .where(scopeWhere(schema.skills, scope))
    .orderBy(schema.skills.name);
  return { skills: rows.map(skillDto) };
}

export async function getSkill(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<GetSkillResponse> {
  const row = await loadOwned(deps.db, scope, id);
  return { skill: skillDto(row) };
}

export async function createSkill(
  deps: ResourceDeps,
  scope: Scope,
  body: unknown,
): Promise<GetSkillResponse> {
  const input = parseBody(createSkillRequestSchema, body);
  const rows = await deps.db
    .insert(schema.skills)
    .values({
      ...scopeInsertValues(scope),
      name: input.name,
      description: input.description ?? null,
      content: input.content,
      files: null,
    })
    .returning();
  return { skill: skillDto(rows[0]!) };
}

export async function updateSkill(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
  body: unknown,
): Promise<GetSkillResponse> {
  const input = parseBody(updateSkillRequestSchema, body);
  await loadOwned(deps.db, scope, id);
  const patch: Partial<typeof schema.skills.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.content !== undefined) patch.content = input.content;
  const rows = await deps.db
    .update(schema.skills)
    .set(patch)
    .where(and(eq(schema.skills.id, id), scopeWhere(schema.skills, scope)))
    .returning();
  return { skill: skillDto(rows[0]!) };
}

export async function deleteSkill(
  deps: ResourceDeps,
  scope: Scope,
  id: string,
): Promise<DeleteResourceResponse> {
  await loadOwned(deps.db, scope, id);
  await deps.db
    .delete(schema.skills)
    .where(and(eq(schema.skills.id, id), scopeWhere(schema.skills, scope)));
  return { id, deleted: true };
}

export interface UploadedFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export async function uploadSkillFile(
  deps: ResourceDeps,
  scope: Scope,
  skillId: string,
  file: UploadedFile,
): Promise<GetSkillResponse> {
  assertSafeAttachmentName(file.name);
  if (file.bytes.byteLength > SKILL_FILE_MAX_BYTES) {
    throw errors.skillFileTooLarge(SKILL_FILE_MAX_BYTES);
  }
  if (!deps.artifacts) throw errors.skillFilesUnavailable("(upload)");

  const row = await loadOwned(deps.db, scope, skillId);
  const existing = row.files ?? [];
  const isReplace = existing.some((f) => f.name === file.name);
  if (!isReplace && existing.length >= SKILL_FILE_MAX_COUNT) {
    throw errors.skillFileLimitExceeded(SKILL_FILE_MAX_COUNT);
  }

  const key = skillFileKey(skillId, file.name);
  await deps.artifacts.put(key, file.bytes);

  const entry: SkillFileDto = { name: file.name, key, mediaType: file.mediaType };
  const files = isReplace
    ? existing.map((f) => (f.name === file.name ? entry : f))
    : [...existing, entry];

  const rows = await deps.db
    .update(schema.skills)
    .set({ files })
    .where(and(eq(schema.skills.id, skillId), scopeWhere(schema.skills, scope)))
    .returning();
  return { skill: skillDto(rows[0]!) };
}

export async function deleteSkillFile(
  deps: ResourceDeps,
  scope: Scope,
  skillId: string,
  fileName: string,
): Promise<GetSkillResponse> {
  const row = await loadOwned(deps.db, scope, skillId);
  const existing = row.files ?? [];
  const target = existing.find((f) => f.name === fileName);
  if (!target) throw errors.notFound("skill_file");
  const files = existing.filter((f) => f.name !== fileName);
  const rows = await deps.db
    .update(schema.skills)
    .set({ files: files.length > 0 ? files : null })
    .where(and(eq(schema.skills.id, skillId), scopeWhere(schema.skills, scope)))
    .returning();
  // Best-effort object-store cleanup — the row is the source of truth.
  // (No delete() on the ArtifactStore interface; orphaned bytes are harmless
  // and reclaimed by lifecycle policy.)
  return { skill: skillDto(rows[0]!) };
}
