/**
 * Tool picker (connectors redesign spec §10, plan-2 Task 5): the blind
 * free-text tool filter becomes a checkbox picker fed by the cached tool
 * list. Checkboxes render from `tools` (descriptions as tooltips), checking
 * persists the allow/block list, a free-text escape row merges uncached
 * names without duplicates, and a null cache falls back to free text with a
 * probe hint. The agent editor's settings popover embeds the same picker
 * plus a Manage link that opens the connection detail.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ConnectionDto } from "@invisible-string/shared";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { renderWithRouter } from "../test/router";
import { ConnectionDetail } from "../components/context/ConnectionDetail";
import { ContextAttachments } from "../components/context/ContextAttachments";
import { ToastProvider } from "../components/ui/Toast";
import type {
  ContextResources,
  ScopedConnection,
} from "../lib/builder/resources";

ensureDomForThisFile();

const SCOPE = { scope: "workspace", workspaceId: "org_1" } as const;
const ID = "cn_a1b2c3d4e5f6a7b8";

/** Recent lastCheckedAt so the detail's stale auto re-probe never fires. */
function freshCheck(): string {
  return new Date().toISOString();
}

function connectionDto(over: Partial<ConnectionDto>): ConnectionDto {
  return {
    id: ID,
    scope: "workspace",
    name: "Acme Notes",
    description: "Notes for Acme services.",
    source: "custom",
    catalogSlug: null,
    registryName: null,
    url: "https://mcp.acme.dev/mcp",
    transport: "streamable-http",
    authType: "none",
    hasCredentials: false,
    oauthStatus: null,
    toolAllow: null,
    toolBlock: null,
    approvalPolicy: { default: "never" },
    enabled: true,
    health: "ok",
    lastCheckedAt: freshCheck(),
    lastError: null,
    tools: [
      { name: "save_note", description: "Save a note", params: ["title", "body"] },
      { name: "list_notes", description: "List notes", params: [] },
    ],
    toolsCachedAt: freshCheck(),
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...over,
  };
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

function patchCalls() {
  return fetchMock.calls.filter(
    (call) => call.method === "PATCH" && call.path.endsWith(`/connections/${ID}`),
  );
}

function lastPatchBody() {
  const calls = patchCalls();
  return calls[calls.length - 1]?.body as
    | { toolAllow?: string[] | null; toolBlock?: string[] | null }
    | undefined;
}

/** Mount the detail over a DTO; PATCH echoes the patch merged onto it. */
function mountDetail(dto: ConnectionDto) {
  fetchMock
    .on("GET", `/connections/${ID}`, () => jsonResponse({ connection: dto }))
    .on("PATCH", `/connections/${ID}`, (request) =>
      jsonResponse({ connection: { ...dto, ...(request.body as object) } }),
    );
  return renderWithProviders(
    <ConnectionDetail scope={SCOPE} connectionId={ID} readOnly={false} onClose={() => {}} />,
  );
}

/** Commit a name through a TagInput-style free-text row. */
function typeAndEnter(input: HTMLInputElement, value: string) {
  act(() => input.focus());
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

// ── Checkbox picker mechanics (via the connection detail's tool policy) ──────

test("checkboxes render from the cached tool list with descriptions as tooltips", async () => {
  const view = mountDetail(connectionDto({}));

  fireEvent.click(await view.findByRole("button", { name: "allow" }));

  const saveNote = (await view.findByRole("checkbox", {
    name: "save_note",
  })) as HTMLInputElement;
  const listNotes = view.getByRole("checkbox", {
    name: "list_notes",
  }) as HTMLInputElement;
  expect(saveNote.checked).toBe(false);
  expect(listNotes.checked).toBe(false);
  // The description rides the row as a tooltip, not a rendered line.
  expect(saveNote.closest("label")?.title).toBe("Save a note");
});

test("checking two tools persists the allow list with both names", async () => {
  const view = mountDetail(connectionDto({}));

  fireEvent.click(await view.findByRole("button", { name: "allow" }));
  fireEvent.click(await view.findByRole("checkbox", { name: "save_note" }));
  fireEvent.click(view.getByRole("checkbox", { name: "list_notes" }));

  await waitFor(() => {
    expect(lastPatchBody()).toEqual({
      toolAllow: ["save_note", "list_notes"],
      toolBlock: null,
    });
  });
});

test("block mode persists toolBlock, never toolAllow", async () => {
  const view = mountDetail(connectionDto({}));

  fireEvent.click(await view.findByRole("button", { name: "block" }));
  fireEvent.click(await view.findByRole("checkbox", { name: "list_notes" }));

  await waitFor(() => {
    expect(lastPatchBody()).toEqual({
      toolAllow: null,
      toolBlock: ["list_notes"],
    });
  });
});

test("a null tool cache falls back to free text with a probe hint", async () => {
  const view = mountDetail(connectionDto({ tools: null, toolsCachedAt: null }));

  fireEvent.click(await view.findByRole("button", { name: "allow" }));

  // No cache → no checkboxes, an inline hint to discover the tools instead.
  expect(view.queryByRole("checkbox")).toBeNull();
  expect(view.getByText(/Run Test connection to discover/)).toBeTruthy();

  const input = view.getByLabelText("Allowed tools") as HTMLInputElement;
  typeAndEnter(input, "custom_tool");

  await waitFor(() => {
    expect(lastPatchBody()).toEqual({ toolAllow: ["custom_tool"], toolBlock: null });
  });
});

test("the free-text escape merges with checked names without duplicates", async () => {
  const view = mountDetail(connectionDto({}));

  fireEvent.click(await view.findByRole("button", { name: "allow" }));
  fireEvent.click(await view.findByRole("checkbox", { name: "save_note" }));

  const escape = view.getByLabelText("Other tool names") as HTMLInputElement;

  // Typing an already-checked cached name dedupes instead of doubling…
  typeAndEnter(escape, "save_note");
  await waitFor(() => {
    expect(lastPatchBody()).toEqual({ toolAllow: ["save_note"], toolBlock: null });
  });
  // …and it never lingers as a free-text chip (it lives in the cache).
  expect(view.queryByRole("button", { name: "Remove save_note" })).toBeNull();

  // A name the cache does not know joins the list as a chip.
  typeAndEnter(escape, "custom_tool");
  await waitFor(() => {
    expect(lastPatchBody()).toEqual({
      toolAllow: ["save_note", "custom_tool"],
      toolBlock: null,
    });
  });
  expect(view.getByRole("button", { name: "Remove custom_tool" })).toBeTruthy();

  // No PATCH ever carried a duplicate name.
  for (const call of patchCalls()) {
    const body = call.body as { toolAllow?: string[] | null };
    const names = body.toolAllow ?? [];
    expect(new Set(names).size).toBe(names.length);
  }
});

// ── The agent editor's settings popover embeds the same picker ───────────────

test("the settings popover embeds the picker and Manage opens the connection detail", async () => {
  const connection: ScopedConnection = {
    ...connectionDto({ toolAllow: ["save_note"] }),
    resourceScope: "workspace",
  };
  fetchMock.on("GET", `/connections/${ID}`, () =>
    jsonResponse({ connection: connectionDto({ toolAllow: ["save_note"] }) }),
  );
  const resources: ContextResources = {
    connections: [connection],
    skills: [],
    connectionById: new Map([[connection.id, connection]]),
    skillById: new Map(),
    isPending: false,
    isError: false,
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const view = renderWithRouter(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ContextAttachments
          workspaceId="org_1"
          connectionIds={[ID]}
          skillIds={[]}
          onAddConnection={() => {}}
          onRemoveConnection={() => {}}
          onAddSkill={() => {}}
          onRemoveSkill={() => {}}
          resources={resources}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );

  fireEvent.click(await view.findByRole("button", { name: "Acme Notes settings" }));

  // The stored allow list arrives pre-checked in the picker.
  const checkbox = (await view.findByRole("checkbox", {
    name: "save_note",
  })) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);

  // Manage swaps the popover for the full connection detail.
  fireEvent.click(view.getByRole("button", { name: "Manage" }));
  expect(await view.findByText("Tool policy")).toBeTruthy();
  expect(view.getByText("Danger zone")).toBeTruthy();
});
