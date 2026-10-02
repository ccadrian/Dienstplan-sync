import { API_BASE } from "./config.js";

// Bildgröße: Claude liest bis 2576 px Kantenlänge (~3,75 MP), API-Limit 5 MB
const MAX_EDGE = 2576;
const MAX_PIXELS = 3_700_000;
const MAX_BYTES = 4.5 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 290_000;
const TOKEN_KEY = "dps.token";
const EMAIL_KEY = "dps.email";

const $ = (id) => document.getElementById(id);
const main = $("app");

let lastFile = null;
let previewUrl = null;

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* privater Modus */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* egal */ }
  },
};

function show(view) {
  main.dataset.view = view;
  window.scrollTo(0, 0);
}

// --- API -------------------------------------------------------------------

class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(path, { method = "GET", body, headers = {}, timeout = 20_000 } = {}) {
  const token = storage.get(TOKEN_KEY);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      body,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(
      "network",
      controller.signal.aborted
        ? "Zeitüberschreitung. Bitte versuche es erneut."
        : "Keine Verbindung zum Server. Bist du online?",
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* keine JSON-Antwort */ }
  if (!res.ok) {
    throw new ApiError(data?.error ?? "http", data?.message ?? `Serverfehler (${res.status}). Bitte versuche es erneut.`, res.status);
  }
  return data;
}

// --- Anmeldung -------------------------------------------------------------

const LOGIN_ERRORS = {
  denied: "Anmeldung abgebrochen.",
  forbidden: "Dieses Google-Konto ist für die App nicht freigeschaltet.",
  scope: "Bitte erlaube beim Anmelden den Zugriff auf den Kalender.",
  state: "Die Anmeldung ist abgelaufen. Bitte versuche es erneut.",
  server: "Die Anmeldung ist fehlgeschlagen. Bitte versuche es später erneut.",
};

function showLogin(message) {
  const notice = $("login-error");
  notice.textContent = message ?? "";
  notice.hidden = !message;
  show("login");
}

function showReady() {
  $("user-email").textContent = storage.get(EMAIL_KEY) ?? "";
  show("ready");
}

function forgetSession() {
  storage.remove(TOKEN_KEY);
  storage.remove(EMAIL_KEY);
}

async function logout() {
  api("/auth/logout", { method: "POST" }).catch(() => {});
  forgetSession();
  showLogin();
}

async function finishLogin(code) {
  try {
    const { token, email } = await api("/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
    });
    storage.set(TOKEN_KEY, token);
    storage.set(EMAIL_KEY, email);
    showReady();
  } catch (err) {
    showLogin(err.message);
  }
}

/** Prüft die gespeicherte Session im Hintergrund und weckt dabei die Function auf. */
async function checkSession() {
  try {
    const { email } = await api("/me");
    storage.set(EMAIL_KEY, email);
    $("user-email").textContent = email;
  } catch (err) {
    if (err.code === "auth" || err.code === "forbidden") {
      forgetSession();
      if (main.dataset.view === "ready") showLogin(err.code === "forbidden" ? err.message : undefined);
    }
  }
}

// --- Foto ------------------------------------------------------------------

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  });
}

function fitSize(width, height) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), "image/jpeg", quality),
  );
}

/** Verkleinert und komprimiert das Foto (EXIF-Drehung übernimmt der Browser). */
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { width, height } = fitSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    let quality = 0.85;
    let blob = await canvasToBlob(canvas, quality);
    while (blob.size > MAX_BYTES && quality > 0.45) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, quality);
    }
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const BUSY_STEPS = [
  [0, "Foto wird übertragen …"],
  [2500, "Dienstplan wird gelesen …"],
  [35_000, "Das dauert etwas länger …"],
  [90_000, "Gleich geschafft …"],
];

function startBusyText() {
  const started = Date.now();
  const update = () => {
    const elapsed = Date.now() - started;
    const step = BUSY_STEPS.filter(([at]) => elapsed >= at).pop();
    $("busy-text").textContent = step[1];
  };
  update();
  const id = setInterval(update, 500);
  return () => clearInterval(id);
}

async function keepScreenOn() {
  try { return await navigator.wakeLock?.request("screen"); } catch { return null; }
}

async function handleFile(file) {
  if (!file) return;
  lastFile = file;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  $("preview").src = previewUrl;
  $("busy-text").textContent = "Foto wird vorbereitet …";
  show("busy");

  let blob;
  try {
    blob = await prepareImage(file);
  } catch {
    showError(new ApiError("image", "Das Bild konnte nicht geöffnet werden. Bitte nimm ein neues Foto auf."));
    return;
  }

  const stopText = startBusyText();
  const wakeLock = await keepScreenOn();
  try {
    const result = await api("/upload", {
      method: "POST",
      body: blob,
      headers: { "Content-Type": "image/jpeg" },
      timeout: UPLOAD_TIMEOUT_MS,
    });
    renderResult(result);
    show("done");
  } catch (err) {
    showError(err);
  } finally {
    stopText();
    wakeLock?.release?.().catch(() => {});
  }
}

