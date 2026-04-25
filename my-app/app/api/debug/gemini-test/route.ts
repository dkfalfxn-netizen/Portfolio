import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const apiKey = (process.env.GEMINI_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "GEMINI_API_KEY not set" });
  }

  const results: Record<string, unknown> = {};

  for (const modelId of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "안녕. 한 문장으로 인사해줘." }] }],
          generationConfig: { maxOutputTokens: 100, temperature: 0.2 },
        }),
      });
      const raw = await res.json() as Record<string, unknown>;
      const candidate = (raw.candidates as Array<{ content?: { parts?: Array<{ text?: string }>}; finishReason?: string }> | undefined)?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      results[modelId] = {
        httpStatus: res.status,
        ok: res.ok,
        finishReason: candidate?.finishReason,
        promptBlock: (raw.promptFeedback as Record<string, unknown> | undefined)?.blockReason,
        text: text.slice(0, 300) || null,
        error: (raw.error as Record<string, unknown> | undefined)?.message ?? null,
      };
    } catch (e) {
      results[modelId] = { exception: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({ ok: true, keyPrefix: apiKey.slice(0, 8) + "...", results });
}
