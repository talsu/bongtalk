---
description: Start the Agent Loop for a task doc in docs/tasks/.
argument-hint: NNN
---

# /task {NNN}

1. Read `docs/tasks/{NNN}-*.md`. If multiple match, pick the lowest NNN.
2. Enter the Agent Loop (UNDERSTAND → PLAN → SCAFFOLD → IMPLEMENT → VERIFY → OBSERVE → REFACTOR → REPORT).
3. Do **not** begin IMPLEMENT until the PLAN is printed.
4. Between steps, print a one-line `step=<STAGE>` marker.
5. On VERIFY failure, do not silently retry; stop after 3 consecutive fails, emit 3 hypotheses, and ask for guidance.
