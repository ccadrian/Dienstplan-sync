#!/usr/bin/env bash
# Startet Firestore- und Functions-Emulator mit Testwerten und führt die Tests aus.
# Voraussetzung: Firebase CLI (npm i -g firebase-tools) und Java.
set -euo pipefail
cd "$(dirname "$0")/.."

cat > .env.demo-dienstplan <<'ENV'
GOOGLE_CLIENT_ID=emulator-client-id.apps.googleusercontent.com
ALLOWED_EMAILS=test@example.com
APP_URL=http://localhost:8000/
ENV
cat > .secret.local <<'ENV'
ANTHROPIC_API_KEY=emulator-dummy
GOOGLE_CLIENT_SECRET=emulator-dummy
SESSION_SECRET=emulator-session-secret-0123456789abcdef
ENV
cleanup() { rm -f .env.demo-dienstplan .secret.local ../firestore-debug.log; }
trap cleanup EXIT INT TERM PIPE

npm run build
cd ..
firebase emulators:exec --project demo-dienstplan --only functions,firestore \
  "npm --prefix functions test -- test/emulator.test.ts"
