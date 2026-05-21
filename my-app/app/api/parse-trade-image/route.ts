/**
 * POST /api/parse-trade-image
 *
 * 거래내역 스크린샷(미래에셋·삼성증권 등)을 Gemini Vision으로 파싱해
 * 매수/매도 거래 목록 JSON을 반환합니다.
 *
 * Request: multipart/form-data
 *   - image: File  (JPEG/PNG/WEBP, max 10MB)
 *
 * Response: { trades: ParsedTrade[] }
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

export type ParsedTradeType = "buy" | "sell";
export type ParsedTradeCurrency = "KRW" | "USD" | "EUR";

export type ParsedTrade = {
  type: ParsedTradeType;        // 매수 | 매도
  date: string;                 // YYYY-MM-DD
  symbol: string;               // 티커 or 종목코드
  name: string;                 // 종목명
  qty: number;                  // 수량 (체결량)
  price: number;                // 체결가 (단가)
  currency: ParsedTradeCurrency;
  /** 매도 시에만: 평균 매입단가 (없으면 0) */
  avgPrice?: number;
  /** 원화가 아닌 경우: 적용 환율 (없으면 0) */
  fxRate?: number;
};

const SYSTEM_PROMPT = `당신은 한국 증권사(미래에셋증권, 삼성증권 등) 앱/HTS의 거래내역 화면 스크린샷에서 매수·매도 거래를 추출하는 전문가입니다.

이미지를 분석해서 거래 내역을 다음 JSON 형식으로만 응답하세요. 추가 설명 없이 JSON만 출력합니다.

{
  "trades": [
    {
      "type": "buy",           // "buy"(매수) 또는 "sell"(매도)
      "date": "2025-01-15",    // YYYY-MM-DD 형식. 날짜가 없으면 오늘 날짜
      "symbol": "005930",      // 종목코드(국내) 또는 티커(해외). 없으면 빈 문자열
      "name": "삼성전자",       // 종목명
      "qty": 10,               // 체결 수량 (양수)
      "price": 58000,          // 체결 단가 (1주당)
      "currency": "KRW",       // "KRW", "USD", "EUR" 중 하나
      "avgPrice": 0,           // 매도 시 평균매입단가. 모르면 0
      "fxRate": 0              // 해외 종목 환율. 모르면 0
    }
  ]
}

규칙:
- 매수/매도 구분이 명확하지 않으면 type을 "buy"로 설정
- 국내 종목은 currency를 "KRW"로, 해외 종목은 "USD"(기본) 또는 "EUR"
- 체결가가 원화면 currency를 "KRW"로
- 종목코드가 없으면 symbol을 종목명으로 채움
- 여러 건이면 모두 포함
- 거래 내역이 없으면 trades를 빈 배열로 반환`;

const GEMINI_VISION_MODELS = [
  "gemini-2.5-flash-preview-05-20",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

async function callGeminiVision(
  apiKey: string,
  base64Image: string,
  mimeType: string,
): Promise<ParsedTrade[]> {
  let lastError: Error | null = null;

  for (const model of GEMINI_VISION_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: SYSTEM_PROMPT },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Image,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2048,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        lastError = new Error(`Gemini ${model} HTTP ${res.status}: ${errText.slice(0, 200)}`);
        continue;
      }

      const json = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      // JSON 추출 (마크다운 코드블록 처리)
      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? rawText.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : rawText.trim();

      const parsed = JSON.parse(jsonStr) as { trades?: unknown[] };
      if (!Array.isArray(parsed.trades)) return [];

      return parsed.trades
        .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
        .map((t) => ({
          type: (t.type === "sell" ? "sell" : "buy") as ParsedTradeType,
          date: typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
            ? t.date
            : new Date().toISOString().slice(0, 10),
          symbol: typeof t.symbol === "string" ? t.symbol.trim() : "",
          name: typeof t.name === "string" ? t.name.trim() : "",
          qty: Math.abs(Number(t.qty) || 0),
          price: Math.abs(Number(t.price) || 0),
          currency: (["KRW", "USD", "EUR"].includes(String(t.currency)) ? t.currency : "KRW") as ParsedTradeCurrency,
          avgPrice: Number(t.avgPrice) || 0,
          fxRate: Number(t.fxRate) || 0,
        }))
        .filter((t) => t.name && t.qty > 0 && t.price > 0);

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Gemini Vision 호출 실패");
}

export async function POST(req: NextRequest) {
  const apiKey = (process.env.GEMINI_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "이미지 파일을 읽을 수 없습니다." }, { status: 400 });
  }

  const file = formData.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "image 필드에 파일을 첨부해 주세요." }, { status: 400 });
  }

  const MAX_BYTES = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "파일 크기가 10MB를 초과합니다." }, { status: 400 });
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  const mimeType = allowedTypes.includes(file.type) ? file.type : "image/jpeg";

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  try {
    const trades = await callGeminiVision(apiKey, base64, mimeType);
    return NextResponse.json({ trades });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parse-trade-image]", msg);
    return NextResponse.json(
      { error: `이미지 파싱 실패: ${msg.slice(0, 200)}` },
      { status: 500 },
    );
  }
}
