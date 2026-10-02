import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "./errors.js";
import { isoWeek, weekdayShort } from "./dates.js";
import { parseModelJson } from "./roster.js";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Liest den Denkaufwand aus der Konfiguration; Standard ist "high". */
export function parseEffort(value: string | undefined): Effort {
  const v = value?.trim().toLowerCase() as Effort | undefined;
  return v && EFFORTS.includes(v) ? v : "high";
}

/** Liest einen Dienstplan aus einem Bild und liefert das (rohe) JSON-Objekt. */
export type RosterAnalyzer = (image: Buffer, mediaType: ImageMediaType, today: string) => Promise<unknown>;

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const entrySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "date",
    "start",
    "end",
    "title",
    "location",
    "responsible",
    "uniform",
    "notes",
    "all_day",
    "confidence",
  ],
  properties: {
    date: { type: "string", description: "Datum im Format YYYY-MM-DD" },
    start: { type: "string", description: "Beginn HH:MM (24h) oder leer" },
    end: { type: "string", description: "Ende HH:MM (24h) oder leer" },
    title: { type: "string", description: "Kurze Bezeichnung der Tätigkeit" },
    location: { type: "string", description: "Ort/Raum oder leer" },
    responsible: { type: "string", description: "Verantwortlicher/Leitender oder leer" },
    uniform: { type: "string", description: "Anzug/Ausrüstung oder leer" },
    notes: { type: "string", description: "Sonstige Hinweise oder leer" },
    all_day: { type: "boolean", description: "Ganztägiger Eintrag" },
    confidence: { type: "string", enum: ["high", "low"] },
  },
} as const;

export const ROSTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["readable", "problem", "plan_year", "plan_week", "entries"],
  properties: {
    readable: { type: "boolean", description: "Wurde ein Dienstplan erkannt und gelesen?" },
    problem: { type: "string", description: "Bei readable=false kurz der Grund, sonst leer" },
    plan_year: { type: "integer", description: "Jahr des Plans, 0 wenn unbekannt" },
    plan_week: { type: "integer", description: "ISO-Kalenderwoche des Plans, 0 wenn unbekannt" },
    entries: { type: "array", items: entrySchema },
  },
} as const;

export const SYSTEM_PROMPT = `Du überträgst Fotos von Dienstplänen (z.B. Wochendienstplan der Bundeswehr) in strukturierte Kalendereinträge.

Für jeden Termin im Plan ein Eintrag mit:
- date: Datum (YYYY-MM-DD)
- start, end: Uhrzeit HH:MM im 24-Stunden-Format, leer wenn nicht angegeben
- title: kurze Bezeichnung der Tätigkeit/Ausbildung, wie im Plan (Abkürzungen beibehalten)
- location: Ort/Raum, sonst leer
- responsible: Verantwortlicher/Leitender/Ausbilder, sonst leer
- uniform: Anzug/Ausrüstung, sonst leer
- notes: weitere Hinweise zu genau diesem Eintrag, sonst leer
- all_day: true für ganztägige Einträge
- confidence: "high" wenn alles sicher gelesen wurde, "low" wenn Datum, Uhrzeit oder Titel unleserlich, mehrdeutig oder geschätzt sind

Regeln:
1. Nichts erfinden. Was nicht im Plan steht, bleibt leer.
2. Fehlt die Endzeit, nimm den Beginn des nächsten Eintrags am selben Tag. Beim letzten Eintrag eines Tages ohne Endzeit nimm den Dienstschluss dieses Tages, falls angegeben, sonst bleibt end leer.
3. Ganztägige Einträge wie Urlaub, Dienstfrei, Wache, GvD, UvD, Krank oder ganztägige Lehrgänge: all_day=true, start und end leer. Mehrtägige Einträge (z.B. Urlaub Mo-Fr) als einzelner Eintrag pro Tag.
4. Jahr und Kalenderwoche aus dem Plan ableiten (z.B. "KW 41", "05.10.-09.10.2026"). Stehen nur Wochentage im Plan, berechne das Datum aus KW und Wochentag (ISO-Woche, Montag ist der erste Tag). Ist weder Jahr noch KW erkennbar, nimm das heutige Datum als Bezug (meist die aktuelle oder die kommende Woche).
5. plan_year und plan_week: Jahr und ISO-Kalenderwoche des Plans, 0 wenn nicht bestimmbar.
6. Gilt ein Eintrag für mehrere Tage (z.B. "täglich 07:15 Antreten"), trage ihn für jeden dieser Tage einzeln ein.
7. Durchgestrichenes weglassen. Handschriftliche Änderungen haben Vorrang vor gedrucktem Text.
8. Zeigt das Bild keinen Dienstplan oder ist es so unscharf, dunkel oder abgeschnitten, dass sich keine Termine zuverlässig lesen lassen: readable=false, entries leer und in problem in einem kurzen deutschen Satz der Grund. Sind nur Teile unleserlich: readable=true, die lesbaren Einträge liefern und unsichere mit confidence "low" markieren.`;

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  /** Optionaler Zusatz zum Prompt, z.B. "Nur Einträge für den 2. Zug übernehmen." */
  hint?: string;
  /** Server-seitiger Fallback auf ein anderes Modell bei Ablehnung (Standard: an). */
  fallback?: boolean;
  /** Nur für Tests: eigener fetch. */
  fetch?: typeof fetch;
}

