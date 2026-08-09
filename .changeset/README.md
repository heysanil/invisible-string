# Changesets

Files in this directory describe changes waiting to be released. Every
behavior-affecting PR should add one — see the **Releases** section of
`AGENTS.md` for the bump rules, the `**Breaking:**` marker, and the two
workspaces that must never be named.

Write the file directly rather than running `bun changeset`; the interactive
prompt walks all ten workspaces, including the two that are excluded.
