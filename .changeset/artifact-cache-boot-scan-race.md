---
"@invisible-string/worker": patch
---

Stop the artifact-cache boot scan from killing worker startup when an entry disappears between readdir and stat.
