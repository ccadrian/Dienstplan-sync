# Dienstplan Sync

Foto vom Dienstplan machen, Termine sind im Google Kalender. Keine `.ics`-Datei, kein Export, keine Bestätigung.

```
Handy (PWA, Firebase Hosting)            Firebase Cloud Function "api" (europe-west3)
┌──────────────────────┐   JPEG    ┌─────────────────────────────────────────────┐
│ Foto aufnehmen       │ ────────▶ │ 1. Session prüfen (Allowlist)               │
│ verkleinern (≤2576px)│           │ 2. Google-Zugang prüfen (Refresh Token)     │
│ Ergebnis anzeigen    │ ◀──────── │ 3. Claude API: Bild → JSON (feste Struktur) │
└──────────────────────┘   JSON    │ 4. normalisieren (Endzeiten, [?], KW)       │
                                   │ 5. Kalender "Dienst": KW ersetzen           │
                                   └─────────────────────────────────────────────┘
                                        │ Firestore: Nutzer, verschlüsselter Token
```

## Was passiert genau?

- **Analyse:** Das Backend schickt das Foto an Claude (`claude-sonnet-5-5`) und erzwingt per Structured Output ein festes JSON-Schema. Pro Eintrag: Datum, Beginn, Ende, Titel, Ort, Verantwortlicher, Anzug, Hinweise, ganztägig, Sicherheit. Die Antwort wird zusätzlich tolerant geparst und geprüft.
- **Regeln:** Fehlt die Endzeit, gilt der Beginn des nächsten Eintrags am selben Tag (sonst +60 Min). Urlaub, Dienstfrei, Wache, GvD und UvD werden Ganztagstermine. Jahr und KW kommen aus dem Plan, sonst aus dem heutigen Datum. Dienste über Mitternacht enden am Folgetag.
- **Kalender:** Alle Termine landen im Kalender **„Dienst“**, der bei Bedarf automatisch angelegt wird (Zeitzone Europe/Berlin). Die Beschreibung enthält Verantwortlichen, Anzug und Hinweise. Erinnerung 30 Min vorher, bei Ganztagsterminen am Vorabend um 19:00.
- **Keine Duplikate:** Jeder Termin trägt `source=dienstplan-sync` und `week=2026-W41`. Lädst du einen neuen Plan für dieselbe KW hoch, werden zuerst die neuen Termine eingetragen und danach die alten dieser KW gelöscht. Scheitert das Eintragen, bleiben die alten Termine unverändert.
- **Unsicher erkannt:** Einträge mit `confidence=low` werden trotzdem eingetragen, der Titel beginnt dann mit `[?]`.

## Sicherheit

- Anthropic API Key, Google Client Secret und Session Secret liegen nur im Google Secret Manager, nicht im Frontend und nicht im Repo.
- Google-Berechtigung: nur `calendar.app.created`, also eigene Kalender anlegen und deren Termine verwalten. Deine anderen Kalender kann die App nicht sehen. Dazu kommen `openid email` für die Allowlist.
- Der Refresh Token liegt AES-256-GCM-verschlüsselt in Firestore. Direkter Zugriff auf Firestore aus dem Browser ist per Regeln komplett gesperrt.
- Nur E-Mail-Adressen aus `ALLOWED_EMAILS` können sich anmelden; die Liste wird bei jeder Anfrage geprüft.
- Login: Google leitet zur Function zurück, die PWA bekommt einen Einmal-Code (2 Min gültig) und tauscht ihn gegen ein signiertes Session-Token. „Abmelden“ macht alle Sessions ungültig.

## Automatische Einrichtung (empfohlen, ca. 10 Minuten)

Das Skript `scripts/setup.sh` erledigt alles: Projekt anlegen, Abrechnung verknüpfen, APIs, Firestore, Secrets, Deploy von Backend und App. Nur den Google-Login-Bildschirm musst du selbst anklicken, weil Google dafür keine Schnittstelle anbietet. Das Skript zeigt dir dafür die genauen Links und Werte.

