declare module "*.mdx" {
  import type { ComponentType } from "react";

  /** YAML frontmatter, surfaced by remark-mdx-frontmatter as a named export. */
  export const frontmatter: {
    title: string;
    section: string;
    order: number;
  };

  const MDXContent: ComponentType<Record<string, unknown>>;
  export default MDXContent;
}
