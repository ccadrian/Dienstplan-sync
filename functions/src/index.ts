import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { createApp, parseAllowedEmails } from "./app.js";
import { createClaudeAnalyzer, parseEffort } from "./claude.js";
import { createGoogleOAuth } from "./oauth.js";
import { Crypto } from "./session.js";
import { FirestoreStore } from "./store.js";

export const REGION = "europe-west3"; // Frankfurt

// Geheimnisse: nur im Google Secret Manager (firebase functions:secrets:set ...)
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const GOOGLE_CLIENT_SECRET = defineSecret("GOOGLE_CLIENT_SECRET");
const SESSION_SECRET = defineSecret("SESSION_SECRET");

// Konfiguration: functions/.env (wird beim ersten Deploy abgefragt)
const GOOGLE_CLIENT_ID = defineString("GOOGLE_CLIENT_ID", {
  description: "OAuth Client ID aus der Google Cloud Console",
});
const ALLOWED_EMAILS = defineString("ALLOWED_EMAILS", {
  description: "Google-Konten, die die App nutzen dürfen (kommagetrennt)",
});
const APP_URL = defineString("APP_URL", {
  description: "Adresse der PWA, z.B. https://name.github.io/Dienstplan-sync/",
});

/** Öffentliche Basis-URL dieser Function (für die OAuth Redirect URI). */
function apiBaseUrl(): string {
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL.replace(/\/+$/, "");
  const project = process.env.GCLOUD_PROJECT;
  if (process.env.FUNCTIONS_EMULATOR === "true") return `http://127.0.0.1:5001/${project}/${REGION}/api`;
  return `https://${REGION}-${project}.cloudfunctions.net/api`;
}

let handler: ReturnType<typeof createApp> | undefined;

function getHandler(): ReturnType<typeof createApp> {
  if (handler) return handler;
  if (getApps().length === 0) initializeApp();
  const appUrl = APP_URL.value().trim();
  handler = createApp({
    config: {
      appUrl: appUrl.endsWith("/") ? appUrl : `${appUrl}/`,
      allowedEmails: parseAllowedEmails(ALLOWED_EMAILS.value()),
      allowLocalhost: process.env.FUNCTIONS_EMULATOR === "true",
    },
    store: new FirestoreStore(getFirestore()),
    crypto: new Crypto(SESSION_SECRET.value()),
    oauth: createGoogleOAuth({
      clientId: GOOGLE_CLIENT_ID.value().trim(),
      clientSecret: GOOGLE_CLIENT_SECRET.value().trim(),
      redirectUri: `${apiBaseUrl()}/auth/callback`,
    }),
    analyze: createClaudeAnalyzer({
      apiKey: ANTHROPIC_API_KEY.value().trim(),
      model: process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5-5",
      effort: parseEffort(process.env.CLAUDE_EFFORT),
      hint: process.env.CLAUDE_HINT,
      fallback: process.env.CLAUDE_FALLBACK !== "off",
    }),
    log: (message, data) => logger.info(message, data ?? {}),
  });
  return handler;
}

export const api = onRequest(
  {
    region: REGION,
    timeoutSeconds: 540, // Bildanalyse dauert meist unter 1 Minute, Puffer für Wiederholungen
    memory: "512MiB",
    maxInstances: 2,
    invoker: "public", // Zugriffsschutz erfolgt in der App (Session + Allowlist)
    secrets: [ANTHROPIC_API_KEY, GOOGLE_CLIENT_SECRET, SESSION_SECRET],
  },
  async (req, res) => {
    let handle: ReturnType<typeof createApp>;
    try {
      handle = getHandler();
    } catch (err) {
      // z.B. fehlendes/zu kurzes Secret oder ungültige APP_URL
      logger.error("Konfiguration fehlerhaft", err);
      const origin = req.get("origin");
      if (origin) res.set("Access-Control-Allow-Origin", origin);
      res.status(500).json({
        error: "internal",
        message: "Das Backend ist nicht richtig eingerichtet. Details stehen in den Function-Logs.",
      });
      return;
    }
    await handle(req, res);
  },
);
