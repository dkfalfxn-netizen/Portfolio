import { NextResponse } from "next/server";
import { getKisUsIntraday, getKisUsQuote, kisCredentialsConfigured, usSessionProgress } from "@/lib/kis-quote";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 미국 종목 일중(1분봉) 차트 — KIS. 세션에 맞춰 데이장/정규장 봉을 돌려준다.
 *  GET /api/overseas/intraday?symbols=SOXX,MU,SNDK → { intraday: { SOXX: number[] }, meta: { SOXX: { progress, prevClose } } }
 *  progress = 세션 진행률(0~1), prevClose = 점선 기준선(전일 종가)
 * 빈 배열은 "오늘 봉 없음"(차트 대신 —). KIS 미설정(503)·조회 실패 종목은 생략 → 클라이언트는 Yahoo 차트로 폴백.
 */
export async function GET(req: Request) {
  if (!kisCredentialsConfigured()) {
    return NextResponse.json({ error: "KIS 환경변수 미설정" }, { status: 503 });
  }
  const syms = [
    ...new Set(
      (new URL(req.url).searchParams.get("symbols") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 30);
  const intraday: Record<string, number[]> = {};
  const meta: Record<string, { progress: number; prevClose: number | null }> = {};
  const progress = usSessionProgress();
  await Promise.all(
    syms.map(async (s) => {
      try {
        const pts = await getKisUsIntraday(s);
        if (!pts) return;
        intraday[s] = pts; // [] = 데이장 개장 전(전날 차트 숨김)
        // 기준선(전일 종가) — 실패해도 차트는 그림
        const q = await getKisUsQuote(s).catch(() => null);
        meta[s] = { progress, prevClose: q && q.prevClose > 0 ? q.prevClose : null };
      } catch {
        /* 종목별 실패는 생략 */
      }
    }),
  );
  return NextResponse.json({ intraday, meta });
}
