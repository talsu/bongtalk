---
description: Snapshot system state to .debug/latest.json and analyze it.
---

# /debug

1. Run `pnpm debug:dump`.
2. Read `.debug/latest.json`.
3. Output: reachability of DB + Redis, top 3 anomalies (by heuristic), next diagnostic step.
4. If `logs` shows repeated errorCode, surface it first.
