#!/usr/bin/env bash
# Circuit breaker for the deploy pipeline — pillar B of the safe-deploy
# redesign. Source this library (it defines functions, runs nothing).
#
# WHY
#   The 2026-06 runaway was driven by an unbounded retry loop: a bad deploy
#   failed health, an agent/operator fixed-forward and pushed again, which
#   triggered ANOTHER full rebuild, repeat — each rebuild burning btrfs.
#   The breaker caps this: after N consecutive failures for a service the
#   breaker OPENS and auto-deploy refuses to run that service until a human
#   runs `scripts/deploy/reset-breaker.sh <svc>`.
#
# STATE  .deploy/state.json (per-service):
#   { "api": { "consecutiveFailures": 0, "open": false,
#              "lastFailureAt": "...", "deployedSha": "...", "deployedAt": "..." } }
#
# Threshold: QUFOX_BREAKER_THRESHOLD (default 2).
# Requires: jq (present on the NAS at /bin/jq).
set -euo pipefail

BREAKER_THRESHOLD="${QUFOX_BREAKER_THRESHOLD:-2}"
BREAKER_STATE_FILE="${BREAKER_STATE_FILE:-${REPO_PATH:-/volume2/dockers/qufox}/.deploy/state.json}"

breaker::_ensure() {
  mkdir -p "$(dirname "$BREAKER_STATE_FILE")"
  [ -s "$BREAKER_STATE_FILE" ] || echo '{}' > "$BREAKER_STATE_FILE"
}

# Atomic read-modify-write via jq into a temp file then mv.
breaker::_update() {
  local svc="$1" filter="$2"; shift 2
  breaker::_ensure
  local tmp; tmp="$(mktemp)"
  jq --arg svc "$svc" "$@" "$filter" "$BREAKER_STATE_FILE" > "$tmp" && mv "$tmp" "$BREAKER_STATE_FILE"
}

breaker::_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Return 0 if the breaker is OPEN for the service (deploy must be refused).
breaker::is_open() {
  local svc="$1"
  breaker::_ensure
  [ "$(jq -r --arg s "$svc" '.[$s].open // false' "$BREAKER_STATE_FILE")" = "true" ]
}

breaker::consecutive_failures() {
  local svc="$1"
  breaker::_ensure
  jq -r --arg s "$svc" '.[$s].consecutiveFailures // 0' "$BREAKER_STATE_FILE"
}

# Record a failed deploy. Opens the breaker once failures reach the threshold.
breaker::record_failure() {
  local svc="$1" now; now="$(breaker::_now)"
  breaker::_update "$svc" \
    '.[$svc] = ((.[$svc] // {})
       | .consecutiveFailures = ((.consecutiveFailures // 0) + 1)
       | .lastFailureAt = $now
       | .open = (.consecutiveFailures >= ($thr|tonumber)))' \
    --arg now "$now" --arg thr "$BREAKER_THRESHOLD"
  local n; n="$(breaker::consecutive_failures "$svc")"
  if breaker::is_open "$svc"; then
    printf '[breaker] %s OPEN after %s consecutive failures — auto-deploy disabled until `reset-breaker.sh %s`\n' "$svc" "$n" "$svc" >&2
  else
    printf '[breaker] %s failure %s/%s recorded\n' "$svc" "$n" "$BREAKER_THRESHOLD" >&2
  fi
}

# Record a successful deploy: clears failures, closes breaker, stamps sha.
breaker::record_success() {
  local svc="$1" sha="${2:-}" now; now="$(breaker::_now)"
  breaker::_update "$svc" \
    '.[$svc] = ((.[$svc] // {})
       | .consecutiveFailures = 0
       | .open = false
       | .deployedSha = $sha
       | .deployedAt = $now)' \
    --arg sha "$sha" --arg now "$now"
}

# Force the breaker for a service (e.g. btrfs watchdog tripping a halt).
breaker::trip() {
  local svc="$1" reason="${2:-manual}" now; now="$(breaker::_now)"
  breaker::_update "$svc" \
    '.[$svc] = ((.[$svc] // {}) | .open = true | .trippedBy = $reason | .trippedAt = $now)' \
    --arg reason "$reason" --arg now "$now"
  printf '[breaker] %s TRIPPED open (reason: %s)\n' "$svc" "$reason" >&2
}

breaker::reset() {
  local svc="$1"
  if [ "$svc" = all ]; then
    breaker::_ensure
    local tmp; tmp="$(mktemp)"
    jq 'to_entries | map(.value.consecutiveFailures = 0 | .value.open = false) | from_entries' \
      "$BREAKER_STATE_FILE" > "$tmp" && mv "$tmp" "$BREAKER_STATE_FILE"
  else
    breaker::_update "$svc" '.[$svc] = ((.[$svc] // {}) | .consecutiveFailures = 0 | .open = false)'
  fi
  printf '[breaker] %s reset (closed)\n' "$svc"
}

breaker::status() {
  breaker::_ensure
  jq . "$BREAKER_STATE_FILE"
}
