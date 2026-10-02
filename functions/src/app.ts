import { randomBytes } from "node:crypto";
import { buildEvent, calendarWeekUrl, ensureCalendar, mapGoogleError, replaceWeek } from "./calendar.js";
import { detectImageType, type RosterAnalyzer } from "./claude.js";
import { berlinToday, weekdayShort } from "./dates.js";
import { AppError, errors } from "./errors.js";
import { CALENDAR_SCOPE, type GoogleOAuth } from "./oauth.js";
import { normalizeRoster } from "./roster.js";
import { Crypto, randomToken, SESSION_TTL_SECONDS, sha256, type SessionPayload } from "./session.js";
import type { Store, UserRecord } from "./store.js";

/** Teilmenge von Express Request/Response, die Firebase an onRequest übergibt. */
export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  set(field: string, value: string): HttpResponse;
  json(body: unknown): void;
  end(): void;
}

export interface AppConfig {
  appUrl: string; // PWA, z.B. https://name.github.io/Dienstplan-sync/
  allowedEmails: string[];
  allowLocalhost?: boolean; // nur im Emulator
}

export interface AppDeps {
  config: AppConfig;
  store: Store;
  crypto: Crypto;
  oauth: GoogleOAuth;
  analyze: RosterAnalyzer;
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

interface OAuthState {
  typ: "state"; // grenzt vom Session-Token ab (gleicher Signaturschlüssel)
  n: string; // Zufallswert
  exp: number; // Ablauf in Millisekunden
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Limit der Claude API pro Bild
const STATE_TTL_MS = 10 * 60_000;
const LOGIN_CODE_TTL_MS = 2 * 60_000;

export function parseAllowedEmails(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function createApp(deps: AppDeps) {
  const { config, store, crypto, oauth, analyze } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg, data) => console.log(msg, data ?? ""));
  const appOrigin = new URL(config.appUrl).origin;
  const allowed = new Set(config.allowedEmails.map((e) => e.toLowerCase()));

  const isAllowed = (email: string) => allowed.has(email.toLowerCase());

  function header(req: HttpRequest, name: string): string | undefined {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }

  function applyCors(req: HttpRequest, res: HttpResponse): void {
    const origin = header(req, "origin");
    if (!origin) return;
    const ok =
      origin === appOrigin ||
      (config.allowLocalhost === true && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    if (!ok) return;
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Max-Age", "3600");
  }

  function redirect(res: HttpResponse, url: string): void {
    res.status(302).set("Location", url).set("Cache-Control", "no-store").end();
  }

  function backToApp(res: HttpResponse, params: Record<string, string>): void {
    redirect(res, `${config.appUrl}#${new URLSearchParams(params)}`);
  }

  async function authenticate(req: HttpRequest): Promise<UserRecord> {
    const auth = header(req, "authorization") ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    if (!token) throw errors.auth();
    const session = crypto.verify<SessionPayload>(token);
    if (
      !session ||
      typeof session.sub !== "string" ||
      typeof session.exp !== "number" ||
      session.exp * 1000 < now().getTime()
    ) {
      throw errors.auth();
    }
    const user = await store.getUser(session.sub);
    if (!user || user.sessionVersion !== session.ver) throw errors.auth();
    if (!isAllowed(user.email)) throw errors.forbidden();
    return user;
  }

  // --- Login ----------------------------------------------------------------

  async function authStart(_req: HttpRequest, res: HttpResponse) {
    // Signierter State: belegt, dass der Login hier gestartet wurde, ohne Datenbank-Eintrag
    const state = crypto.sign({ typ: "state", n: randomToken(16), exp: now().getTime() + STATE_TTL_MS } satisfies OAuthState);
    redirect(res, oauth.authUrl(state, config.allowedEmails.length === 1 ? config.allowedEmails[0] : undefined));
  }

  function validState(state: string): boolean {
    const payload = state ? crypto.verify<OAuthState>(state) : null;
    return payload?.typ === "state" && typeof payload.exp === "number" && payload.exp > now().getTime();
  }

  async function authCallback(req: HttpRequest, res: HttpResponse) {
    const q = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : "");
    if (q("error")) return backToApp(res, { error: "denied" });
    if (!validState(q("state"))) return backToApp(res, { error: "state" });
    if (!q("code")) return backToApp(res, { error: "denied" });

    const identity = await oauth.exchangeCode(q("code"));
    if (!identity.emailVerified || !isAllowed(identity.email)) {
      log("Login abgelehnt (nicht freigeschaltet)", { email: identity.email });
      if (identity.refreshToken) await oauth.revoke(identity.refreshToken);
      return backToApp(res, { error: "forbidden" });
    }
    if (!identity.scope.split(" ").includes(CALENDAR_SCOPE)) {
      return backToApp(res, { error: "scope" });
    }

    let refreshTokenEnc: string;
    if (identity.refreshToken) {
      refreshTokenEnc = crypto.encrypt(identity.refreshToken);
    } else {
      const existing = await store.getUser(identity.sub);
      if (!existing?.refreshTokenEnc) return backToApp(res, { error: "server" });
      refreshTokenEnc = existing.refreshTokenEnc;
    }
    const ver = await store.saveLogin(identity.sub, {
      email: identity.email,
      refreshTokenEnc,
      scope: identity.scope,
    });
    const code = randomToken();
    await store.createLoginCode(sha256(code), { sub: identity.sub, ver }, LOGIN_CODE_TTL_MS);
    log("Login erfolgreich", { email: identity.email });
    backToApp(res, { code });
  }

