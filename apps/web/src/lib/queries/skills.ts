/**
 * Skill hooks — CRUD + file attachments, BOTH scopes via {@link ScopeRef}.
 *
 * Attachments are direct multipart uploads (`POST <base>/:id/files`, field
 * name SKILL_FILE_FORM_FIELD) capped at SKILL_FILE_MAX_BYTES — the client
 * pre-checks the size so oversized files fail instantly with the same error
 * code the server would return, before any bytes travel.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  deleteResourceResponseSchema,
  getSkillResponseSchema,
  listSkillsResponseSchema,
  SKILL_FILE_FORM_FIELD,
  SKILL_FILE_MAX_BYTES,
  type CreateSkillRequest,
  type GetSkillResponse,
  type UpdateSkillRequest,
} from "@invisible-string/shared";

import { api, ApiError } from "../api-client";
import { queryKeys, scopeBasePath, type ScopeRef } from "./keys";

const basePath = (ref: ScopeRef) => scopeBasePath(ref, "skills");

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchSkills(ref: ScopeRef, signal?: AbortSignal) {
  return api.get(basePath(ref), listSkillsResponseSchema, { signal });
}

export function fetchSkill(ref: ScopeRef, skillId: string, signal?: AbortSignal) {
  return api.get(`${basePath(ref)}/${skillId}`, getSkillResponseSchema, {
    signal,
  });
}

// ── invalidation ────────────────────────────────────────────────────────────

export function invalidateSkills(
  queryClient: QueryClient,
  ref: ScopeRef,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.skills.all(ref) });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useSkills(ref: ScopeRef) {
  return useQuery({
    queryKey: queryKeys.skills.list(ref),
    queryFn: ({ signal }) => fetchSkills(ref, signal),
    select: (data) => data.skills,
    staleTime: 60_000,
  });
}

export function useSkill(ref: ScopeRef, skillId: string) {
  return useQuery({
    queryKey: queryKeys.skills.detail(ref, skillId),
    queryFn: ({ signal }) => fetchSkill(ref, skillId, signal),
    select: (data) => data.skill,
    staleTime: 60_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

function seedDetail(
  queryClient: QueryClient,
  ref: ScopeRef,
  data: GetSkillResponse,
) {
  queryClient.setQueryData<GetSkillResponse>(
    queryKeys.skills.detail(ref, data.skill.id),
    data,
  );
}

export function useCreateSkill(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillRequest) =>
      api.post(basePath(ref), getSkillResponseSchema, { body: input }),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateSkills(queryClient, ref);
    },
  });
}

export function useUpdateSkill(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { skillId: string; patch: UpdateSkillRequest }) =>
      api.patch(`${basePath(ref)}/${input.skillId}`, getSkillResponseSchema, {
        body: input.patch,
      }),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateSkills(queryClient, ref);
    },
  });
}

export function useDeleteSkill(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) =>
      api.delete(`${basePath(ref)}/${skillId}`, deleteResourceResponseSchema),
    onSuccess: async (data) => {
      queryClient.removeQueries({
        queryKey: queryKeys.skills.detail(ref, data.id),
      });
      await invalidateSkills(queryClient, ref);
    },
  });
}

/** Upload one attachment; re-uploading an existing name replaces it. */
export function useUploadSkillFile(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { skillId: string; file: File }) => {
      if (input.file.size > SKILL_FILE_MAX_BYTES) {
        const maxMib = Math.floor(SKILL_FILE_MAX_BYTES / (1024 * 1024));
        return Promise.reject(
          new ApiError(
            413,
            "skill_file_too_large",
            `Files are limited to ${maxMib} MiB.`,
          ),
        );
      }
      const form = new FormData();
      form.append(SKILL_FILE_FORM_FIELD, input.file, input.file.name);
      return api.postForm(
        `${basePath(ref)}/${input.skillId}/files`,
        getSkillResponseSchema,
        form,
      );
    },
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateSkills(queryClient, ref);
    },
  });
}

export function useDeleteSkillFile(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { skillId: string; fileName: string }) =>
      api.delete(
        `${basePath(ref)}/${input.skillId}/files/${encodeURIComponent(input.fileName)}`,
        getSkillResponseSchema,
      ),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateSkills(queryClient, ref);
    },
  });
}