Voraussetzungen: ein Rechnungskonto in Google Cloud (Kreditkarte) und ein [Anthropic API Key](https://console.anthropic.com/settings/keys).

1. <https://shell.cloud.google.com> öffnen. Du bist dort schon mit deinem Google-Konto angemeldet.
2. Repo holen (es ist privat, deshalb einmal bei GitHub anmelden):
   ```bash
   gh auth login        # GitHub.com → HTTPS → "Login with a web browser"
   gh repo clone ccadrian/Dienstplan-sync
   cd Dienstplan-sync
   bash scripts/setup.sh
   ```
3. Den Anweisungen folgen. Am Ende steht die Adresse der App, z.B. `https://dienstplan-sync-2cub5.web.app/`.

Das Skript kann jederzeit erneut gestartet werden, zum Beispiel nach einem Update. Vorhandenes wird übernommen.

Die PWA liegt dabei auf **Firebase Hosting** und nicht auf GitHub Pages. Pages funktioniert bei privaten Repos nur mit einem bezahlten GitHub-Plan. Firebase Hosting ist kostenlos und wird im selben Schritt deployt.

## Manuelle Einrichtung (Referenz, ca. 30 Minuten)

Du brauchst: ein Google-Konto, eine Kreditkarte für den Firebase Blaze Plan, einen Anthropic API Key und einen Rechner mit Node.js 22.

### 1. Firebase-Projekt (ist zugleich das Google-Cloud-Projekt)

1. <https://console.firebase.google.com> → **Projekt hinzufügen** → Name z.B. `dienstplan-sync`. Google Analytics brauchst du nicht.
2. Notiere die **Projekt-ID** (z.B. `dienstplan-sync-1a2b3`). Du brauchst sie unten mehrfach.
3. Links unten **Upgrade** → **Blaze** (nutzungsbasiert, nötig für Cloud Functions und Secrets). Setze dabei ein **Budget-Limit**, z.B. 5 €. Der normale Gebrauch liegt im kostenlosen Kontingent.
4. **Build → Firestore Database → Datenbank erstellen** → Standort `europe-west3 (Frankfurt)` → **Produktionsmodus**.

### 2. Google Calendar API aktivieren

<https://console.cloud.google.com> → oben dein Projekt auswählen → **APIs & Dienste → Bibliothek** → „Google Calendar API“ → **Aktivieren**.

### 3. OAuth-Zustimmungsbildschirm

In der Cloud Console: **APIs & Dienste → OAuth-Zustimmungsbildschirm**. Dieser Bereich heißt inzwischen auch **Google Auth Platform**.

1. **Branding:** App-Name `Dienstplan Sync`, deine E-Mail als Support- und Entwickler-Kontakt.
2. **Zielgruppe:** Nutzertyp **Extern**. Unter **Testnutzer** deine Gmail-Adresse hinzufügen.
3. **Datenzugriff → Bereiche hinzufügen:** `.../auth/calendar.app.created`, `openid`, `.../auth/userinfo.email`.

> ⚠️ **Wichtig, sonst musst du dich jede Woche neu anmelden:** Solange die App im Status „Test“ ist, lässt Google den Refresh Token nach **7 Tagen** ablaufen. Klicke deshalb unter **Zielgruppe → App veröffentlichen** (in Produktion). Eine Überprüfung durch Google ist dafür nicht nötig. Beim Login erscheint dann einmal „Google hat diese App nicht überprüft“ → **Erweitert → Weiter zu Dienstplan Sync**. Andere Personen können die App trotzdem nicht nutzen, das verhindert die Allowlist. Bleibst du im Testmodus, funktioniert alles, nur meldet die App nach 7 Tagen „bitte neu anmelden“.

### 4. OAuth-Client anlegen

**APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID** (bzw. **Clients → Client erstellen**):

- Anwendungstyp: **Webanwendung**, Name `Dienstplan Sync`
- **Autorisierte Weiterleitungs-URI:**
  `https://europe-west3-DEINE-PROJEKT-ID.cloudfunctions.net/api/auth/callback`
- Speichern und **Client-ID** und **Clientschlüssel** notieren.

### 5. Anthropic API Key

<https://console.anthropic.com> → **API Keys → Create Key**. Lade etwas Guthaben auf. Ein Foto kostet nur wenige Cent.

### 6. Backend einrichten und deployen

```bash
npm install -g firebase-tools
firebase login

git clone https://github.com/ccadrian/Dienstplan-sync.git
cd Dienstplan-sync
firebase use --add            # dein Projekt wählen, Alias: default

cd functions
npm ci
cp .env.example .env          # GOOGLE_CLIENT_ID, ALLOWED_EMAILS, APP_URL eintragen
```

Secrets setzen. Die CLI fragt jeweils nach dem Wert, der nicht im Terminalverlauf landet:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY      # sk-ant-...
firebase functions:secrets:set GOOGLE_CLIENT_SECRET   # Clientschlüssel aus Schritt 4
openssl rand -base64 48                               # Zufallswert erzeugen und kopieren
firebase functions:secrets:set SESSION_SECRET         # diesen Zufallswert einfügen
```

Deployen (aus dem Hauptordner):

```bash
cd ..
firebase deploy --only functions,firestore
```

Beim ersten Deploy aktiviert die CLI weitere Google-APIs (Cloud Build, Cloud Run, Artifact Registry, Secret Manager). Die Frage nach einer Cleanup-Policy für alte Container-Images beantwortest du mit **Ja**. Schlägt der allererste Deploy wegen fehlender Berechtigungen fehl, warte 2–3 Minuten und starte ihn erneut.

Am Ende steht die Function-URL: `https://europe-west3-DEINE-PROJEKT-ID.cloudfunctions.net/api`

### 7. PWA veröffentlichen

**Firebase Hosting (Standard):** `web/config.js` wie unten anpassen, `APP_URL=https://DEINE-PROJEKT-ID.web.app/` in `functions/.env` setzen und `firebase deploy --only hosting` ausführen.

**Alternativ GitHub Pages** (nur öffentliches Repo oder GitHub Pro):

1. In `web/config.js` `DEIN-PROJEKT` durch deine Projekt-ID ersetzen und auf `main` committen.
2. GitHub → Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Den Workflow „PWA auf GitHub Pages“ unter **Actions** manuell starten.
4. Die App liegt dann unter `https://ccadrian.github.io/Dienstplan-sync/`. Dieser Wert muss exakt als `APP_URL` in `functions/.env` stehen.

### 8. Auf dem Handy

1. App-Adresse öffnen.
   - **iPhone (Safari):** Teilen → **Zum Home-Bildschirm**.
   - **Android (Chrome):** Menü → **App installieren**.
2. Die App vom Homescreen starten und dort **anmelden**. Auf dem iPhone hat die installierte App einen eigenen Speicher, getrennt von Safari.
3. Foto aufnehmen, fertig.

## Anpassen

In `functions/.env` (danach `firebase deploy --only functions`):

| Variable | Zweck |
|---|---|
| `ALLOWED_EMAILS` | Erlaubte Google-Konten, kommagetrennt |
| `CLAUDE_MODEL` | Modell für die Bildanalyse, Standard `claude-sonnet-5-5` |
| `CLAUDE_EFFORT` | Denkaufwand `low`, `medium`, `high` (Standard), `xhigh`, `max`. Höher heißt genauer, aber langsamer. |
| `CLAUDE_HINT` | Zusatzhinweis, z.B. `Nur Einträge für den 2. Zug und die ganze Kompanie übernehmen.` |
| `CLAUDE_FALLBACK` | `off` schaltet den serverseitigen Fallback auf ein anderes Modell bei Ablehnungen ab |

Den Prompt selbst findest du in `functions/src/claude.ts` (`SYSTEM_PROMPT`).

**Analyse lokal testen** (ohne Kalender, ohne Deploy):

```bash
cd functions
npm run build
ANTHROPIC_API_KEY=sk-ant-... node scripts/try-analyze.mjs ../tests/fixtures/dienstplan.png
# oder mit einem eigenen Foto (max. 5 MB)
```

## Fehlerbehebung

| Meldung / Problem | Ursache und Lösung |
|---|---|
| „Die App ist noch nicht eingerichtet“ | `web/config.js` enthält noch `DEIN-PROJEKT`. |
| Google: `redirect_uri_mismatch` | Die Weiterleitungs-URI im OAuth-Client weicht ab. Sie muss exakt `https://europe-west3-<ID>.cloudfunctions.net/api/auth/callback` lauten. |
| „Dieses Google-Konto ist nicht freigeschaltet“ | E-Mail fehlt in `ALLOWED_EMAILS`, oder du bist im Testmodus nicht als Testnutzer eingetragen. |
| „Bitte erlaube … Zugriff auf den Kalender“ | Beim Login wurde das Kalender-Häkchen nicht gesetzt. Melde dich erneut an. |
| Jede Woche „bitte neu anmelden“ | Die App ist noch im Status „Test“, siehe Hinweis in Schritt 3. |
| Nach dem Google-Login „Keine Verbindung zum Server“ | Die Origin von `APP_URL` passt nicht zur Adresse der App, dadurch blockiert CORS. Logs: `firebase functions:log`. |
| „Das Backend ist nicht richtig eingerichtet“ | Ein Secret fehlt, oder `SESSION_SECRET` hat weniger als 32 Zeichen. |
| Falscher Kalender gefüllt? | Unmöglich: Die App sieht nur Kalender, die sie selbst angelegt hat. |

## Entwicklung

```
web/                  PWA (HTML/CSS/JS ohne Build), Service Worker, Manifest, Icons
functions/src/        Cloud Function (TypeScript)
  index.ts            Function "api", Secrets und Parameter
  app.ts              Routen: /auth/start, /auth/callback, /auth/exchange, /auth/logout, /me, /upload
  claude.ts           Prompt, JSON-Schema, Claude-Aufruf, Fehlerübersetzung
  roster.ts           robustes Parsen und Normalisieren der Einträge
  calendar.ts         Kalender "Dienst", Termine, KW ersetzen mit Rollback
  oauth.ts            Google OAuth (Login, Refresh Token)
  session.ts          Session-Token (HMAC), Verschlüsselung (AES-GCM)
  store.ts            Firestore
functions/test/       Unit- und Integrationstests (vitest)
tests/e2e/            Playwright-Tests der PWA gegen eine gemockte API
```

```bash
cd functions && npm test                 # Unit-Tests Backend
cd functions && npm run test:emulator    # gegen Firebase Emulator (Java nötig)
npm ci && npx playwright install chromium && npm run test:web   # PWA-Tests
npm run serve                            # PWA lokal auf http://localhost:8000
```

Alle Tests laufen auch automatisch in GitHub Actions (`.github/workflows/ci.yml`).
