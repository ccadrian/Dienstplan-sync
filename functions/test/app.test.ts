import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type HttpRequest, MAX_IMAGE_BYTES } from "../src/app.js";
import type { RosterAnalyzer } from "../src/claude.js";
import { AppError, errors } from "../src/errors.js";
import { CALENDAR_SCOPE, type GoogleIdentity, type GoogleOAuth } from "../src/oauth.js";
import { Crypto } from "../src/session.js";
import { MemoryStore } from "../src/store.js";
import { FakeCalendar } from "./helpers/fakeCalendar.js";

const APP_URL = "https://ccadrian.github.io/Dienstplan-sync/";
const ORIGIN = "https://ccadrian.github.io";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

class FakeRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: any;
  ended = false;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  set(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
    return this;
  }
  json(b: unknown) {
    this.body = b;
    this.ended = true;
  }
  end() {
    this.ended = true;
  }
  /** Parameter aus dem Fragment der Weiterleitung zur App */
  get fragment(): Record<string, string> {
    const loc = this.headers.location ?? "";
    return Object.fromEntries(new URLSearchParams(loc.split("#")[1] ?? ""));
  }
}

function plan(entries: object[], extra: object = {}) {
  return { readable: true, problem: "", plan_year: 2026, plan_week: 41, entries, ...extra };
}
const entry = (o: object = {}) => ({
  date: "2026-10-05",
  start: "07:30",
  end: "",
  title: "Antreten",
  location: "",
  responsible: "Hptm Müller",
  uniform: "Feldanzug",
  notes: "",
  all_day: false,
  confidence: "high",
  ...o,
});

