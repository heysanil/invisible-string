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

/**
 * Sniffing + referrer hardening for the public site. Emitted by the dev server
 * and `vite preview`; the deployed site gets the same two headers from
 * `public/_headers`, which Workers static assets reads. No `X-Frame-Options`
 * here — this is a public marketing site, framing is fine (unlike the
 * authenticated SPA).
 */
const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const mdxPlugin = mdx({
  remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm],
  rehypePlugins: [rehypeSlug],
});

export default defineConfig(({ isSsrBuild }) => ({
  base: normalizeBase(process.env.SITE_BASE),
  build: {
    // The SSR bundle is a module `scripts/prerender.ts` imports — nothing ever
    // serves files out of `.ssr/`, so copying `public/` in means writing a
    // 477 kB `og.png` (and `_headers`, `_redirects`, the favicons…) into a
    // directory where they mean nothing, on every build. The CLIENT build must
    // keep the default `true`: that copy is how they reach `dist/`, which is
    // what Cloudflare uploads.
    copyPublicDir: !isSsrBuild,
  },
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
}));
