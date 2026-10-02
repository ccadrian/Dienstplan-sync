import { expect, test, type Page, type Request, type Route } from "@playwright/test";
import { fileURLToPath } from "node:url";

const API = "https://api.test";
const FIXTURE = fileURLToPath(new URL("../fixtures/dienstplan.png", import.meta.url));

const RESULT = {
  count: 3,
  replaced: 2,
  year: 2026,
  week: 41,
  weekKey: "2026-W41",
  lowConfidence: 1,
  calendarUrl: "https://calendar.google.com/calendar/r/week/2026/10/5",
  warnings: [],
  entries: [
    { date: "2026-10-05", weekday: "Mo", allDay: false, start: "07:15", end: "07:30", title: "Antreten", location: "Kp-Block", lowConfidence: false },
    { date: "2026-10-05", weekday: "Mo", allDay: false, start: "07:30", end: "12:00", title: "[?] Waffenausbildung G36", location: "", lowConfidence: true },
    { date: "2026-10-07", weekday: "Mi", allDay: true, start: null, end: null, title: "GvD", location: "Wache Nord", lowConfidence: false },
  ],
};

/** Ersetzt config.js und beantwortet API-Aufrufe mit dem übergebenen Handler. */
async function mockApi(page: Page, handler: (route: Route, req: Request, path: string) => unknown) {
  await page.route("**/config.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: `export const API_BASE = "${API}";` }),
  );
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() });
    return handler(route, req, new URL(req.url()).pathname);
  });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "http://localhost:8000",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

async function loggedIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("dps.token", "session-token");
    localStorage.setItem("dps.email", "adrian@example.com");
  });
}

