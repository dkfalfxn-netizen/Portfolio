import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/generative-ai";
import OpenAI from "openai";

function cleanKey(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t || undefined;
}

/** 헤드라인에 정치·연준 키워드가 있으면 CIVIC_INTEGRITY 등으로 막히기 쉬워 완화 */
const GEMINI_SAFETY_RELAXED = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
].map((category) => ({
  category,
  threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
}));

export type BriefSummaryParams = {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
};

/** `.text()`가 throw(차단·빈 후보)일 때 후보 parts에서 이어붙이기 */
function extractGeminiText(response: {
  text: () => string;
  candidates?: Array<{ content?: { parts?: unknown[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}): string | undefined {
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

function logGeminiDiag(modelId: string, response: Parameters<typeof extractGeminiText>[0]) {
  const c0 = response.candidates?.[0];
  const fr = c0?.finishReason;
  const br = response.promptFeedback?.blockReason;
  if (br) {
    console.warn(`[ai-brief-summary] Gemini model=${modelId} promptFeedback.blockReason=${br}`);
  }
  if (fr && fr !== "STOP") {
    console.warn(`[ai-brief-summary] Gemini model=${modelId} finishReason=${fr}`);
  }
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

async function tryGeminiSdk(
  params: BriefSummaryParams,
  apiKey: string,
  modelId: string,
): Promise<string | null> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction: params.system,
    safetySettings: GEMINI_SAFETY_RELAXED,
    generationConfig: {
      maxOutputTokens: params.maxTokens,
      temperature: params.temperature,
    },
  });
  const result = await model.generateContent(params.user);
  logGeminiDiag(modelId, result.response);
  const text = extractGeminiText(result.response);
  return text && text.length > 0 ? text : null;
}

/** SDK와 다른 경로(일부 런타임에서 SDK만 실패할 때) */
async function tryGeminiRest(
  params: BriefSummaryParams,
  apiKey: string,
  modelId: string,
): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: params.system }] },
    contents: [{ role: "user", parts: [{ text: params.user }] }],
    generationConfig: {
      maxOutputTokens: params.maxTokens,
      temperature: params.temperature,
    },
    safetySettings: GEMINI_SAFETY_RELAXED,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as {
    error?: { message?: string; status?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  if (!res.ok) {
    console.error(
      `[ai-brief-summary] Gemini REST model=${modelId} HTTP ${res.status}:`,
      (raw.error?.message ?? JSON.stringify(raw)).slice(0, 400),
    );
    return null;
  }
  if (raw.promptFeedback?.blockReason) {
    console.warn(`[ai-brief-summary] Gemini REST model=${modelId} promptBlock=${raw.promptFeedback.blockReason}`);
  }
  const parts = raw.candidates?.[0]?.content?.parts;
  const fr = raw.candidates?.[0]?.finishReason;
  if (fr && fr !== "STOP") {
    console.warn(`[ai-brief-summary] Gemini REST model=${modelId} finishReason=${fr}`);
  }
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

async function tryGeminiOneModel(
  params: BriefSummaryParams,
  apiKey: string,
  modelId: string,
): Promise<string | null> {
  try {
    const t = await tryGeminiSdk(params, apiKey, modelId);
    if (t) return t;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ai-brief-summary] Gemini SDK failed model=${modelId}:`, msg.slice(0, 500));
  }
  try {
    const t = await tryGeminiRest(params, apiKey, modelId);
    if (t) {
      console.warn(`[ai-brief-summary] Gemini OK via REST model=${modelId}`);
      return t;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ai-brief-summary] Gemini REST failed model=${modelId}:`, msg.slice(0, 500));
  }
  return null;
}

async function tryGemini(params: BriefSummaryParams, apiKey: string): Promise<string | null> {
  const models = geminiModelCandidates();
  for (const modelId of models) {
    const t = await tryGeminiOneModel(params, apiKey, modelId);
    if (t) {
      if (modelId !== models[0]) {
        console.warn(`[ai-brief-summary] Gemini OK with fallback model: ${modelId}`);
      }
      return t;
    }
  }
  console.error("[ai-brief-summary] Gemini all models exhausted (SDK + REST, every candidate)");
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
    } catch (e) {
      console.error("[ai-brief-summary] Gemini unexpected:", e instanceof Error ? e.message : String(e));
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
