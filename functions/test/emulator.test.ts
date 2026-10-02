/**
 * Integrationstests gegen den Firebase Emulator (Firestore + Functions).
 * Laufen nur, wenn der Emulator aktiv ist:  npm run test:emulator
 */
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crypto, sha256 } from "../src/session.js";
import { FirestoreStore } from "../src/store.js";

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-dienstplan";
const API = `http://127.0.0.1:5001/${PROJECT}/europe-west3/api`;
// muss zu functions/.secret.local passen (siehe scripts/emulator-test.sh)
const SESSION_SECRET = "emulator-session-secret-0123456789abcdef";

describe.skipIf(!enabled)("Firebase Emulator", () => {
  let app: App;
  let store: FirestoreStore;

  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, "emulator-test");
    store = new FirestoreStore(getFirestore(app));
  });
  afterAll(async () => {
    await deleteApp(app);
  });

  describe("FirestoreStore", () => {
    it("speichert Logins und behält Kalender-ID und Sessionversion", async () => {
      const sub = `user-${Date.now()}`;
      expect(await store.saveLogin(sub, { email: "a@b.de", refreshTokenEnc: "enc1", scope: "s" })).toBe(0);
      await store.setCalendarId(sub, "cal-1");
      await store.bumpSessionVersion(sub);
      expect(await store.saveLogin(sub, { email: "a@b.de", refreshTokenEnc: "enc2", scope: "s" })).toBe(1);
      expect(await store.getUser(sub)).toEqual({
        sub,
        email: "a@b.de",
        refreshTokenEnc: "enc2",
        scope: "s",
        calendarId: "cal-1",
        sessionVersion: 1,
      });
      expect(await store.getUser("gibts-nicht")).toBeNull();
    });

    it("verbraucht Login-Codes genau einmal und beachtet den Ablauf", async () => {
      const code = sha256(`code-${Date.now()}`);
      await store.createLoginCode(code, { sub: "u", ver: 3 }, 60_000);
      expect(await store.consumeLoginCode(code)).toEqual({ sub: "u", ver: 3 });
      expect(await store.consumeLoginCode(code)).toBeNull();

      const expired = sha256(`expired-${Date.now()}`);
      await store.createLoginCode(expired, { sub: "u", ver: 0 }, -1);
      expect(await store.consumeLoginCode(expired)).toBeNull();
      expect(await store.consumeLoginCode("ungültig/id")).toBeNull();
    });
  });

  describe("Function 'api'", () => {
    it("leitet zum Google Login mit minimalen Scopes weiter", async () => {
      const res = await fetch(`${API}/auth/start`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("location")!);
      expect(url.host).toBe("accounts.google.com");
      expect(url.searchParams.get("scope")).toBe(
        "openid email https://www.googleapis.com/auth/calendar.app.created",
      );
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("redirect_uri")).toBe(`${API}/auth/callback`);
      expect(url.searchParams.get("login_hint")).toBe("test@example.com");
    });

    it("leitet bei ungültigem State mit Fehler zurück zur App", async () => {
      const res = await fetch(`${API}/auth/callback?code=x&state=${"y".repeat(43)}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:8000/#error=state");
    });

    it("beantwortet CORS-Preflights der App und verlangt Anmeldung", async () => {
      const pre = await fetch(`${API}/upload`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:8000", "Access-Control-Request-Method": "POST" },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:8000");

      const me = await fetch(`${API}/me`);
      expect(me.status).toBe(401);
      expect(await me.json()).toMatchObject({ error: "auth" });
    });

    it("akzeptiert ein gültiges Session-Token eines gespeicherten Nutzers", async () => {
      const crypto = new Crypto(SESSION_SECRET);
      const sub = `session-${Date.now()}`;
      await store.saveLogin(sub, {
        email: "test@example.com",
        refreshTokenEnc: crypto.encrypt("1//fake"),
        scope: "s",
      });
      const token = crypto.sign({ sub, ver: 0, exp: Math.floor(Date.now() / 1000) + 60 });
      const me = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } });
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ email: "test@example.com" });

      // Upload ohne Bild -> verständlicher Fehler, Rohdaten kommen an
      const empty = await fetch(`${API}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" },
        body: new Uint8Array(0),
      });
      expect(empty.status).toBe(400);
      const pdf = await fetch(`${API}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" },
        body: new TextEncoder().encode("%PDF-1.7 kein Bild"),
      });
      expect(await pdf.json()).toMatchObject({ error: "bad_request", message: expect.stringContaining("Bildformat") });

      // Login-Code-Austausch über HTTP (JSON-Body)
      const ex = await fetch(`${API}/auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "unbekannt" }),
      });
      expect(ex.status).toBe(401);
    });
  });
});
