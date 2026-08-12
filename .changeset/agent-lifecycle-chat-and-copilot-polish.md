---
"@invisible-string/compiler": minor
"@invisible-string/control-plane": minor
"@invisible-string/db": minor
"@invisible-string/design-tokens": minor
"@invisible-string/shared": minor
"@invisible-string/site": minor
"@invisible-string/web": minor
---

**Breaking:** The agent content hash now keys on the agent's stable id instead of its slugified display name, so every agent rebuilds once on its next publish and duplicate agent names are legal; alongside it, publishing no longer blocks the editor and its build watch follows you across the whole app, the editor separates unsaved from unpublished changes, chat sessions enter instantly and title themselves (falling back to the thread's first message, which the session list now carries), tool calls and a context-budget meter replace raw slugs and build identity in the thread, clearing or compacting the context leaves a divider that survives a reload while a compaction with nothing to summarize says so, and the copilot shows its steps and reasoning, can set an agent's name and description and sees both as the editor currently holds them, can apply edits without the accept gate, and reports an edit that failed to apply as failed.
