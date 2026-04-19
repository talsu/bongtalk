---
description: Run `pnpm verify`; on failure output raw log + two hypotheses.
---

# /verify

Execute `pnpm verify` from the repo root.

1. Run the command and stream stdout+stderr into the chat.
2. If exit code != 0:
   - Output the **raw** log, no summarization.
   - Propose **exactly 2** hypotheses for the failure.
   - Propose the smallest possible next diagnostic action.
3. If exit 0, output `verify: ok` and proceed.