// --- Ergebnis --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDay(entry) {
  const [, m, d] = entry.date.split("-");
  return `${entry.weekday} ${d}.${m}.`;
}

function renderResult(r) {
  $("result-title").textContent = r.count === 1 ? "1 Termin eingetragen" : `${r.count} Termine eingetragen`;
  const sub = [`KW ${r.week}/${r.year}`];
  if (r.replaced > 0) sub.push(`${r.replaced} alte ersetzt`);
  if (r.lowConfidence > 0) sub.push(`${r.lowConfidence} unsicher [?]`);
  $("result-sub").textContent = sub.join(" · ");

  const warnings = $("result-warnings");
  warnings.replaceChildren(...(r.warnings ?? []).map((w) => el("li", "", w)));

  const days = new Map();
  for (const e of r.entries) {
    if (!days.has(e.date)) days.set(e.date, []);
    days.get(e.date).push(e);
  }
  const list = $("result-list");
  list.replaceChildren(
    ...[...days.values()].map((entries) => {
      const day = el("li", "day");
      day.append(el("h3", "", formatDay(entries[0])));
      const ul = el("ul");
      for (const e of entries) {
        const li = el("li", e.lowConfidence ? "low" : "");
        li.append(el("span", "time", e.allDay ? "ganztägig" : `${e.start}–${e.end}`));
        const title = el("span", "title", e.title);
        if (e.location) title.append(el("span", "where", e.location));
        li.append(title);
        ul.append(li);
      }
      day.append(ul);
      return day;
    }),
  );
  $("calendar-link").href = r.calendarUrl;
}

// --- Fehler ----------------------------------------------------------------

let errorAction = null;

function showError(err) {
  const code = err?.code ?? "unknown";
  const message = err?.message || "Unerwarteter Fehler. Bitte versuche es erneut.";
  const primary = $("error-primary");
  const secondary = $("error-secondary");
  secondary.hidden = false;

  if (code === "auth" || code === "reauth") {
    forgetSession();
    primary.textContent = "Neu anmelden";
    errorAction = startLogin;
    secondary.hidden = true;
  } else if (code === "forbidden") {
    forgetSession();
    showLogin(message);
    return;
  } else if (code === "unreadable" || code === "image" || code === "bad_request") {
    primary.textContent = "Neues Foto aufnehmen";
    errorAction = () => $("camera-input").click();
    secondary.textContent = "Aus Galerie wählen";
    secondary.onclick = () => $("gallery-input").click();
  } else {
    primary.textContent = "Nochmal versuchen";
    errorAction = () => handleFile(lastFile);
    secondary.textContent = "Neues Foto";
    secondary.onclick = showReady;
  }
  $("error-text").textContent = message;
  show("error");
}

function showConfigError() {
  $("error-text").textContent =
    "Die App ist noch nicht eingerichtet: Bitte die Adresse der Firebase Function in web/config.js eintragen.";
  $("error-primary").hidden = true;
  $("error-secondary").hidden = true;
  show("error");
}

// --- Start -----------------------------------------------------------------

function startLogin() {
  window.location.href = `${API_BASE}/auth/start`;
}

function wireUp() {
  $("login-btn").addEventListener("click", startLogin);
  $("logout-btn").addEventListener("click", logout);
  $("again-btn").addEventListener("click", showReady);
  $("error-primary").addEventListener("click", () => errorAction?.());
  $("camera-btn").addEventListener("click", () => $("camera-input").click());
  $("gallery-btn").addEventListener("click", () => $("gallery-input").click());
  for (const id of ["camera-input", "gallery-input"]) {
    const input = $(id);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = ""; // dasselbe Foto erneut wählbar
      handleFile(file);
    });
  }
}

async function boot() {
  wireUp();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  if (!API_BASE || API_BASE.includes("DEIN-PROJEKT")) {
    showConfigError();
    return;
  }

  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.has("code") || params.has("error")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  if (params.get("code")) {
    await finishLogin(params.get("code"));
  } else if (params.get("error")) {
    showLogin(LOGIN_ERRORS[params.get("error")] ?? LOGIN_ERRORS.server);
  } else if (storage.get(TOKEN_KEY)) {
    showReady();
    checkSession();
  } else {
    showLogin();
  }
}

boot();
