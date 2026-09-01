/**
 * The app's TanStack Query client. A factory rather than a module singleton
 * so tests get an isolated cache per render — a shared client would leak
 * one test's viewer into the next.
 *
 * `refetchOnWindowFocus: false` is the app-wide default because product
 * resources are workspace-scoped and rarely change under the user. The
 * viewer query deliberately overrides it (lib/auth/viewer.ts): focus is how
 * a session revoked or signed out in another tab gets noticed.
 */
import { QueryClient } from "@tanstack/react-query";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
}