describe("App", () => {
  let store: MemoryStore;
  let calendar: FakeCalendar;
  let crypto: Crypto;
  let identity: GoogleIdentity;
  let analyzerResult: unknown;
  let analyzerCalls: number;
  let calendarError: AppError | null;
  let revoked: string[];
  let logs: string[];
  let handle: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new MemoryStore();
    calendar = new FakeCalendar();
    crypto = new Crypto("s".repeat(48));
    identity = {
      sub: "google-123",
      email: "adrian@example.com",
      emailVerified: true,
      refreshToken: "1//refresh",
      scope: `openid ${CALENDAR_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    };
    analyzerResult = plan([entry(), entry({ start: "08:00", end: "12:00", title: "Ausbildung" })]);
    analyzerCalls = 0;
    calendarError = null;
    revoked = [];
    logs = [];
    const oauth: GoogleOAuth = {
      authUrl: (state, hint) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&login_hint=${hint}`,
      exchangeCode: async (code) => {
        if (code !== "good-code") throw new Error("invalid code");
        return identity;
      },
      calendarApi: async (refreshToken) => {
        if (calendarError) throw calendarError;
        expect(refreshToken).toBe("1//refresh");
        return calendar;
      },
      revoke: async (t) => void revoked.push(t),
    };
    const analyze: RosterAnalyzer = async () => {
      analyzerCalls++;
      return analyzerResult;
    };
    handle = createApp({
      config: { appUrl: APP_URL, allowedEmails: ["adrian@example.com"] },
      store,
      crypto,
      oauth,
      analyze,
      now: () => new Date("2026-10-02T10:00:00Z"),
      log: (m) => void logs.push(m),
    });
  });

  async function call(method: string, path: string, opts: Partial<HttpRequest> = {}) {
    const res = new FakeRes();
    await handle(
      {
        method,
        path,
        query: {},
        headers: { origin: ORIGIN, ...(opts.headers ?? {}) },
        ...opts,
      } as HttpRequest,
      res,
    );
    return res;
  }

  /** Kompletter Login wie im Browser; liefert das Session-Token. */
  async function login(): Promise<string> {
    const start = await call("GET", "/auth/start");
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const cb = await call("GET", "/auth/callback", { query: { code: "good-code", state } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location!.startsWith(`${APP_URL}#code=`)).toBe(true);
    const ex = await call("POST", "/auth/exchange", { body: { code: cb.fragment.code } });
    expect(ex.statusCode).toBe(200);
    expect(ex.body.email).toBe("adrian@example.com");
    return ex.body.token;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  describe("Login", () => {
    it("führt den kompletten OAuth-Ablauf durch und speichert den Refresh Token verschlüsselt", async () => {
      const token = await login();
      const user = store.users.get("google-123")!;
      expect(user.refreshTokenEnc).not.toContain("refresh");
      expect(crypto.decrypt(user.refreshTokenEnc)).toBe("1//refresh");
      const me = await call("GET", "/me", { headers: bearer(token) });
      expect(me.body).toEqual({ email: "adrian@example.com" });
    });

    it("schlägt das erlaubte Konto als login_hint vor", async () => {
      const start = await call("GET", "/auth/start");
      expect(start.headers.location).toContain("login_hint=adrian@example.com");
    });

    it("lehnt fremde Konten ab und widerruft deren Token", async () => {
      identity.email = "fremd@example.com";
      const start = await call("GET", "/auth/start");
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const cb = await call("GET", "/auth/callback", { query: { code: "good-code", state } });
      expect(cb.fragment).toEqual({ error: "forbidden" });
      expect(revoked).toEqual(["1//refresh"]);
      expect(store.users.size).toBe(0);
    });

    it("verlangt die Kalender-Berechtigung", async () => {
      identity.scope = "openid email";
      const start = await call("GET", "/auth/start");
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const cb = await call("GET", "/auth/callback", { query: { code: "good-code", state } });
      expect(cb.fragment).toEqual({ error: "scope" });
    });

    it("weist unbekannte oder doppelt benutzte States und Codes ab", async () => {
      const cb = await call("GET", "/auth/callback", { query: { code: "good-code", state: "x".repeat(43) } });
      expect(cb.fragment).toEqual({ error: "state" });

      const start = await call("GET", "/auth/start");
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const ok = await call("GET", "/auth/callback", { query: { code: "good-code", state } });
      const again = await call("GET", "/auth/callback", { query: { code: "good-code", state } });
      expect(again.fragment).toEqual({ error: "state" });

      await call("POST", "/auth/exchange", { body: { code: ok.fragment.code } });
      const reuse = await call("POST", "/auth/exchange", { body: { code: ok.fragment.code } });
      expect(reuse.statusCode).toBe(401);
    });

    it("leitet bei Abbruch durch den Nutzer und bei Serverfehlern zurück zur App", async () => {
      const denied = await call("GET", "/auth/callback", { query: { error: "access_denied" } });
      expect(denied.fragment).toEqual({ error: "denied" });

      const start = await call("GET", "/auth/start");
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const broken = await call("GET", "/auth/callback", { query: { code: "bad-code", state } });
      expect(broken.statusCode).toBe(302);
      expect(broken.fragment).toEqual({ error: "server" });
    });

    it("macht beim Abmelden alle Sessions ungültig", async () => {
      const token = await login();
      expect((await call("POST", "/auth/logout", { headers: bearer(token) })).statusCode).toBe(204);
      const me = await call("GET", "/me", { headers: bearer(token) });
      expect(me.statusCode).toBe(401);
      expect(me.body.error).toBe("auth");
    });

    it("weist fehlende, gefälschte und abgelaufene Tokens ab", async () => {
      expect((await call("GET", "/me")).statusCode).toBe(401);
      expect((await call("GET", "/me", { headers: bearer("abc.def") })).statusCode).toBe(401);
      await login();
      const expired = crypto.sign({ sub: "google-123", ver: 0, exp: 1000 });
      expect((await call("GET", "/me", { headers: bearer(expired) })).statusCode).toBe(401);
    });

    it("sperrt Konten, die aus der Allowlist entfernt wurden", async () => {
      const token = await login();
      store.users.get("google-123")!.email = "ex@example.com";
      const me = await call("GET", "/me", { headers: bearer(token) });
      expect(me.statusCode).toBe(403);
      expect(me.body.error).toBe("forbidden");
    });
  });

  describe("Upload", () => {
    it("analysiert das Foto und trägt die Termine in den Kalender 'Dienst' ein", async () => {
      const token = await login();
      const res = await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        count: 2,
        replaced: 0,
        weekKey: "2026-W41",
        week: 41,
        calendarUrl: "https://calendar.google.com/calendar/r/week/2026/10/5",
        warnings: [],
      });
      expect(res.body.entries[0]).toEqual({
        date: "2026-10-05",
        weekday: "Mo",
        allDay: false,
        start: "07:30",
        end: "08:00", // Ende = Beginn des nächsten Eintrags
        title: "Antreten",
        location: "",
        lowConfidence: false,
      });

      const calId = store.users.get("google-123")!.calendarId!;
      expect(calId).toMatch(/^dienst-/);
      const events = calendar.events(calId);
      expect(events).toHaveLength(2);
      expect(events[0]!.description).toBe("Verantwortlich: Hptm Müller\nAnzug: Feldanzug");
    });

    it("ersetzt beim zweiten Upload derselben KW die alten Termine", async () => {
      const token = await login();
      await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      analyzerResult = plan([entry({ title: "Geändert", end: "09:00" })]);
      const res = await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      expect(res.body).toMatchObject({ count: 1, replaced: 2 });
      const calId = store.users.get("google-123")!.calendarId!;
      expect(calendar.events(calId).map((e) => e.summary)).toEqual(["Geändert"]);
    });

    it("meldet unlesbare Fotos verständlich", async () => {
      const token = await login();
      analyzerResult = plan([], { readable: false, problem: "Das Bild ist unscharf." });
      const res = await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      expect(res.statusCode).toBe(422);
      expect(res.body.error).toBe("unreadable");
      expect(res.body.message).toContain("(Das Bild ist unscharf)");
      expect(store.users.get("google-123")!.calendarId).toBeNull();
    });

    it("prüft den Google-Zugang vor der Analyse (abgelaufen -> neu anmelden)", async () => {
      const token = await login();
      calendarError = errors.reauth();
      const res = await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe("reauth");
      expect(analyzerCalls).toBe(0);
    });

    it("verlangt bei nicht entschlüsselbarem Refresh Token eine neue Anmeldung", async () => {
      const token = await login();
      store.users.get("google-123")!.refreshTokenEnc = "v1.kaputt.kaputt.kaputt";
      const res = await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      expect(res.body.error).toBe("reauth");
    });

    it("gibt Analysefehler weiter", async () => {
      const token = await login();
      analyzerResult = Promise.reject(new AppError("busy", "überlastet"));
      const res = await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: "busy", message: "überlastet" });
    });

    it("prüft Größe und Format des Fotos", async () => {
      const token = await login();
      const empty = await call("POST", "/upload", { headers: bearer(token), rawBody: Buffer.alloc(0) });
      expect(empty.statusCode).toBe(400);
      const big = await call("POST", "/upload", {
        headers: bearer(token),
        rawBody: Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]),
      });
      expect(big.body.message).toContain("zu groß");
      const pdf = await call("POST", "/upload", { headers: bearer(token), rawBody: Buffer.from("%PDF-1.7") });
      expect(pdf.body.message).toContain("Bildformat");
    });

    it("verlangt eine Anmeldung", async () => {
      const res = await call("POST", "/upload", { rawBody: JPEG });
      expect(res.statusCode).toBe(401);
      expect(analyzerCalls).toBe(0);
    });

    it("meldet übersprungene Einträge und unsichere Termine", async () => {
      const token = await login();
      analyzerResult = plan([entry({ confidence: "low" }), entry({ date: "Montag?" })]);
      const res = await call("POST", "/upload", { headers: bearer(token), rawBody: JPEG });
      expect(res.body.lowConfidence).toBe(1);
      expect(res.body.entries[0].title).toBe("[?] Antreten");
      expect(res.body.warnings[0]).toContain("1 Eintrag");
    });
  });

  describe("HTTP", () => {
    it("setzt CORS nur für die App-Domain", async () => {
      const pre = await call("OPTIONS", "/upload");
      expect(pre.statusCode).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(pre.headers["access-control-allow-headers"]).toContain("Authorization");
      const evil = await call("OPTIONS", "/upload", { headers: { origin: "https://evil.example" } });
      expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("akzeptiert Pfade mit und ohne Funktionsnamen", async () => {
      expect((await call("GET", "/api/me")).statusCode).toBe(401);
      expect((await call("GET", "/me/")).statusCode).toBe(401);
      const unknown = await call("GET", "/gibtsnicht");
      expect(unknown.statusCode).toBe(404);
    });
  });
});
