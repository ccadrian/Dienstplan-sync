import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Aus SESSION_SECRET werden zwei unabhängige Schlüssel abgeleitet:
 * einer signiert die Session-Tokens der App, einer verschlüsselt den
 * Google Refresh Token in Firestore.
 */
export class Crypto {
  private readonly signKey: Buffer;
  private readonly encKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("SESSION_SECRET muss mindestens 32 Zeichen lang sein");
    const ikm = Buffer.from(secret, "utf8");
    this.signKey = Buffer.from(hkdfSync("sha256", ikm, "dienstplan-sync", "session-signing", 32));
    this.encKey = Buffer.from(hkdfSync("sha256", ikm, "dienstplan-sync", "refresh-token-encryption", 32));
  }

  sign(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = createHmac("sha256", this.signKey).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  verify<T>(token: string): T | null {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) return null;
    const expected = createHmac("sha256", this.signKey).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  /** null, wenn der Wert manipuliert ist oder mit einem anderen Secret verschlüsselt wurde. */
  decrypt(value: string): string | null {
    const [version, iv, tag, data] = value.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encKey, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

export interface SessionPayload {
  sub: string; // Google-Konto-ID
  ver: number; // Sessionversion des Nutzers (Abmelden erhöht sie)
  exp: number; // Ablauf in Sekunden seit 1970
}

export const SESSION_TTL_SECONDS = 365 * 24 * 3600;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
