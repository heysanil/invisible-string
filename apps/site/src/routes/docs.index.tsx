import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/docs` lands on the first doc. */
export const Route = createFileRoute("/docs/")({
  beforeLoad: () => {
    throw redirect({
      to: "/docs/$",
      params: { _splat: "getting-started/overview" },
    });
  },
});
