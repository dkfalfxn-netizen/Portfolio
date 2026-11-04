import { NextResponse } from "next/server";
import { getKisUsIntraday, kisCredentialsConfigured } from "@/lib/kis-quote";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 미국 종목 일중(1분봉) 차트 — KIS. 세션에 맞춰 데이장/정규장 봉을 돌려준다.
 *  GET /api/overseas/intraday?symbols=SOXX,MU,SNDK → { intraday: { SOXX: number[], ... } }
 * KIS 미설정(503)·시세 없음인 종목은 생략 → 클라이언트는 Yahoo 차트로 폴백.
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
  await Promise.all(
    syms.map(async (s) => {
      try {
        const pts = await getKisUsIntraday(s);
        if (pts && pts.length >= 2) intraday[s] = pts;
      } catch {
        /* 종목별 실패는 생략 */
      }
    }),
  );
  return NextResponse.json({ intraday });
}
