// Supabase Edge Function: AI summarization for the Recall recording app.
//
// Receives a transcript and returns a structured summary + timeline using
// Claude. The response schema matches what the web app expects, so the app
// merges it directly (js/summarizer.js -> summarize()).
//
// Request  (POST):
//   { "language": "ko-KR", "transcript": [{ "t": 0, "text": "..." }, ...] }
// Response (200):
//   {
//     "overview": "...",
//     "keyPoints": ["...", "..."],
//     "actionItems": [{ "t": 120, "text": "..." }],
//     "topics": [{ "t": 0, "topic": "...", "recap": "..." }]
//   }
//
// Environment variables (set with `supabase secrets set ...`):
//   ANTHROPIC_API_KEY          required — your Anthropic API key
//   SUMMARY_MODEL              optional — defaults to "claude-opus-5"
//                              (use "claude-sonnet-5" or "claude-haiku-4-5"
//                               to trade some quality for lower cost)
//   SUMMARIZE_SHARED_SECRET    optional — if set, callers must send
//                              `Authorization: Bearer <secret>`
//   ALLOWED_ORIGIN             optional — CORS origin allowlist (defaults "*")

import Anthropic from "npm:@anthropic-ai/sdk@0.68.0";

const MODEL = Deno.env.get("SUMMARY_MODEL") ?? "claude-opus-5";
const SHARED_SECRET = Deno.env.get("SUMMARIZE_SHARED_SECRET") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

interface Segment { t: number; text: string; }

const SYSTEM_PROMPT = `You are a meeting-notes assistant for a voice-recording app.
You receive a time-stamped transcript of a meeting or presentation and produce a concise, well-structured summary.

Rules:
- Write the summary in the SAME language as the transcript (indicated by the language code). If the transcript language clearly differs from the code, follow the actual transcript language.
- "overview": 1-3 sentence high-level summary of what the meeting was about and what was decided.
- "keyPoints": the most important discussion points, as short standalone bullet strings (3-7 items).
- "actionItems": concrete tasks, decisions, or follow-ups. Each has "t" (the timestamp in seconds from the transcript where it was raised) and "text" (a clear, actionable phrasing). Omit if there are none.
- "topics": a timeline. Segment the meeting into a handful of topical blocks in chronological order. Each has "t" (start time in seconds), "topic" (a 1-4 word label) and "recap" (one sentence describing that block).
- Be faithful to the transcript. Do not invent facts, names, numbers, or decisions that are not present.
- Respond with a SINGLE JSON object and nothing else. No markdown, no code fences, no commentary.`;

function buildUserPrompt(language: string, transcript: Segment[]): string {
  const lines = transcript.map((s) => `[${s.t}s] ${s.text}`).join("\n");
  return `Transcript language code: ${language || "unknown"}

Transcript:
${lines}

Return the JSON object now.`;
}

function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function parseJson(raw: string): Record<string, unknown> {
  let s = raw.trim();
  // Strip accidental code fences if the model added any.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Fall back to the outermost braces.
  if (!s.startsWith("{")) {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last !== -1) s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // Optional shared-secret gate to prevent open abuse of your API key.
  if (SHARED_SECRET) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${SHARED_SECRET}`) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ error: "server_misconfigured", detail: "ANTHROPIC_API_KEY not set" }, 500);
  }

  let language = "";
  let transcript: Segment[] = [];
  try {
    const body = await req.json();
    language = typeof body.language === "string" ? body.language : "";
    if (Array.isArray(body.transcript)) {
      transcript = body.transcript
        .filter((s: unknown) => s && typeof (s as Segment).text === "string")
        .map((s: Segment) => ({ t: Math.max(0, Math.round(Number(s.t) || 0)), text: String(s.text) }));
    }
  } catch {
    return json({ error: "bad_request", detail: "invalid JSON body" }, 400);
  }

  if (transcript.length === 0) {
    return json({ error: "empty_transcript" }, 400);
  }

  const client = new Anthropic({ apiKey });

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(language, transcript) }],
    });

    const raw = extractText(msg);
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJson(raw);
    } catch {
      return json({ error: "parse_failed", raw }, 502);
    }

    // Normalize / defend the shape the app consumes.
    const result = {
      overview: typeof parsed.overview === "string" ? parsed.overview : "",
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.filter((x) => typeof x === "string")
        : [],
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems
            .filter((a: unknown) => a && typeof (a as Segment).text === "string")
            .map((a: Segment) => ({ t: Math.max(0, Math.round(Number(a.t) || 0)), text: String(a.text) }))
        : [],
      topics: Array.isArray(parsed.topics)
        ? parsed.topics
            .filter((b: unknown) => b && typeof b === "object")
            .map((b: Record<string, unknown>) => ({
              t: Math.max(0, Math.round(Number(b.t) || 0)),
              topic: typeof b.topic === "string" ? b.topic : "",
              recap: typeof b.recap === "string" ? b.recap : "",
            }))
        : [],
      source: "ai",
      model: MODEL,
    };

    return json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return json({ error: "summarization_failed", detail }, 502);
  }
});
