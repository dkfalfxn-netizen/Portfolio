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

async function tryGemini(params: BriefSummaryParams, apiKey: string): Promise<string | null> {
  const modelId = cleanKey(process.env.GEMINI_MODEL) ?? "gemini-2.0-flash";
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
  const text = result.response.text()?.trim();
  return text && text.length > 0 ? text : null;
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
 * 모델: `GEMINI_MODEL` (기본 gemini-2.0-flash), 안 되면 gemini-1.5-flash 등으로 설정.
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
