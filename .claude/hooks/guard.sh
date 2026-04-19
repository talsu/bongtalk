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

  # MCP prod block
  case "$tool_name" in
    mcp__postgres-prod__*) echo "[guard] BLOCKED: prod postgres MCP usage" >&2; return 2 ;;
  esac

  # Bash command patterns
  if [ "$tool_name" = "Bash" ] && [ -n "$command" ]; then
    case "$command" in
      *"kubectl --context=prod"*|*"kubectl --context=production"*)
        echo "[guard] BLOCKED: kubectl against prod cluster" >&2; return 2 ;;
      *"helm --kube-context=prod"*)
        echo "[guard] BLOCKED: helm against prod cluster" >&2; return 2 ;;
      *"terraform apply"*prod*)
        echo "[guard] BLOCKED: terraform apply against prod" >&2; return 2 ;;
      *"git push --force"*main*|*"git push -f "*main*)
        echo "[guard] BLOCKED: force push to main" >&2; return 2 ;;
      *"git push origin main --force"*|*"git push origin --force main"*)
        echo "[guard] BLOCKED: force push to main" >&2; return 2 ;;
      *"aws secretsmanager put-secret-value"*)
        echo "[guard] BLOCKED: writing secrets" >&2; return 2 ;;
      "rm -rf /"|"rm -rf /*")
        echo "[guard] BLOCKED: destructive root rm" >&2; return 2 ;;
    esac
  fi

  if [ "$tool_name" = "Write" ] || [ "$tool_name" = "Edit" ]; then
    case "$file_path" in
      .env|.env.production|.env.prod*)
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
  check "deny: kubectl prod" \
    '{"tool_name":"Bash","tool_input":{"command":"kubectl --context=prod apply -f x.yaml"}}' 2
  check "deny: force push main" \
    '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' 2
  check "deny: write .env.production" \
    '{"tool_name":"Write","tool_input":{"file_path":".env.production","content":"x"}}' 2
  check "deny: postgres-prod mcp" \
    '{"tool_name":"mcp__postgres-prod__query","tool_input":{"sql":"select 1"}}' 2

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
