---
"@invisible-string/compiler": minor
"@invisible-string/control-plane": minor
"@invisible-string/db": minor
"@invisible-string/design-tokens": minor
"@invisible-string/shared": minor
"@invisible-string/site": minor
"@invisible-string/web": minor
---

**Breaking:** The agent content hash now keys on the agent's stable id instead of its slugified display name, so every agent rebuilds once on its next publish and duplicate agent names are legal; alongside it, publishing no longer blocks the editor, the editor separates unsaved from unpublished changes, chat sessions enter instantly and title themselves, tool calls and a context-budget meter replace raw slugs and build identity in the thread, compaction persists across reloads, and the copilot shows its steps and reasoning, can apply edits without the accept gate, and can set an agent's name and description.
