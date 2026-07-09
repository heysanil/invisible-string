import mdx from "@mdx-js/rollup";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { defineConfig } from "vite";

/**
 * One knob drives everything: `SITE_BASE` sets both the Vite `base` (asset
 * URLs) and the router `basepath` (via `import.meta.env.BASE_URL`). Normalize
 * to a leading + trailing slash so `/invisible-string`, `invisible-string/`,
 * etc. all resolve to `/invisible-string/`. Default `/` for a root deploy.
 * GitHub Pages passes the project subpath here (`configure-pages` output).
 */
function normalizeBase(raw: string | undefined): string {
  if (!raw || raw.trim() === "" || raw.trim() === "/") return "/";
  let base = raw.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  return base;
}

// Default the canonical site URL for local dev so index.html's `%VITE_SITE_URL%`
// substitutions (canonical, OG, Twitter) resolve without a set env var. CI
// overrides this with the real Pages URL.
if (!process.env.VITE_SITE_URL) {
  process.env.VITE_SITE_URL = "http://localhost:5173";
}

/**
 * Sniffing + referrer hardening for the public site. Emitted by the dev server
 * and `vite preview`; GitHub Pages fronts the static build with its own
 * headers. No `X-Frame-Options` here — this is a public marketing site, framing
 * is fine (unlike the authenticated SPA).
 */
const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const mdxPlugin = mdx({
  remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm],
  rehypePlugins: [rehypeSlug],
});

export default defineConfig({
  base: normalizeBase(process.env.SITE_BASE),
  plugins: [
    // MDX must run before the router/react transforms so `.mdx` becomes JSX
    // that they can process.
    { ...mdxPlugin, enforce: "pre" },
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    // `include` so React Fast Refresh also drives the MDX-emitted JSX.
    react({ include: /\.(mdx|js|jsx|ts|tsx)$/ }),
    tailwindcss(),
  ],
  server: { headers: securityHeaders },
  preview: { headers: securityHeaders },
});
