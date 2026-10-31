import { NextRequest, NextResponse } from "next/server";
import { getKisUsQuote, kisCredentialsConfigured, usMarketSession } from "@/lib/kis-quote";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 디버그용(읽기 전용): 미국 종목 시세를 KIS·Yahoo 양쪽에서 가져와 비교한다.
 * 애프터/프리장에 가격이 안 맞을 때 장중에 /api/debug/price-compare?symbol=NVDA 로 열어 어느 쪽이 정규장 종가에 머무는지 확인.
 * 비밀값은 응답에 포함하지 않는다(공개 시세만).
 */
function etString(sec: number | null | undefined): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(sec * 1000)) + " ET";
}

const pos = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "NVDA").trim().toUpperCase();
  const nowSec = Math.floor(Date.now() / 1000);

  // ── Yahoo: 앱(/api/market)과 같은 요청(1분봉·프리/애프터 포함)
  let yahoo: Record<string, unknown> = {};
  let yahooLast: number | null = null;
  let yahooRegular: number | null = null;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`,
      { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } },
    );
    if (!res.ok) {
      yahoo = { error: `HTTP ${res.status}` };
    } else {
      const data = (await res.json()) as {
        chart?: {
          result?: Array<{
            meta?: Record<string, unknown>;
            timestamp?: number[];
            indicators?: { quote?: Array<{ close?: Array<number | null> }> };
          }>;
        };
      };
      const r = data.chart?.result?.[0];
      const meta = r?.meta ?? {};
      const closes = r?.indicators?.quote?.[0]?.close ?? [];
      const ts = r?.timestamp ?? [];
      let lastIdx = -1;
      for (let i = closes.length - 1; i >= 0; i--) {
        if (typeof closes[i] === "number" && (closes[i] as number) > 0) {
          lastIdx = i;
          break;
        }
      }
      yahooLast = lastIdx >= 0 ? (closes[lastIdx] as number) : null;
      yahooRegular = pos(meta.regularMarketPrice);
      const periods = meta.currentTradingPeriod as
        | { pre?: { start: number; end: number }; regular?: { start: number; end: number }; post?: { start: number; end: number } }
        | undefined;
      yahoo = {
        metaMarketState: meta.marketState ?? null,
        regularMarketPrice: yahooRegular,
        regularMarketTime: etString(meta.regularMarketTime as number),
        postMarketPrice: pos(meta.postMarketPrice),
        preMarketPrice: pos(meta.preMarketPrice),
        chartPreviousClose: pos(meta.chartPreviousClose),
        lastCandlePrice: yahooLast,
        lastCandleTime: lastIdx >= 0 ? etString(ts[lastIdx]) : null,
        candleCount: closes.filter((c) => typeof c === "number").length,
        periodsET: periods
          ? {
              pre: `${etString(periods.pre?.start)} ~ ${etString(periods.pre?.end)}`,
              regular: `${etString(periods.regular?.start)} ~ ${etString(periods.regular?.end)}`,
              post: `${etString(periods.post?.start)} ~ ${etString(periods.post?.end)}`,
            }
          : null,
      };
    }
  } catch (e) {
    yahoo = { error: e instanceof Error ? e.message : String(e) };
  }

  // ── KIS: 앱(/api/overseas/daytime-price)과 같은 함수
  let kis: Record<string, unknown> = {};
  let kisPrice: number | null = null;
  if (!kisCredentialsConfigured()) {
    kis = { error: "KIS_APP_KEY/KIS_APP_SECRET 미설정" };
  } else {
    try {
      const q = await getKisUsQuote(symbol);
      if (q) {
        kisPrice = q.price;
        kis = { price: q.price, prevClose: q.prevClose, change: q.change, changeRate: q.changeRate, exchangeCode: q.excd, fetchedAt: q.asOf };
      } else {
        kis = { price: null, note: "시세 없음(응답 없음/0원)" };
      }
    } catch (e) {
      kis = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 진단: 대시보드는 KIS 값이 있으면 항상 KIS 를 쓴다
  const hints: string[] = [];
  if (kisPrice !== null && yahooLast !== null && yahooRegular !== null) {
    const same = (a: number, b: number) => Math.abs(a - b) / b < 0.0005;
    if (same(kisPrice, yahooRegular) && !same(yahooLast, yahooRegular)) {
      hints.push("KIS 가격이 정규장 종가와 같고, Yahoo 마지막 체결은 다름 → KIS가 시간외 가격을 못 따라가는 것으로 보임(대시보드는 KIS를 우선 사용 중)");
    } else if (!same(kisPrice, yahooLast)) {
      hints.push(`KIS(${kisPrice})와 Yahoo 마지막 체결(${yahooLast})이 다름 — 어느 쪽이 실제 시간외 체결가인지 증권사 앱과 대조 필요`);
    } else {
      hints.push("KIS와 Yahoo 마지막 체결가가 일치");
    }
  }

  return NextResponse.json({
    symbol,
    nowET: etString(nowSec),
    appKisSession: usMarketSession() === "regular" ? "regular(NAS/NYS/AMS 라이브: 프리 04:00~애프터 20:00 ET)" : "extended(BAQ/BAY/BAA 주간거래/야간)",
    dashboardUses: kisPrice !== null ? { source: "KIS", price: kisPrice } : { source: "Yahoo", price: yahooLast ?? yahooRegular },
    kis,
    yahoo,
    hints,
  });
}
