import { NextResponse } from "next/server";
import { getKisUsQuote, getKisUsQuotes, kisCredentialsConfigured } from "@/lib/kis-quote";

// KIS는 외부 API 호출 + 서버 env 필요 → 항상 동적, Node 런타임.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 미국 현재가 (한투, 세션 자동 — 데이장/정규/애프터 라이브). Railway 엔드포인트를 Vercel 서버리스로 이전.
 *  - 단건: /api/overseas/daytime-price?symbol=SNDK  → Railway와 동일한 평면 객체
 *  - 일괄: /api/overseas/daytime-price?symbols=SNDK,MU,SOXX → { quotes: { SNDK: {...}, ... } }
 *  - 같은 출처(상대경로)로 호출하므로 CORS 불필요. secret은 서버 env에서만 사용(브라우저 노출 없음).
 */
export async function GET(req: Request) {
  if (!kisCredentialsConfigured()) {
    return NextResponse.json(
      { error: "KIS_APP_KEY/KIS_APP_SECRET 환경변수가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols");
  const single = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();

  try {
    if (symbolsParam) {
      const syms = symbolsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const quotes = await getKisUsQuotes(syms);
      return NextResponse.json({ quotes });
    }

    if (!single) {
      return NextResponse.json({ error: "symbol 또는 symbols 파라미터가 필요합니다." }, { status: 400 });
    }
    const q = await getKisUsQuote(single);
    if (!q) {
      return NextResponse.json(
        { error: `${single} 시세 없음 (미국 장 시간 외이거나 미지원 종목)` },
        { status: 404 },
      );
    }
    return NextResponse.json(q);
  } catch (e) {
    return NextResponse.json(
      { error: `KIS 시세 조회 실패: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
