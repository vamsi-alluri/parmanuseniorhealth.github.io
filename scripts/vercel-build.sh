#!/bin/sh
# Vercel build for the dev deployment. Lives in a file rather than inline in vercel.json
# because Vercel caps buildCommand at 256 characters.
set -e

BASE="${DEV_BASE_URL:-$VERCEL_PROJECT_PRODUCTION_URL}"

if [ -z "$BASE" ]; then
  echo "ERROR: DEV_BASE_URL is empty."
  echo "Set it in Vercel > Settings > Environment Variables to the deployment host,"
  echo "with no protocol and no trailing slash, e.g. my-project.vercel.app"
  echo
  echo "Building without it produces a site with no CSS or JS: canonifyURLs makes every"
  echo "asset URL absolute against baseURL, and the CSP only allows 'self'."
  exit 1
fi

# -D so draft alerts appear in the dev feed; -e staging so the theme's robots.txt
# emits Disallow: / while keeping the production stylesheet path.
exec ./bin/hugo --gc --minify -D -e staging --baseURL "https://$BASE/"