  async function authExchange(req: HttpRequest, res: HttpResponse) {
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || !code) throw new AppError("bad_request", "Login-Code fehlt.");
    const login = await store.consumeLoginCode(sha256(code));
    if (!login) throw new AppError("auth", "Der Login ist abgelaufen. Bitte melde dich erneut an.");
    const user = await store.getUser(login.sub);
    if (!user || user.sessionVersion !== login.ver) throw errors.auth();
    if (!isAllowed(user.email)) throw errors.forbidden();
    const exp = Math.floor(now().getTime() / 1000) + SESSION_TTL_SECONDS;
    const token = crypto.sign({ sub: user.sub, ver: user.sessionVersion, exp } satisfies SessionPayload);
    res.status(200).json({ token, email: user.email });
  }

  async function authLogout(req: HttpRequest, res: HttpResponse) {
    const user = await authenticate(req).catch(() => null);
    if (user) await store.bumpSessionVersion(user.sub);
    res.status(204).end();
  }

  async function me(req: HttpRequest, res: HttpResponse) {
    const user = await authenticate(req);
    res.status(200).json({ email: user.email });
  }

  // --- Upload ---------------------------------------------------------------

  async function upload(req: HttpRequest, res: HttpResponse) {
    const user = await authenticate(req);

    const image = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : undefined);
    if (!image || image.length === 0) throw new AppError("bad_request", "Es wurde kein Foto übertragen.");
    if (image.length > MAX_IMAGE_BYTES) {
      throw new AppError("bad_request", "Das Foto ist zu groß (maximal 5 MB).");
    }
    const mediaType = detectImageType(image);
    if (!mediaType) {
      throw new AppError("bad_request", "Das Bildformat wird nicht unterstützt. Bitte JPEG oder PNG verwenden.");
    }

    // Erst den Google-Zugang prüfen, damit kein Foto umsonst analysiert wird
    const refreshToken = crypto.decrypt(user.refreshTokenEnc);
    if (!refreshToken) throw errors.reauth();
    const calendar = await oauth.calendarApi(refreshToken);

    const today = berlinToday(now());
    const started = Date.now();
    const raw = await analyze(image, mediaType, today);
    const roster = normalizeRoster(raw, today);
    log("Dienstplan analysiert", {
      ms: Date.now() - started,
      entries: roster.entries.length,
      skipped: roster.skipped,
      week: roster.weekKey,
      readable: roster.readable,
    });
    if (!roster.readable) {
      const reason = roster.problem ? ` (${roster.problem.replace(/\.$/, "")})` : "";
      throw new AppError(
        "unreadable",
        `Auf dem Foto konnte kein Dienstplan gelesen werden${reason}. Bitte fotografiere ihn gerade, scharf und gut beleuchtet.`,
      );
    }

    const uploadId = randomBytes(8).toString("hex");
    let result;
    try {
      const calendarId = await ensureCalendar(calendar, user.calendarId, (id) => store.setCalendarId(user.sub, id));
      const events = roster.entries.map((entry, index) =>
        buildEvent(entry, { weekKey: roster.weekKey, uploadId, index }),
      );
      result = await replaceWeek(calendar, calendarId, roster.weekKey, uploadId, events);
    } catch (err) {
      throw mapGoogleError(err);
    }

    const warnings: string[] = [];
    if (roster.skipped > 0) {
      const n = roster.skipped;
      warnings.push(`${n} ${n === 1 ? "Eintrag" : "Einträge"} ohne lesbares Datum übersprungen.`);
    }
    if (result.removeFailed > 0) {
      const n = result.removeFailed;
      warnings.push(
        n === 1
          ? "1 alter Termin dieser Woche konnte nicht gelöscht werden."
          : `${n} alte Termine dieser Woche konnten nicht gelöscht werden.`,
      );
    }
    const lowCount = roster.entries.filter((e) => e.lowConfidence).length;

    res.status(200).json({
      count: result.created,
      replaced: result.removed,
      year: roster.year,
      week: roster.week,
      weekKey: roster.weekKey,
      lowConfidence: lowCount,
      calendarUrl: calendarWeekUrl(roster.entries[0]!.date),
      warnings,
      entries: roster.entries.map((e) => ({
        date: e.date,
        weekday: weekdayShort(e.date),
        allDay: e.allDay,
        start: e.start ?? null,
        end: e.end ?? null,
        title: e.title,
        location: e.location,
        lowConfidence: e.lowConfidence,
      })),
    });
  }

  // --- Router ---------------------------------------------------------------

  type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void>;
  const routes: Record<string, Handler> = {
    "GET /auth/start": authStart,
    "GET /auth/callback": authCallback,
    "POST /auth/exchange": authExchange,
    "POST /auth/logout": authLogout,
    "GET /me": me,
    "POST /upload": upload,
  };
  const redirectRoutes = new Set(["GET /auth/start", "GET /auth/callback"]);

  return async function handle(req: HttpRequest, res: HttpResponse): Promise<void> {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    // Je nach Aufruf-URL kommt der Funktionsname mit im Pfad an
    const path = (req.path.replace(/^\/api(?=\/|$)/, "") || "/").replace(/\/+$/, "") || "/";
    const key = `${req.method} ${path}`;
    const route = routes[key];
    try {
      if (!route) throw new AppError("not_found", "Unbekannte Adresse.");
      await route(req, res);
    } catch (err) {
      const appErr =
        err instanceof AppError
          ? err
          : new AppError("internal", "Unerwarteter Fehler. Bitte versuche es erneut.", { cause: err });
      log(`Fehler bei ${key}: ${appErr.code}`, {
        message: appErr.message,
        cause: describeCause(appErr.cause),
      });
      if (redirectRoutes.has(key)) {
        backToApp(res, { error: "server" });
      } else {
        res.status(appErr.status).json({ error: appErr.code, message: appErr.message });
      }
    }
  };
}

function describeCause(cause: unknown): string | undefined {
  if (!cause) return undefined;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
