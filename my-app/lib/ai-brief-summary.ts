import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

function cleanKey(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t || undefined;
}

export type BriefSummaryParams = {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
};

/** `.text()`가 throw(차단·빈 후보)일 때 후보 parts에서 이어붙이기 */
function extractGeminiText(response: { text: () => string; candidates?: Array<{ content?: { parts?: unknown[] } }> }): string | undefined {
  try {
    const t = response.text()?.trim();
    if (t) return t;
  } catch {
    /* blocked 등 */
  }
  const parts = response.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const merged = parts
    .map((p) => {
      if (p && typeof p === "object" && "text" in p && typeof (p as { text?: unknown }).text === "string") {
        return (p as { text: string }).text;
      }
      return "";
    })
    .join("")
    .trim();
  return merged || undefined;
}

function geminiModelCandidates(): string[] {
  const fromEnv = cleanKey(process.env.GEMINI_MODEL);
  const chain = [
    fromEnv,
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
  ].filter((x): x is string => Boolean(x));
  return [...new Set(chain)];
}

async function tryGeminiOneModel(
  params: BriefSummaryParams,
  apiKey: string,
  modelId: string,
): Promise<string | null> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction: params.system,
    generationConfig: {
      maxOutputTokens: params.maxTokens,
      temperature: params.temperature,
    },
  });
  const result = await model.generateContent(params.user);
  const text = extractGeminiText(result.response);
  return text && text.length > 0 ? text : null;
}

async function tryGemini(params: BriefSummaryParams, apiKey: string): Promise<string | null> {
  const models = geminiModelCandidates();
  let lastErr: unknown;
  for (const modelId of models) {
    try {
      const t = await tryGeminiOneModel(params, apiKey, modelId);
      if (t) {
        if (modelId !== models[0]) {
          console.warn(`[ai-brief-summary] Gemini OK with fallback model: ${modelId}`);
        }
        return t;
      }
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ai-brief-summary] Gemini failed model=${modelId}:`, msg.slice(0, 500));
    }
  }
  if (lastErr) {
    console.error("[ai-brief-summary] Gemini all models exhausted");
  }
  return null;
}

async function tryOpenAI(params: BriefSummaryParams, apiKey: string): Promise<string | null> {
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
  });
  const text = completion.choices[0]?.message?.content?.trim();
  return text && text.length > 0 ? text : null;
}

/**
 * 일일 브리핑용 짧은 요약.
 * - `GEMINI_API_KEY`가 있으면 **Gemini만** 사용 (실패·빈 응답 시 null). OpenAI로 넘어가지 않아 429 로그·불필요 과금을 막음.
 * - 없으면 `OPENAI_API_KEY`로 OpenAI.
 * - `AI_SUMMARY_ALLOW_OPENAI_FALLBACK=1`이면 Gemini 실패 후에도 OpenAI 시도(예: 로컬 디버그).
 * 모델: `GEMINI_MODEL` 우선, 실패 시 2.5-flash-lite → 2.5-flash → 2.0-flash → 1.5-flash 순으로 자동 재시도.
 */
export async function generateBriefSummary(params: BriefSummaryParams): Promise<string | null> {
  const geminiKey = cleanKey(process.env.GEMINI_API_KEY);
  const allowOpenAiAfterGemini = cleanKey(process.env.AI_SUMMARY_ALLOW_OPENAI_FALLBACK) === "1";

  if (geminiKey) {
    try {
      const t = await tryGemini(params, geminiKey);
      if (t) return t;
    } catch {
      /* 빈 응답 또는 API 오류 */
    }
    if (!allowOpenAiAfterGemini) return null;
  }

  const openaiKey = cleanKey(process.env.OPENAI_API_KEY);
  if (!openaiKey) return null;
  try {
    return await tryOpenAI(params, openaiKey);
  } catch {
    return null;
  }
}
