// Probiert die Bildanalyse lokal aus, ohne Kalender und ohne Deploy.
//
//   cd functions
//   npm run build
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/try-analyze.mjs ../tests/fixtures/dienstplan.png
//
// Optional: CLAUDE_MODEL, CLAUDE_EFFORT, CLAUDE_HINT wie in .env
import { readFile } from "node:fs/promises";
import { createClaudeAnalyzer, detectImageType, parseEffort } from "../lib/claude.js";
import { berlinToday } from "../lib/dates.js";
import { normalizeRoster } from "../lib/roster.js";

const file = process.argv[2];
if (!file || !process.env.ANTHROPIC_API_KEY) {
  console.error("Aufruf: ANTHROPIC_API_KEY=... node scripts/try-analyze.mjs <bild.jpg>");
  process.exit(1);
}

const image = await readFile(file);
const mediaType = detectImageType(image);
if (!mediaType) throw new Error("Kein JPEG/PNG/WebP/GIF");
if (image.length > 5 * 1024 * 1024) throw new Error("Bild größer als 5 MB, bitte vorher verkleinern");

const analyze = createClaudeAnalyzer({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  effort: parseEffort(process.env.CLAUDE_EFFORT),
  hint: process.env.CLAUDE_HINT,
  fallback: process.env.CLAUDE_FALLBACK !== "off",
});

const today = berlinToday();
const started = Date.now();
const raw = await analyze(image, mediaType, today);
const roster = normalizeRoster(raw, today);
console.log(`Analyse in ${((Date.now() - started) / 1000).toFixed(1)} s, ${roster.weekKey}, lesbar: ${roster.readable}`);
if (roster.problem) console.log("Problem:", roster.problem);
console.table(
  roster.entries.map((e) => ({
    Datum: e.date,
    Zeit: e.allDay ? "ganztägig" : `${e.start}-${e.end}${e.endDate !== e.date ? " (+1)" : ""}`,
    Titel: e.title,
    Ort: e.location,
    Verantwortlich: e.responsible,
    Anzug: e.uniform,
    Hinweise: e.notes,
  })),
);
if (roster.skipped) console.log(`${roster.skipped} Einträge ohne gültiges Datum übersprungen`);
