#!/usr/bin/env bash
set -euo pipefail

if ! command -v railway >/dev/null 2>&1; then
  echo "Railway CLI is not installed. Install/login to Railway, then run this script again."
  exit 1
fi

if ! railway status >/dev/null 2>&1; then
  echo "Railway is not authenticated or no project is linked. Run 'railway login' and 'railway link' first."
  exit 1
fi

backend_key="${BUILDER_BACKEND_API_KEY:-${SESSION_SECRET:-}}"
source_token="${BUILDER_GITHUB_SOURCE_TOKEN:-}"
target_token="${BUILDER_GITHUB_TARGET_TOKEN:-}"
vercel_token="${BUILDER_VERCEL_TOKEN:-}"

for pair in \
  "BUILDER_BACKEND_API_KEY:${backend_key}" \
  "BUILDER_GITHUB_SOURCE_TOKEN:${source_token}" \
  "BUILDER_GITHUB_TARGET_TOKEN:${target_token}" \
  "BUILDER_VERCEL_TOKEN:${vercel_token}"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [ -z "$value" ]; then
    echo "$name is missing from the shell environment."
    exit 1
  fi
  railway variables set "$name=$value" >/dev/null
done

railway variables set \
  BUILDER_SOURCE_REPO="${BUILDER_SOURCE_REPO:-instaboosterwesd/rgxpanel.in}" \
  BUILDER_SOURCE_BRANCH="${BUILDER_SOURCE_BRANCH:-main}" \
  BUILDER_BACKEND_REPO="${BUILDER_BACKEND_REPO:-reversebypass7830-bot/telegram-builder-bot-backend}" \
  BUILDER_BACKEND_DISCOVERY_FILE="${BUILDER_BACKEND_DISCOVERY_FILE:-backend-endpoint.json}" >/dev/null

railway up --detach