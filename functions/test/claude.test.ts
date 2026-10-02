import { describe, expect, it } from "vitest";
import { buildUserText, createClaudeAnalyzer, detectImageType, parseEffort, ROSTER_SCHEMA } from "../src/claude.js";
import { AppError } from "../src/errors.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

interface Captured {
  url: string;
  headers: Headers;
  body: any;
}

/** Simuliert die Messages API (Streaming/SSE) für das SDK. */
function fakeFetch(opts: { text?: string; stopReason?: string; status?: number; captured?: Captured[] }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    opts.captured?.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    if (opts.status && opts.status !== 200) {
      return new Response(JSON.stringify({ type: "error", error: { type: "error", message: "nope" } }), {
        status: opts.status,
        headers: { "content-type": "application/json" },
      });
    }
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const events: [string, unknown][] = [
      ["message_start", { type: "message_start", message }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: opts.text ?? "" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: opts.stopReason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    const sse = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const analyzer = (f: typeof fetch) =>
  createClaudeAnalyzer({ apiKey: "test", model: "claude-sonnet-5-5", effort: "high", hint: "Nur 2. Zug", fetch: f });

describe("Claude Analyse", () => {
  it("schickt Bild, Schema, Fallback und Effort und liefert das JSON", async () => {
    const captured: Captured[] = [];
    const json = { readable: true, problem: "", plan_year: 2026, plan_week: 41, entries: [] };
    const result = await analyzer(fakeFetch({ text: JSON.stringify(json), captured }))(JPEG, "image/jpeg", "2026-10-02");
    expect(result).toEqual(json);

    const req = captured[0]!;
    expect(req.url).toContain("/v1/messages");
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({
      model: "claude-sonnet-5-5",
      stream: true,
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: ROSTER_SCHEMA } },
    });
    const [image, text] = req.body.messages[0].content;
    expect(image).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } });
    expect(text.text).toContain("2026-10-02 (KW 40/2026)");
    expect(text.text).toContain("Nur 2. Zug");
  });

  it("lässt den Fallback weg, wenn er abgeschaltet ist", async () => {
    const captured: Captured[] = [];
    const f = createClaudeAnalyzer({ apiKey: "t", model: "m", effort: "low", fallback: false, fetch: fakeFetch({ text: "{}", captured }) });
    await f(JPEG, "image/jpeg", "2026-10-02");
    expect(captured[0]!.body.fallbacks).toBeUndefined();
    expect(captured[0]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });

  it("parst auch Antworten mit Codeblock", async () => {
    const result = await analyzer(fakeFetch({ text: '```json\n{"entries": []}\n```' }))(JPEG, "image/jpeg", "2026-10-02");
    expect(result).toEqual({ entries: [] });
  });

  it("meldet abgeschnittene Antworten verständlich", async () => {
    const run = analyzer(fakeFetch({ text: '{"entries": [', stopReason: "max_tokens" }))(JPEG, "image/jpeg", "2026-10-02");
    await expect(run).rejects.toMatchObject({ code: "analysis", message: expect.stringContaining("zu umfangreich") });
  });

  it("meldet Ablehnungen", async () => {
    const run = analyzer(fakeFetch({ text: "", stopReason: "refusal" }))(JPEG, "image/jpeg", "2026-10-02");
    await expect(run).rejects.toMatchObject({ code: "analysis" });
  });

  it("übersetzt API-Fehler in verständliche Meldungen", async () => {
    const cases: [number, string][] = [
      [401, "analysis"],
      [400, "analysis"],
    ];
    for (const [status, code] of cases) {
      const err: any = await analyzer(fakeFetch({ status }))(JPEG, "image/jpeg", "2026-10-02").catch((e: any) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe(code);
    }
  });

  it("meldet Überlastung (529) nach den Wiederholungen als 'busy'", async () => {
    const f = createClaudeAnalyzer({ apiKey: "t", model: "m", effort: "high", fetch: fakeFetch({ status: 529 }) });
    const err = await f(JPEG, "image/jpeg", "2026-10-02").catch((e: any) => e);
    expect(err).toMatchObject({ code: "busy", status: 503 });
  }, 20_000);
});

describe("Hilfsfunktionen", () => {
  it("baut den Nutzertext ohne Hinweis", () => {
    expect(buildUserText("2026-10-05")).toBe(
      "Heute ist Mo, 2026-10-05 (KW 41/2026).\nLies alle Termine aus dem Dienstplan auf dem Foto aus.",
    );
  });

  it("liest den Denkaufwand tolerant", () => {
    expect(parseEffort(undefined)).toBe("high");
    expect(parseEffort(" Medium ")).toBe("medium");
    expect(parseEffort("maximal")).toBe("high");
  });

  it("erkennt Bildformate an den Magic Bytes", () => {
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(Buffer.from("\x89PNG\r\n\x1a\n....", "binary"))).toBe("image/png");
    expect(detectImageType(Buffer.from("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(detectImageType(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(detectImageType(Buffer.from("hello world"))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});
