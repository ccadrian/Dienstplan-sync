import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { createApp, parseAllowedEmails } from "./app.js";
import { createClaudeAnalyzer, type Effort } from "./claude.js";
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

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

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
  initializeApp();
  const effort = (process.env.CLAUDE_EFFORT ?? "high") as Effort;
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
      effort: EFFORTS.includes(effort) ? effort : "high",
      hint: process.env.CLAUDE_HINT,
    }),
    log: (message, data) => logger.info(message, data ?? {}),
  });
  return handler;
}

export const api = onRequest(
  {
    region: REGION,
    timeoutSeconds: 300, // Bildanalyse kann bis zu ~2 Minuten dauern
    memory: "512MiB",
    maxInstances: 2,
    invoker: "public", // Zugriffsschutz erfolgt in der App (Session + Allowlist)
    secrets: [ANTHROPIC_API_KEY, GOOGLE_CLIENT_SECRET, SESSION_SECRET],
  },
  async (req, res) => {
    await getHandler()(req, res);
  },
);
