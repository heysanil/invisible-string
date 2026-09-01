import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createAppQueryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const queryClient = createAppQueryClient();

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root element");

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
