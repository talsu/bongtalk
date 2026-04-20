#!/usr/bin/env bash
# Task-016-C-2: bootstrap the very first admin user on a fresh prod
# install. Required because the closed-beta signup gate blocks
# /auth/signup until an invite exists, and invites only exist once
# SOMEONE has a workspace — chicken-and-egg.
#
# Reads ADMIN_EMAIL + ADMIN_PASSWORD from stdin (NEVER env vars — a
# `docker inspect` on the api container would otherwise leak the
# password). For headless SSH sessions that can't run the interactive
# prompt, pass `--stdin` and pipe:
#
#   cat <<EOF | scripts/setup/init-admin.sh --stdin
#   admin@example.com
#   correct-horse-battery-staple
#   admin-username
#   EOF
#
# Idempotent: if a user with the given email already exists the
# script prints a reminder and exits 0.
#
# Runs by shelling into the live qufox-api container so it uses the
# same argon2 + JWT config as the actual service. No temp files.

set -euo pipefail

cd "$(dirname "$0")/../.."

STDIN_MODE=0
for arg in "$@"; do
  case "$arg" in
    --stdin) STDIN_MODE=1 ;;
    -h|--help)
      sed -n '1,30p' "$0" | tail -28
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[init-admin] %s\n' "$*"; }

# --- collect inputs ------------------------------------------------------
if [[ "$STDIN_MODE" -eq 1 ]] || [[ ! -t 0 ]]; then
  # Headless: read three lines from stdin.
  IFS= read -r EMAIL || { echo "[init-admin] missing email on stdin" >&2; exit 3; }
  IFS= read -rs PASSWORD || { echo "[init-admin] missing password on stdin" >&2; exit 3; }
  IFS= read -r USERNAME || { echo "[init-admin] missing username on stdin" >&2; exit 3; }
else
  read -rp "admin email: " EMAIL
  read -rsp "admin password (hidden): " PASSWORD
  echo
  read -rp "admin username (2-32 chars, alnum + . _ -): " USERNAME
fi

if [[ -z "$EMAIL" || -z "$PASSWORD" || -z "$USERNAME" ]]; then
  echo "[init-admin] email/password/username are all required" >&2
  exit 4
fi

# --- call the API via the container-local POST /auth/signup -------------
# We go through the same code path a real signup would hit. The guard
# short-circuits because we pass BETA_INVITE_REQUIRED=false for this
# single call — ADMIN bootstrap must not itself need an invite.
log "creating admin via qufox-api container"
if ! docker ps --format '{{.Names}}' | grep -q '^qufox-api$'; then
  echo "[init-admin] qufox-api container is not running — start the stack first" >&2
  exit 5
fi

RESP=$(docker exec -i \
  -e BETA_INVITE_REQUIRED=false \
  qufox-api \
  node -e "
    const http = require('http');
    const body = JSON.stringify({
      email: process.argv[1],
      password: process.argv[2],
      username: process.argv[3],
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(process.env.API_PORT ?? 3001),
      path: '/auth/signup',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        console.log(JSON.stringify({ status: res.statusCode, body: chunks }));
      });
    });
    req.on('error', (e) => { console.log(JSON.stringify({ err: e.message })); process.exit(0); });
    req.write(body); req.end();
  " "$EMAIL" "$PASSWORD" "$USERNAME" 2>/dev/null) || {
    echo "[init-admin] docker exec failed" >&2
    exit 6
  }

STATUS=$(echo "$RESP" | sed -n 's/.*"status":\([0-9]*\).*/\1/p')
case "$STATUS" in
  201)
    log "ok: admin user created for $EMAIL"
    log "next: sign in, create a workspace, then issue invites for the rest of the beta cohort"
    ;;
  409)
    # Either email or username taken — treat as idempotent success.
    log "user with email=$EMAIL already exists — nothing to do (idempotent)"
    ;;
  422)
    echo "[init-admin] validation failed — check password length (>= 8) and username shape" >&2
    echo "[init-admin] api response: $RESP" >&2
    exit 7
    ;;
  *)
    echo "[init-admin] unexpected response status=$STATUS" >&2
    echo "[init-admin] api response: $RESP" >&2
    exit 8
    ;;
esac
