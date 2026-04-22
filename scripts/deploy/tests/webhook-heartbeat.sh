#!/usr/bin/env bash
# qufox deploy-pipeline heartbeat guard (task-023-D).
#
# The webhook is the single point of truth for production rollouts.
# When it silently stops dispatching (e.g. the 2026-04-20T10:17Z
# host-key incident) the system keeps serving — but every push after
# the break is a ghost deploy: registry + container go stale, the
# next real fix arrives without health-wait / auto-rollback coverage.
# Task 023 revealed we had a monitoring blind spot (the audit.jsonl
# the operator was tailing was a stale copy in the wrong worktree),
# so we hard-wire a heartbeat here.
#
# Success: the canonical audit.jsonl was written to within
#   $QUFOX_HEARTBEAT_MAX_AGE_HOURS hours (default 24).
# Failure: exit non-zero, emit one line to stdout + one line to
#   .deploy/heartbeat-alerts.log. If SLACK_WEBHOOK_URL is set, also
#   POST a tiny JSON payload. The caller (cron / alpine container)
#   decides what to do with the non-zero — typical setup is a
#   `|| true`-free cron entry so the Synology scheduler's "last run"
#   turns red and the operator notices.
#
# Run: scripts/deploy/tests/webhook-heartbeat.sh
# Cron (recommended): */30 * * * * /volume2/dockers/qufox/scripts/deploy/tests/webhook-heartbeat.sh
#
# Intentionally does NOT read SSH / Docker / GitHub — a stuck pipeline
# means the audit file stops advancing; that's the signal. Secondary
# checks (delivery 5xx, rollout failure) surface as exitCode != 0
# entries in the audit.jsonl itself, which a sibling check can lint
# for on the same cadence.

set -euo pipefail

AUDIT_PATH="${QUFOX_AUDIT_PATH:-/volume2/dockers/qufox-deploy/.deploy/audit.jsonl}"
MAX_AGE_HOURS="${QUFOX_HEARTBEAT_MAX_AGE_HOURS:-24}"
ALERT_LOG="${QUFOX_HEARTBEAT_ALERT_LOG:-/volume2/dockers/qufox-deploy/.deploy/heartbeat-alerts.log}"
SLACK_URL="${SLACK_WEBHOOK_URL:-}"

now_epoch=$(date -u +%s)
host=$(hostname)

alert() {
  local level="$1"; shift
  local msg="$*"
  printf '[%s] %s %s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$host" "$msg" >> "$ALERT_LOG" 2>/dev/null || true
  printf '[%s] %s %s\n' "$level" "$host" "$msg" >&2
  if [[ -n "$SLACK_URL" ]]; then
    # Best-effort Slack notify. Don't fail the check because Slack is
    # down — the local alert log + non-zero exit are the primary signal.
    curl -sf -X POST -H 'Content-Type: application/json' \
      --max-time 10 \
      -d "{\"text\":\":warning: qufox webhook heartbeat: $level — $msg\"}" \
      "$SLACK_URL" >/dev/null 2>&1 || true
  fi
}

if [[ ! -e "$AUDIT_PATH" ]]; then
  alert ERR "audit log missing: $AUDIT_PATH"
  exit 2
fi

# Use stat's mtime + compare with the configured threshold. BSD / GNU
# stat flag surface differs; we probe for GNU first, fall back to
# BusyBox-style %Y.
mtime_epoch=$(stat -c %Y "$AUDIT_PATH" 2>/dev/null || stat -f %m "$AUDIT_PATH" 2>/dev/null || echo 0)
if [[ "$mtime_epoch" == "0" ]]; then
  alert ERR "audit log mtime unreadable: $AUDIT_PATH"
  exit 2
fi

age_seconds=$(( now_epoch - mtime_epoch ))
threshold_seconds=$(( MAX_AGE_HOURS * 3600 ))

if (( age_seconds > threshold_seconds )); then
  age_hours=$(( age_seconds / 3600 ))
  alert STALE "audit.jsonl last updated ${age_hours}h ago (threshold ${MAX_AGE_HOURS}h). Check qufox-webhook container + GitHub recent deliveries."
  exit 1
fi

# Sanity check the latest entry is valid JSON and doesn't carry an
# exitCode != 0. If it does, the last deploy failed and the operator
# should know — but this is a soft warning, not a heartbeat failure
# (the webhook itself IS alive).
last_line=$(tail -1 "$AUDIT_PATH" 2>/dev/null || true)
if [[ -z "$last_line" ]]; then
  alert WARN "audit.jsonl empty at $AUDIT_PATH"
  exit 0
fi

# Grep for exitCode — cheap substring check, no jq dependency required.
if echo "$last_line" | grep -q '"exitCode":[1-9]'; then
  alert WARN "last audit entry shows non-zero exitCode: $(echo "$last_line" | cut -c 1-200)"
  # Don't fail the heartbeat itself — the webhook IS dispatching, the
  # deploy just broke. Cron sees exit 0; operator watches the alert log.
fi

# All good.
printf '[%s] OK %s audit.jsonl fresh (age=%ds, max=%ds)\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$host" "$age_seconds" "$threshold_seconds"
exit 0
