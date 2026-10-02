#!/usr/bin/env bash
# Richtet Dienstplan Sync komplett ein: Google-Cloud-/Firebase-Projekt, Billing,
# APIs, Firestore, Secrets, Backend und PWA (Firebase Hosting).
#
# Gedacht für die Google Cloud Shell (https://shell.cloud.google.com), dort bist
# du bereits angemeldet. Mehrfaches Ausführen ist unbedenklich: Vorhandenes wird
# übernommen.
#
#   bash scripts/setup.sh
#   PROJECT_ID=mein-projekt bash scripts/setup.sh   # eigene Projekt-ID
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGION="europe-west3"
PROJECT_ID="${PROJECT_ID:-dienstplan-sync-2cub5}"
SCOPE_CAL="https://www.googleapis.com/auth/calendar.app.created"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

# Fragt einen Wert ab. $1 Variablenname, $2 Text, $3 Vorgabe (optional), $4 "secret" für verdeckte Eingabe
ask() {
  local __var="$1" __text="$2" __default="${3:-}" __mode="${4:-}" __value=""
  local __hint=""
  [ -n "$__default" ] && __hint=" [$( [ "$__mode" = secret ] && echo "Enter = beibehalten" || echo "$__default")]"
  while :; do
    if [ "$__mode" = secret ]; then
      read -r -s -p "  $__text$__hint: " __value; echo
    else
      read -r -p "  $__text$__hint: " __value
    fi
    __value="${__value:-$__default}"
    [ -n "$__value" ] && break
    info "Bitte einen Wert eingeben."
  done
  printf -v "$__var" '%s' "$__value"
}

secret_exists() { gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; }

set_secret() {
  secret_exists "$1" || gcloud secrets create "$1" --replication-policy=automatic --project "$PROJECT_ID" >/dev/null
  printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT_ID" >/dev/null
  info "Secret $1 gespeichert."
}

env_value() { [ -f functions/.env ] && sed -n "s/^$1=//p" functions/.env | tail -n1 || true; }

# --- 0. Werkzeuge ------------------------------------------------------------
bold "0/7 Werkzeuge prüfen"
command -v gcloud >/dev/null || fail "gcloud fehlt. Bitte in der Google Cloud Shell ausführen."
command -v node >/dev/null || fail "Node.js fehlt (Version 20 oder neuer)."
command -v openssl >/dev/null || fail "openssl fehlt."
if command -v firebase >/dev/null; then FIREBASE=(firebase); else FIREBASE=(npx --yes firebase-tools@latest); fi
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[ -n "$ACCOUNT" ] || fail "Nicht bei gcloud angemeldet. Bitte 'gcloud auth login' ausführen."
info "Angemeldet als $ACCOUNT, Projekt-ID $PROJECT_ID"
if ! "${FIREBASE[@]}" projects:list >/dev/null 2>&1; then
  info "Firebase CLI braucht einmalig eine Anmeldung:"
  "${FIREBASE[@]}" login --no-localhost
fi

# --- 1. Projekt und Billing ----------------------------------------------------
bold "1/7 Google-Cloud-Projekt"
if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  info "Projekt existiert bereits."
else
  gcloud projects create "$PROJECT_ID" --name="Dienstplan Sync" ||
    fail "Projekt konnte nicht angelegt werden. Ist die ID vergeben? Dann: PROJECT_ID=dienstplan-sync-$RANDOM bash scripts/setup.sh"
fi
gcloud config set project "$PROJECT_ID" >/dev/null 2>&1

if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" = "True" ]; then
  info "Abrechnung ist aktiv."
else
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter='open=true' --format='value(name.basename(),displayName)')
  if [ "${#ACCOUNTS[@]}" -eq 0 ]; then
    fail "Kein Rechnungskonto gefunden. Lege eins an (https://console.cloud.google.com/billing/create) und starte das Skript erneut."
  elif [ "${#ACCOUNTS[@]}" -eq 1 ]; then
    BILLING="${ACCOUNTS[0]%%$'\t'*}"
  else
    info "Welches Rechnungskonto soll genutzt werden?"
    for i in "${!ACCOUNTS[@]}"; do info "  $((i + 1))) ${ACCOUNTS[$i]//$'\t'/  }"; done
    ask CHOICE "Nummer" "1"
    BILLING="${ACCOUNTS[$((CHOICE - 1))]%%$'\t'*}"
  fi
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING" >/dev/null
  info "Rechnungskonto $BILLING verknüpft. Tipp: Budget-Limit setzen unter https://console.cloud.google.com/billing/$BILLING/budgets"
fi

# --- 2. APIs, Firebase, Firestore ---------------------------------------------
bold "2/7 APIs, Firebase und Firestore (dauert 1-2 Minuten)"
gcloud services enable \
  firebase.googleapis.com calendar-json.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com run.googleapis.com eventarc.googleapis.com \
  firebasehosting.googleapis.com --project "$PROJECT_ID"
if "${FIREBASE[@]}" projects:list 2>/dev/null | grep -q "$PROJECT_ID"; then
  info "Firebase ist bereits aktiv."
else
  "${FIREBASE[@]}" projects:addfirebase "$PROJECT_ID"
fi
if gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" >/dev/null 2>&1; then
  info "Firestore existiert bereits."
else
  gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native --project "$PROJECT_ID" >/dev/null
  info "Firestore in $REGION angelegt."
fi

APP_URL="https://$PROJECT_ID.web.app/"
API_URL="https://$REGION-$PROJECT_ID.cloudfunctions.net/api"
REDIRECT_URI="$API_URL/auth/callback"

