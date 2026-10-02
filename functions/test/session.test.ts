import { describe, expect, it } from "vitest";
import { Crypto, randomToken, sha256 } from "../src/session.js";

const SECRET = "x".repeat(48);

describe("Crypto", () => {
  it("verlangt ein ausreichend langes Secret", () => {
    expect(() => new Crypto("kurz")).toThrow();
  });

  it("signiert und prüft Tokens", () => {
    const c = new Crypto(SECRET);
    const token = c.sign({ sub: "1", ver: 0, exp: 123 });
    expect(c.verify(token)).toEqual({ sub: "1", ver: 0, exp: 123 });
  });

  it("weist manipulierte oder fremde Tokens ab", () => {
    const c = new Crypto(SECRET);
    const token = c.sign({ sub: "1", ver: 0, exp: 123 });
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "2", ver: 0, exp: 123 })).toString("base64url");
    expect(c.verify(`${forged}.${mac}`)).toBeNull();
    expect(c.verify(`${body}.${mac}x`)).toBeNull();
    expect(c.verify(`${body}`)).toBeNull();
    expect(c.verify(`${body}.${mac}.x`)).toBeNull();
    expect(new Crypto("y".repeat(48)).verify(token)).toBeNull();
  });

  it("verschlüsselt den Refresh Token und erkennt Manipulation", () => {
    const c = new Crypto(SECRET);
    const enc = c.encrypt("1//refresh-token");
    expect(enc).not.toContain("refresh");
    expect(c.decrypt(enc)).toBe("1//refresh-token");
    expect(c.encrypt("a")).not.toBe(c.encrypt("a")); // zufälliger IV
    const parts = enc.split(".");
    parts[3] = Buffer.from("anders").toString("base64url");
    expect(c.decrypt(parts.join("."))).toBeNull();
    expect(new Crypto("y".repeat(48)).decrypt(enc)).toBeNull();
    expect(c.decrypt("unsinn")).toBeNull();
  });

  it("erzeugt zufällige Tokens und Hashes", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(sha256("a")).toHaveLength(64);
  });
});
