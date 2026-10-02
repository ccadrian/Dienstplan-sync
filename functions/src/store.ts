import type { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";

export interface UserRecord {
  sub: string;
  email: string;
  refreshTokenEnc: string; // AES-GCM verschlüsselt (siehe session.ts)
  scope: string;
  calendarId: string | null;
  sessionVersion: number;
}

export interface LoginCode {
  sub: string;
  ver: number;
}

/** Persistenz für Login und Nutzerdaten. Firestore in Produktion, Speicher in Tests. */
export interface Store {
  getUser(sub: string): Promise<UserRecord | null>;
  /** Legt den Nutzer an oder aktualisiert Token/Scope. Liefert die aktuelle Sessionversion. */
  saveLogin(sub: string, data: { email: string; refreshTokenEnc: string; scope: string }): Promise<number>;
  setCalendarId(sub: string, calendarId: string | null): Promise<void>;
  bumpSessionVersion(sub: string): Promise<void>;
  createLoginCode(codeHash: string, data: LoginCode, ttlMs: number): Promise<void>;
  consumeLoginCode(codeHash: string): Promise<LoginCode | null>;
}

const USERS = "users";
const CODES = "loginCodes";

export class FirestoreStore implements Store {
  constructor(private readonly db: Firestore) {}

  async getUser(sub: string): Promise<UserRecord | null> {
    const snap = await this.db.collection(USERS).doc(sub).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    return {
      sub,
      email: d.email,
      refreshTokenEnc: d.refreshTokenEnc,
      scope: d.scope ?? "",
      calendarId: d.calendarId ?? null,
      sessionVersion: d.sessionVersion ?? 0,
    };
  }

  async saveLogin(sub: string, data: { email: string; refreshTokenEnc: string; scope: string }): Promise<number> {
    const ref = this.db.collection(USERS).doc(sub);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const version = snap.exists ? (snap.data()!.sessionVersion ?? 0) : 0;
      tx.set(ref, { ...data, sessionVersion: version, updatedAt: new Date() }, { merge: true });
      return version;
    });
  }

  async setCalendarId(sub: string, calendarId: string | null): Promise<void> {
    await this.db.collection(USERS).doc(sub).set({ calendarId, updatedAt: new Date() }, { merge: true });
  }

  async bumpSessionVersion(sub: string): Promise<void> {
    const ref = this.db.collection(USERS).doc(sub);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      tx.update(ref, { sessionVersion: (snap.data()!.sessionVersion ?? 0) + 1, updatedAt: new Date() });
    });
  }

  async createLoginCode(codeHash: string, data: LoginCode, ttlMs: number): Promise<void> {
    await this.db.collection(CODES).doc(codeHash).set({ ...data, expiresAt: new Date(Date.now() + ttlMs) });
  }

  async consumeLoginCode(codeHash: string): Promise<LoginCode | null> {
    const data = await this.consume(CODES, codeHash);
    return data ? { sub: data.sub, ver: data.ver } : null;
  }

  /** Liest und löscht ein Dokument atomar; abgelaufene zählen als nicht vorhanden. */
  private async consume(collection: string, id: string): Promise<DocumentData | null> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return null;
    const ref = this.db.collection(collection).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      tx.delete(ref);
      const data = snap.data()!;
      const expiresAt = (data.expiresAt as Timestamp | undefined)?.toMillis() ?? 0;
      return expiresAt > Date.now() ? data : null;
    });
  }
}

/** Einfache Implementierung im Speicher für Tests und lokale Entwicklung. */
export class MemoryStore implements Store {
  users = new Map<string, UserRecord>();
  private codes = new Map<string, LoginCode & { expiresAt: number }>();

  async getUser(sub: string) {
    const u = this.users.get(sub);
    return u ? { ...u } : null;
  }

  async saveLogin(sub: string, data: { email: string; refreshTokenEnc: string; scope: string }) {
    const prev = this.users.get(sub);
    const version = prev?.sessionVersion ?? 0;
    this.users.set(sub, { sub, calendarId: prev?.calendarId ?? null, ...data, sessionVersion: version });
    return version;
  }

  async setCalendarId(sub: string, calendarId: string | null) {
    const u = this.users.get(sub);
    if (u) u.calendarId = calendarId;
  }

  async bumpSessionVersion(sub: string) {
    const u = this.users.get(sub);
    if (u) u.sessionVersion++;
  }

  async createLoginCode(codeHash: string, data: LoginCode, ttlMs: number) {
    this.codes.set(codeHash, { ...data, expiresAt: Date.now() + ttlMs });
  }

  async consumeLoginCode(codeHash: string) {
    const c = this.codes.get(codeHash);
    this.codes.delete(codeHash);
    return c && c.expiresAt > Date.now() ? { sub: c.sub, ver: c.ver } : null;
  }
}
