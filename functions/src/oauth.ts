import { OAuth2Client } from "google-auth-library";
import { createGoogleCalendarApi, mapGoogleError, type CalendarApi } from "./calendar.js";

/**
 * Minimale Berechtigung: Die App darf eigene Kalender anlegen und nur deren
 * Termine sehen und ändern. Andere Kalender bleiben unsichtbar.
 */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
export const SCOPES = ["openid", "email", CALENDAR_SCOPE];

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  refreshToken: string | null;
  scope: string;
}

export interface GoogleOAuth {
  authUrl(state: string, loginHint?: string): string;
  exchangeCode(code: string): Promise<GoogleIdentity>;
  /** Kalenderzugriff mit dem Refresh Token. Prüft ihn sofort (abgelaufen -> reauth). */
  calendarApi(refreshToken: string): Promise<CalendarApi>;
  revoke(token: string): Promise<void>;
}

export function createGoogleOAuth(opts: { clientId: string; clientSecret: string; redirectUri: string }): GoogleOAuth {
  const newClient = () =>
    new OAuth2Client({ clientId: opts.clientId, clientSecret: opts.clientSecret, redirectUri: opts.redirectUri });

  return {
    authUrl(state, loginHint) {
      return newClient().generateAuthUrl({
        access_type: "offline",
        prompt: "consent", // sorgt dafür, dass Google immer einen Refresh Token liefert
        scope: SCOPES,
        state,
        include_granted_scopes: false,
        ...(loginHint ? { login_hint: loginHint } : {}),
      });
    },

    async exchangeCode(code) {
      const client = newClient();
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) throw new Error("Google hat kein ID-Token geliefert");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: opts.clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error("ID-Token ohne Konto-Daten");
      return {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        emailVerified: payload.email_verified === true,
        refreshToken: tokens.refresh_token ?? null,
        scope: tokens.scope ?? "",
      };
    },

    async calendarApi(refreshToken) {
      const client = newClient();
      client.setCredentials({ refresh_token: refreshToken });
      try {
        await client.getAccessToken();
      } catch (err) {
        throw mapGoogleError(err);
      }
      return createGoogleCalendarApi(client);
    },

    async revoke(token) {
      await newClient()
        .revokeToken(token)
        .catch(() => undefined);
    },
  };
}