/** Breite und Höhe eines JPEG aus dem SOF-Marker. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("kein JPEG");
}

test("Anmeldung: Google-Login, Rückkehr mit Code, Startscreen", async ({ page }) => {
  await mockApi(page, (route, req, path) => {
    if (path === "/auth/start") {
      return route.fulfill({ status: 302, headers: { Location: "http://localhost:8000/#code=einmalcode" } });
    }
    if (path === "/auth/exchange") {
      expect(req.postDataJSON()).toEqual({ code: "einmalcode" });
      return json(route, 200, { token: "neues-token", email: "adrian@example.com" });
    }
    if (path === "/me") return json(route, 200, { email: "adrian@example.com" });
    return json(route, 404, {});
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dienstplan Sync" })).toBeVisible();
  await page.getByRole("button", { name: "Mit Google anmelden" }).click();

  await expect(page.getByRole("button", { name: "Foto aufnehmen" })).toBeVisible();
  await expect(page.locator("#user-email")).toHaveText("adrian@example.com");
  expect(await page.evaluate(() => localStorage.getItem("dps.token"))).toBe("neues-token");
  expect(page.url()).toBe("http://localhost:8000/"); // Code aus der Adresszeile entfernt
});

test("Login-Fehler werden verständlich angezeigt", async ({ page }) => {
  await mockApi(page, (route) => json(route, 404, {}));
  await page.goto("/#error=forbidden");
  await expect(page.getByText("Dieses Google-Konto ist für die App nicht freigeschaltet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mit Google anmelden" })).toBeVisible();
});

test("Foto hochladen: verkleinert, sendet und zeigt die eingetragenen Termine", async ({ page }) => {
  await loggedIn(page);
  let upload: { headers: Record<string, string>; body: Buffer } | undefined;
  await mockApi(page, async (route, req, path) => {
    if (path === "/me") return json(route, 200, { email: "adrian@example.com" });
    if (path === "/upload") {
      upload = { headers: req.headers(), body: req.postDataBuffer()! };
      await new Promise((r) => setTimeout(r, 600)); // Ladeanimation sichtbar
      return json(route, 200, RESULT);
    }
    return json(route, 404, {});
  });
  await page.goto("/");
  await page.locator("#gallery-input").setInputFiles(FIXTURE);

  await expect(page.locator('main[data-view="busy"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "3 Termine eingetragen" })).toBeVisible();
  await expect(page.getByText("KW 41/2026 · 2 alte ersetzt · 1 unsicher [?]")).toBeVisible();
  await expect(page.getByText("Mo 05.10.")).toBeVisible();
  await expect(page.getByText("07:15–07:30")).toBeVisible();
  await expect(page.getByText("ganztägig")).toBeVisible();
  await expect(page.locator("li.low .title")).toContainText("[?] Waffenausbildung G36");
  await expect(page.getByRole("link", { name: "Im Kalender öffnen" })).toHaveAttribute("href", RESULT.calendarUrl);

  expect(upload!.headers["authorization"]).toBe("Bearer session-token");
  expect(upload!.headers["content-type"]).toBe("image/jpeg");
  const { width, height } = jpegSize(upload!.body);
  expect(Math.max(width, height)).toBeLessThanOrEqual(2576);
  expect(width * height).toBeLessThanOrEqual(3_700_000);
  expect(width / height).toBeCloseTo(3265 / 2750, 2); // Seitenverhältnis bleibt
  expect(upload!.body.length).toBeLessThan(4.5 * 1024 * 1024);

  await page.getByRole("button", { name: "Neues Foto" }).click();
  await expect(page.getByRole("button", { name: "Foto aufnehmen" })).toBeVisible();
});

test("Unlesbares Foto: Meldung und neues Foto anbieten", async ({ page }) => {
  await loggedIn(page);
  await mockApi(page, (route, _req, path) =>
    path === "/upload"
      ? json(route, 422, { error: "unreadable", message: "Auf dem Foto konnte kein Dienstplan gelesen werden (Bild unscharf)." })
      : json(route, 200, { email: "adrian@example.com" }),
  );
  await page.goto("/");
  await page.locator("#gallery-input").setInputFiles(FIXTURE);
  await expect(page.getByText("Auf dem Foto konnte kein Dienstplan gelesen werden (Bild unscharf).")).toBeVisible();
  await expect(page.getByRole("button", { name: "Neues Foto aufnehmen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Aus Galerie wählen" })).toBeVisible();
});

test("Abgelaufener Google-Zugang: Neu anmelden", async ({ page }) => {
  await loggedIn(page);
  let startCalled = false;
  await mockApi(page, (route, _req, path) => {
    if (path === "/upload") {
      return json(route, 401, { error: "reauth", message: "Der Zugriff auf deinen Google Kalender ist abgelaufen. Bitte melde dich neu an." });
    }
    if (path === "/auth/start") {
      startCalled = true;
      return route.fulfill({ status: 200, contentType: "text/html", body: "Google Login" });
    }
    return json(route, 200, { email: "adrian@example.com" });
  });
  await page.goto("/");
  await page.locator("#gallery-input").setInputFiles(FIXTURE);
  await expect(page.getByText("Der Zugriff auf deinen Google Kalender ist abgelaufen.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Neu anmelden" }).click();
  await expect.poll(() => startCalled).toBe(true);
});

test("Serverfehler: Nochmal versuchen schickt dasselbe Foto erneut", async ({ page }) => {
  await loggedIn(page);
  let uploads = 0;
  await mockApi(page, (route, _req, path) => {
    if (path !== "/upload") return json(route, 200, { email: "adrian@example.com" });
    uploads++;
    return uploads === 1
      ? json(route, 503, { error: "busy", message: "Die Bildanalyse ist gerade überlastet." })
      : json(route, 200, RESULT);
  });
  await page.goto("/");
  await page.locator("#gallery-input").setInputFiles(FIXTURE);
  await expect(page.getByText("Die Bildanalyse ist gerade überlastet.")).toBeVisible();
  await page.getByRole("button", { name: "Nochmal versuchen" }).click();
  await expect(page.getByRole("heading", { name: "3 Termine eingetragen" })).toBeVisible();
  expect(uploads).toBe(2);
});

test("Keine Verbindung: verständliche Meldung", async ({ page }) => {
  await loggedIn(page);
  await mockApi(page, (route, _req, path) =>
    path === "/upload" ? route.abort("internetdisconnected") : json(route, 200, { email: "adrian@example.com" }),
  );
  await page.goto("/");
  await page.locator("#gallery-input").setInputFiles(FIXTURE);
  await expect(page.getByText("Keine Verbindung zum Server. Bist du online?")).toBeVisible();
});

test("Abgelaufene Session führt zurück zur Anmeldung", async ({ page }) => {
  await loggedIn(page);
  await mockApi(page, (route) => json(route, 401, { error: "auth", message: "Bitte melde dich an." }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Mit Google anmelden" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("dps.token"))).toBeNull();
});

test("Abmelden", async ({ page }) => {
  await loggedIn(page);
  let loggedOut = false;
  await mockApi(page, (route, _req, path) => {
    if (path === "/auth/logout") {
      loggedOut = true;
      return route.fulfill({ status: 204, headers: cors() });
    }
    return json(route, 200, { email: "adrian@example.com" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page.getByRole("button", { name: "Mit Google anmelden" })).toBeVisible();
  await expect.poll(() => loggedOut).toBe(true);
});

test("Ohne konfigurierte API-Adresse erscheint ein Einrichtungshinweis", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Die App ist noch nicht eingerichtet", { exact: false })).toBeVisible();
});

test.describe("PWA", () => {
  test.use({ serviceWorkers: "allow" });

  test("ist installierbar und startet offline", async ({ page, context }) => {
    await page.goto("/");
    const manifest = await page.evaluate(async () => {
      const href = document.querySelector('link[rel="manifest"]')!.getAttribute("href")!;
      return (await fetch(href)).json();
    });
    expect(manifest).toMatchObject({ name: "Dienstplan Sync", display: "standalone", start_url: "./" });
    for (const icon of manifest.icons) {
      const res = await page.request.get(`/${icon.src}`);
      expect(res.ok(), icon.src).toBe(true);
    }
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // Seite wird jetzt vom Service Worker kontrolliert
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText("Die App ist noch nicht eingerichtet", { exact: false })).toBeVisible();
  });
});