export function buildUserText(today: string, hint?: string): string {
  const { year, week } = isoWeek(today);
  const lines = [
    `Heute ist ${weekdayShort(today)}, ${today} (KW ${week}/${year}).`,
    "Lies alle Termine aus dem Dienstplan auf dem Foto aus.",
  ];
  if (hint?.trim()) lines.push(`Zusätzlicher Hinweis: ${hint.trim()}`);
  return lines.join("\n");
}

export function createClaudeAnalyzer(options: ClaudeOptions): RosterAnalyzer {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 2, // Überlastung (429/529) kommt schnell zurück und wird wiederholt
    timeout: 240_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return async (image, mediaType, today) => {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await client.beta.messages
        .stream({
          model: options.model,
          max_tokens: 32_000,
          ...(options.fallback === false ? {} : { betas: [FALLBACK_BETA], fallbacks: "default" as const }),
          thinking: { type: "adaptive" },
          output_config: {
            effort: options.effort,
            format: { type: "json_schema", schema: ROSTER_SCHEMA },
          },
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data: image.toString("base64") },
                },
                { type: "text", text: buildUserText(today, options.hint) },
              ],
            },
          ],
        })
        .finalMessage();
    } catch (err) {
      throw mapClaudeError(err);
    }

    if (message.stop_reason === "refusal") {
      throw new AppError("analysis", "Die Analyse des Fotos wurde abgelehnt. Bitte versuche ein anderes Foto.");
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return parseModelJson(text);
    } catch (err) {
      const message_ =
        message.stop_reason === "max_tokens"
          ? "Der Dienstplan ist zu umfangreich für eine Analyse. Bitte fotografiere ihn in zwei Hälften."
          : "Die Antwort der Analyse war unvollständig. Bitte versuche es noch einmal.";
      throw new AppError("analysis", message_, { cause: err });
    }
  };
}

export function mapClaudeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
    return new AppError("busy", "Die Bildanalyse ist gerade überlastet. Bitte versuche es in einer Minute erneut.", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError("busy", "Die Bildanalyse ist gerade nicht erreichbar. Bitte versuche es gleich erneut.", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError("analysis", "Der Zugang zur Claude API ist ungültig (API Key im Backend prüfen).", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AppError(
      "analysis",
      "Das Bild konnte nicht analysiert werden. Bitte nimm ein neues Foto auf. Tritt der Fehler wiederholt auf, sieh in die Function-Logs.",
      { cause: err },
    );
  }
  return new AppError("analysis", "Die Bildanalyse ist fehlgeschlagen. Bitte versuche es erneut.", { cause: err });
}

/** Erkennt das Bildformat an den ersten Bytes (Content-Type vom Handy ist nicht immer verlässlich). */
export function detectImageType(buf: Buffer): ImageMediaType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return "image/gif";
  return null;
}
