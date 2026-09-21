#!/usr/bin/env bash
# Read-only helper. Prints the SRI hashes for the pinned mind-map scripts and (optionally)
# checks that a URL is fronted by Cloudflare Access. Changes nothing. Usage:
#   site/scripts/verify.sh [https://your-site.pages.dev]
set -euo pipefail

urls=(
  "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"
  "https://cdn.jsdelivr.net/npm/markmap-lib@0.18.12/dist/browser/index.iife.min.js"
  "https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js"
)
for u in "${urls[@]}"; do
  h=$(curl -fsSL "$u" | openssl dgst -sha384 -binary | openssl base64 -A)
  echo "sha384-$h  $u"
done

if [ "${1:-}" != "" ]; then
  echo "--- Access check for $1 (expect a redirect to *.cloudflareaccess.com) ---"
  curl -sSI -o /dev/null -w 'status=%{http_code} location=%{redirect_url}\n' "$1"
fi
