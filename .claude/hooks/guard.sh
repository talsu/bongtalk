#!/usr/bin/env bash
# PreToolUse guard for qufox.
# Reads JSON from stdin (Claude Code hook contract). Blocks prod-context mutations.
# Supports --self-test mode that exercises the block patterns without stdin.
#
# Exit codes:
#   0  allow
#   2  block (Claude Code hook convention for blocking PreToolUse)

# Note: no `set -e` — we tolerate empty regex matches when extracting fields.
set -u
set -o pipefail

extract() {
  # $1: field name, $2: payload
  printf '%s' "$2" \
    | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*"(.*)"$/\1/' \
    || true
}

run_guard() {
  local payload="$1"
  if [ -z "$payload" ]; then
    return 0
  fi

  local tool_name command file_path
  tool_name=$(extract tool_name "$payload")
  command=$(extract command "$payload")
  file_path=$(extract file_path "$payload")

  # Bash command patterns. NAS-only single host: the old cloud/orchestrator
  # guards were removed in task-077 (they pointed at infra that does not exist
  # here). What remains maps to real threats on this host.
  if [ "$tool_name" = "Bash" ] && [ -n "$command" ]; then
    case "$command" in
      *"git push --force"*main*|*"git push -f "*main*)
        echo "[guard] BLOCKED: force push to main" >&2; return 2 ;;
      *"git push origin main --force"*|*"git push origin --force main"*)
        echo "[guard] BLOCKED: force push to main" >&2; return 2 ;;
      *"git push"*"--force-with-lease"*main*|*"git push"*"--force-if-includes"*main*)
        echo "[guard] BLOCKED: force push to main (lease)" >&2; return 2 ;;
      *"git push"*main*"--force"*)
        echo "[guard] BLOCKED: force push to main (ref-first)" >&2; return 2 ;;
      *"docker exec"*"qufox-postgres-prod"*|*"docker-compose exec"*"qufox-postgres-prod"*|*"docker compose exec"*"qufox-postgres-prod"*)
        echo "[guard] BLOCKED: direct prod DB access (qufox-postgres-prod)" >&2; return 2 ;;
      "rm -rf /"|"rm -rf /*"|"rm -fr /"|"rm -fr /*")
        echo "[guard] BLOCKED: destructive root rm" >&2; return 2 ;;
      "sudo rm -rf /"|"sudo rm -rf /*"|"sudo rm -fr /"|"sudo rm -fr /*")
        echo "[guard] BLOCKED: destructive root rm" >&2; return 2 ;;
      *"rm -rf --no-preserve-root"*|*"rm -fr --no-preserve-root"*)
        echo "[guard] BLOCKED: destructive root rm (no-preserve-root)" >&2; return 2 ;;
    esac
  fi

  if [ "$tool_name" = "Write" ] || [ "$tool_name" = "Edit" ]; then
    case "$file_path" in
      .env|.env.prod*)
        echo "[guard] BLOCKED: write to prod env file: $file_path" >&2; return 2 ;;
    esac
  fi

  return 0
}

self_test() {
  local failures=0 rc
  check() {
    local label="$1"; local input="$2"; local want="$3"
    run_guard "$input"
    rc=$?
    if [ "$rc" = "$want" ]; then
      echo "  ok   [$label] exit=$rc"
    else
      echo "  FAIL [$label] want=$want got=$rc"
      failures=$((failures + 1))
    fi
  }

  check "allow: pnpm verify" \
    '{"tool_name":"Bash","tool_input":{"command":"pnpm verify"}}' 0
  check "allow: push feat branch" \
    '{"tool_name":"Bash","tool_input":{"command":"git push origin feat/x"}}' 0
  check "allow: force-with-lease feat branch" \
    '{"tool_name":"Bash","tool_input":{"command":"git push --force-with-lease origin feat/x"}}' 0
  check "deny: force push main" \
    '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' 2
  check "deny: force-with-lease main" \
    '{"tool_name":"Bash","tool_input":{"command":"git push --force-with-lease origin main"}}' 2
  check "deny: write .env.prod" \
    '{"tool_name":"Write","tool_input":{"file_path":".env.prod","content":"x"}}' 2
  check "deny: destructive root rm" \
    '{"tool_name":"Bash","tool_input":{"command":"sudo rm -rf /"}}' 2
  check "deny: direct prod db exec" \
    '{"tool_name":"Bash","tool_input":{"command":"docker exec -it qufox-postgres-prod psql -U qufox"}}' 2

  if [ $failures -eq 0 ]; then
    echo "[guard] self-test passed"
    return 0
  else
    echo "[guard] self-test failed ($failures)"
    return 1
  fi
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

payload="$(cat || true)"
run_guard "$payload"
exit $?