# --- 3. Google Login (muss in der Console geklickt werden) ----------------------
bold "3/7 Google-Login einrichten (einziger manueller Schritt, ca. 3 Minuten)"
CLIENT_ID="$(env_value GOOGLE_CLIENT_ID)"
case "$CLIENT_ID" in *.apps.googleusercontent.com) ;; *) CLIENT_ID="" ;; esac
if [ -n "$CLIENT_ID" ] && secret_exists GOOGLE_CLIENT_SECRET; then
  info "OAuth-Client ist bereits hinterlegt ($CLIENT_ID)."
  ask KEEP "Beibehalten? (j/n)" "j"
  [ "$KEEP" = "j" ] || CLIENT_ID=""
fi
if [ -z "$CLIENT_ID" ]; then
  cat <<EOT

  Google erlaubt diese Schritte nicht per Skript. Öffne die Links nacheinander:

  a) https://console.cloud.google.com/auth/overview?project=$PROJECT_ID
     "Jetzt starten": App-Name "Dienstplan Sync", deine E-Mail, Zielgruppe "Extern",
     Kontakt-E-Mail, Richtlinie akzeptieren, "Erstellen".

  b) https://console.cloud.google.com/auth/scopes?project=$PROJECT_ID
     "Bereiche hinzufügen" → unten bei "Bereiche manuell hinzufügen" einfügen:
       $SCOPE_CAL
     "Zur Tabelle hinzufügen" → "Aktualisieren" → "Speichern".

  c) https://console.cloud.google.com/auth/audience?project=$PROJECT_ID
     "App veröffentlichen" → "Bestätigen".
     (Sonst läuft dein Zugang alle 7 Tage ab. Eine Überprüfung durch Google
      ist nicht nötig; beim Login einmal "Erweitert → Weiter" klicken.)

  d) https://console.cloud.google.com/auth/clients/create?project=$PROJECT_ID
     Anwendungstyp "Webanwendung", Name "Dienstplan Sync".
     "Autorisierte Weiterleitungs-URIs" → "URI hinzufügen":
       $REDIRECT_URI
     "Erstellen" → Client-ID und Clientschlüssel kopieren.

EOT
  while :; do
    ask CLIENT_ID "Client-ID"
    case "$CLIENT_ID" in *.apps.googleusercontent.com) break ;; esac
    info "Die Client-ID endet auf .apps.googleusercontent.com"
  done
  ask CLIENT_SECRET "Clientschlüssel (Eingabe unsichtbar)" "" secret
  set_secret GOOGLE_CLIENT_SECRET "$CLIENT_SECRET"
fi

# --- 4. Claude API Key, Allowlist, Session Secret --------------------------------
bold "4/7 Claude API Key und Zugriff"
if secret_exists ANTHROPIC_API_KEY; then
  ask ANTHROPIC_KEY "Anthropic API Key (Eingabe unsichtbar)" "keep" secret
else
  info "API Key erstellen: https://console.anthropic.com/settings/keys"
  ask ANTHROPIC_KEY "Anthropic API Key (Eingabe unsichtbar)" "" secret
fi
[ "$ANTHROPIC_KEY" = keep ] || set_secret ANTHROPIC_API_KEY "$ANTHROPIC_KEY"

secret_exists SESSION_SECRET || set_secret SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"

DEFAULT_EMAILS="$(env_value ALLOWED_EMAILS)"
ask ALLOWED_EMAILS "Erlaubte Google-Konten (kommagetrennt)" "${DEFAULT_EMAILS:-$ACCOUNT}"

# --- 5. Konfiguration schreiben -------------------------------------------------
bold "5/7 Konfiguration schreiben"
cat > functions/.env <<EOT
GOOGLE_CLIENT_ID=$CLIENT_ID
ALLOWED_EMAILS=$ALLOWED_EMAILS
APP_URL=$APP_URL
CLAUDE_MODEL=$(env_value CLAUDE_MODEL | grep . || echo claude-sonnet-5-5)
CLAUDE_EFFORT=$(env_value CLAUDE_EFFORT | grep . || echo high)
EOT
cat > web/config.js <<EOT
// Adresse der Firebase Function "api" (geschrieben von scripts/setup.sh).
export const API_BASE = "$API_URL";
EOT
printf '{\n  "projects": {\n    "default": "%s"\n  }\n}\n' "$PROJECT_ID" > .firebaserc
info "functions/.env, web/config.js und .firebaserc geschrieben."

# --- 6. Deploy ----------------------------------------------------------------
bold "6/7 Deploy von Backend und App (beim ersten Mal 3-5 Minuten)"
npm --prefix functions ci --no-audit --no-fund
for attempt in 1 2 3; do
  if "${FIREBASE[@]}" deploy --only functions,firestore,hosting --project "$PROJECT_ID" --non-interactive --force; then
    break
  fi
  [ "$attempt" -lt 3 ] || fail "Deploy fehlgeschlagen. Details stehen oben. Das Skript kann einfach erneut gestartet werden."
  info "Neue Projekte brauchen manchmal etwas, bis alle Berechtigungen greifen. Neuer Versuch in 60 Sekunden …"
  sleep 60
done

# --- 7. Prüfen ----------------------------------------------------------------
bold "7/7 Prüfen"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/me" || true)"
if [ "$STATUS" = "401" ]; then
  info "Backend antwortet korrekt."
else
  info "Backend antwortet mit HTTP $STATUS (erwartet 401). Logs: firebase functions:log --project $PROJECT_ID"
fi

bold "Fertig!"
cat <<EOT
  Öffne auf dem Handy:  $APP_URL
  → zum Home-Bildschirm hinzufügen, dort mit Google anmelden, Foto aufnehmen.

  Beim ersten Login zeigt Google "Diese App wurde nicht überprüft":
  "Erweitert" → "Weiter zu Dienstplan Sync" und den Kalender-Haken setzen.
EOT
