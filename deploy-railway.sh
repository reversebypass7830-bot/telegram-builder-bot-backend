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

config_file="${BUILDER_CONFIG_FILE:-../config.txt}"
config_value() {
  if [ ! -f "$config_file" ]; then
    return 0
  fi
  node --input-type=module - "$config_file" "$1" <<'NODE'
import { readFileSync } from 'node:fs';
const [file, key] = process.argv.slice(2);
const text = readFileSync(file, 'utf8');
const line = text.split(/\r?\n/).find((item) => item.trim().startsWith(`${key}=`));
if (!line) process.exit(0);
let value = line.slice(line.indexOf('=') + 1).trim();
if (
  value.length >= 2 &&
  ((value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")))
) value = value.slice(1, -1);
process.stdout.write(value);
NODE
}

backend_key="${BUILDER_BACKEND_API_KEY:-${SESSION_SECRET:-$(config_value BUILDER_BACKEND_API_KEY)}}"
backend_key="${backend_key:-$(config_value Secret_key)}"
source_token="${BUILDER_GITHUB_SOURCE_TOKEN:-$(config_value BUILDER_GITHUB_SOURCE_TOKEN)}"
target_token="${BUILDER_GITHUB_TARGET_TOKEN:-$(config_value BUILDER_GITHUB_TARGET_TOKEN)}"
vercel_token="${BUILDER_VERCEL_TOKEN:-$(config_value BUILDER_VERCEL_TOKEN)}"

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