/**
 * Fehler, die bis zur App durchgereicht werden. `code` wertet das Frontend aus,
 * `message` ist direkt für den Nutzer formuliert.
 */
export type ErrorCode =
  | "auth" // nicht (mehr) eingeloggt
  | "reauth" // Google-Zugang abgelaufen/widerrufen -> neu verbinden
  | "forbidden" // Konto nicht freigeschaltet
  | "bad_request"
  | "not_found"
  | "unreadable" // Foto nicht auswertbar
  | "analysis" // Claude API Fehler
  | "busy" // Claude API überlastet / Rate Limit
  | "calendar" // Google Calendar Fehler
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  auth: 401,
  reauth: 401,
  forbidden: 403,
  bad_request: 400,
  not_found: 404,
  unreadable: 422,
  analysis: 502,
  busy: 503,
  calendar: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const errors = {
  auth: () => new AppError("auth", "Bitte melde dich an."),
  reauth: (cause?: unknown) =>
    new AppError(
      "reauth",
      "Der Zugriff auf deinen Google Kalender ist abgelaufen. Bitte melde dich neu an.",
      { cause },
    ),
  forbidden: () =>
    new AppError("forbidden", "Dieses Google-Konto ist für die App nicht freigeschaltet."),
};
