import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchPrices } from "@/lib/market-prices";
import {
  buildTelegramBriefingHtml,
  collectMiniTrends,
  collectHoldTransitions,
  computeLivePortfolioKrw,
  computeOwnerDailyReturnsHybrid,
  computeOwnerTotalReturns,
  computeQuoteWeightedPortfolioReturnPct,
  type BriefingItem,
  type CostBasisPos,
  type QuoteWeightedOwnerInput,
} from "@/lib/briefing-message";
import { isKrxCommodity, isKrxListedEquityCode, toYahooSymbol } from "@/lib/finance-symbols";
import { todayKST, yesterdayKST, mmddKST, isKstWeekend } from "@/lib/date-utils";
import { analyzeFourSignals, type FourSignalsResult } from "@/lib/technical-signals";
import { isKrEquityTradingSessionDay, isUsEquityTradingSessionDay } from "@/lib/trading-calendar";
import { FALLBACK_USD_KRW, FALLBACK_EUR_KRW } from "@/lib/fx-fallback";

type Position = {
  symbol: string;
  name: string;
  owner: string;
  quantity?: number;
  currentPrice?: number;
  currency?: "USD" | "EUR" | "KRW";
  sector?: string;
  accountType?: string;
  chartGroup?: string;
};
type CashByOwner = Record<string, { usd: number; krw: number }>;

type Quote = {
  price: number | null;
  previousClose: number | null;
};

type AlertItem = {
  syncKey: string;
  symbol: string;
  name: string;
  sector: string;
  groupLabel: string;
  ownerLabel: string;
  price: number | null;
  changePct: number | null;
};

type MarketGroup = "DOMESTIC" | "OVERSEAS";
function resolveAlertGroupLabel(p: Position): string {
  const chartGroup = typeof p.chartGroup === "string" ? p.chartGroup.trim() : "";
  if (chartGroup) return chartGroup;
  return (p.name || p.symbol || "").trim() || "기타";
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function marketGroupOfSymbol(symbol: string): MarketGroup {
  const normalized = normalizeSymbol(symbol);
  if (isKrxCommodity(normalized)) return "DOMESTIC";
  if (normalized.startsWith("KRX:") || normalized.startsWith("KQ:")) return "DOMESTIC";
  // 6자리(005930, 0022T0)·7자리 A접두(A446770, A0173Y0) KRX 코드 모두 국내로
  if (isKrxListedEquityCode(normalized)) return "DOMESTIC";
  return "OVERSEAS";
}

function isMarketTradingDay(group: MarketGroup, at: Date): boolean {
  if (group === "DOMESTIC") return isKrEquityTradingSessionDay(at);
  return isUsEquityTradingSessionDay(at);
}

async function fetchYahooQuote(symbol: string): Promise<Quote> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { price: null, previousClose: null };
    const data = await res.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } };
    const meta = data.chart?.result?.[0]?.meta ?? {};

    const num = (k: string): number | null => {
      const v = meta[k];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    };

    const regularPrice = num("regularMarketPrice") ?? num("chartPreviousClose") ?? num("previousClose");

    // market state 판별 후 프리/애프터장 가격 우선 선택
    const state = typeof meta.marketState === "string" ? meta.marketState : null;
    let price: number | null;
    if (state === "PRE" || state === "PREPRE") {
      price = num("preMarketPrice") ?? regularPrice;
    } else if (state === "POST" || state === "POSTPOST" || state === "CLOSED") {
      price = num("postMarketPrice") ?? regularPrice;
    } else {
      price = regularPrice;
    }

    const prev = num("chartPreviousClose") ?? num("previousClose");
    return { price, previousClose: prev };
  } catch {
    return { price: null, previousClose: null };
  }
}

async function fetchNaverGoldQuote(): Promise<Quote> {
  try {
    const url = "https://finance.naver.com/marketindex/goldDailyQuote.nhn?page=1";
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { price: null, previousClose: null };
    const html = await res.text();
    const rows: number[] = [];
    const rowPattern = /<td class="date">\d{4}\.\d{2}\.\d{2}<\/td>\s*<td class="num">([\d,]+(?:\.\d+)?)<\/td>/g;
    let m: RegExpExecArray | null;
    while ((m = rowPattern.exec(html)) !== null && rows.length < 2) {
      const p = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(p) && p > 0) rows.push(p);
    }
    return { price: rows[0] ?? null, previousClose: rows[1] ?? null };
  } catch {
    return { price: null, previousClose: null };
  }
}

async function fetchNaverStockQuote(code: string): Promise<Quote> {
  try {
    const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/basic`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { price: null, previousClose: null };
    const d = await res.json() as Record<string, unknown>;
    const price = typeof d.closePrice === "string" ? parseFloat(d.closePrice.replace(/,/g, "")) : null;
    const change = typeof d.compareToPreviousClosePrice === "string"
      ? parseFloat(d.compareToPreviousClosePrice.replace(/,/g, ""))
      : null;
    if (!price || !Number.isFinite(price)) return { price: null, previousClose: null };
    return { price, previousClose: change !== null && Number.isFinite(change) ? price - change : null };
  } catch {
    return { price: null, previousClose: null };
  }
}

async function fetchQuoteForSymbol(input: string): Promise<Quote> {
  const s = input.trim().toUpperCase();
  if (isKrxCommodity(s)) return /^M040200/.test(s) ? fetchNaverGoldQuote() : { price: null, previousClose: null };
  if (/^[0-9][0-9A-Z]{5}$/.test(s)) return fetchNaverStockQuote(s);
  return fetchYahooQuote(toYahooSymbol(s));
}

async function sendTelegramMessage(text: string): Promise<{ ok: boolean; error?: string }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수 미설정" };
  }

  /** 브리핑은 escapeHtml로 이스케이프된 HTML만 사용 */
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    cache: "no-store",
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: `텔레그램 전송 실패: ${t.slice(0, 200)}` };
  }
  return { ok: true };
}


function normalizeCash(raw: unknown): CashByOwner {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: CashByOwner = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && "usd" in (v as object) && "krw" in (v as object)) {
      const u = (v as { usd: unknown; krw: unknown });
      out[k] = {
        usd: typeof u.usd === "number" && Number.isFinite(u.usd) ? u.usd : 0,
        krw: typeof u.krw === "number" && Number.isFinite(u.krw) ? u.krw : 0,
      };
    }
  }
  return out;
}

function normalizeDbPositions(raw: unknown): Array<{
  symbol: string;
  quantity: number;
  currentPrice: number;
  currency: "USD" | "EUR" | "KRW";
  owner: string;
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    symbol: string;
    quantity: number;
    currentPrice: number;
    currency: "USD" | "EUR" | "KRW";
    owner: string;
  }> = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const x = p as Record<string, unknown>;
    const sym = typeof x.symbol === "string" ? x.symbol : "";
    if (!sym) continue;
    const symNorm = sym.trim();
    const q = typeof x.quantity === "number" && Number.isFinite(x.quantity) ? x.quantity : 0;
    const cp = typeof x.currentPrice === "number" && Number.isFinite(x.currentPrice) ? x.currentPrice : 0;
    const cur = x.currency === "USD" || x.currency === "EUR" || x.currency === "KRW" ? x.currency : "KRW";
    const owner = typeof x.owner === "string" ? x.owner.trim() : "";
    out.push({ symbol: symNorm, quantity: q, currentPrice: cp, currency: cur, owner });
  }
  return out;
}

/** 총 수익률 계산용 — 매입단가·매입환율까지 보존 */
function normalizeCostPositions(raw: unknown): CostBasisPos[] {
  if (!Array.isArray(raw)) return [];
  const out: CostBasisPos[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const x = p as Record<string, unknown>;
    const sym = typeof x.symbol === "string" ? x.symbol.trim() : "";
    if (!sym) continue;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const numOrNull = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const cur = x.currency === "USD" || x.currency === "EUR" || x.currency === "KRW" ? x.currency : "KRW";
    out.push({
      symbol: sym,
      quantity: num(x.quantity),
      avgPrice: num(x.avgPrice),
      currentPrice: num(x.currentPrice),
      currency: cur,
      owner: typeof x.owner === "string" ? x.owner.trim() : "",
      purchaseUsdKrw: numOrNull(x.purchaseUsdKrw),
      purchaseEurKrw: numOrNull(x.purchaseEurKrw),
    });
  }
  return out;
}

/** Cron 쿼리 ?slot= 과 DB briefing_slot 값 (한국 시간 발송 시각) */
const BRIEFING_SLOT_LABELS: Record<string, string> = {
  /** 24:00 = 당일 자정 종료 시각 (= 익일 00:00 KST와 동일) */
  "0930": "09:30 KST",
  "1400": "14:00 KST",
  "2400": "24:00 KST",
  legacy: "일일(레거시)",
  manual: "수동 테스트",
};

function toBriefingItems(items: AlertItem[]): BriefingItem[] {
  return items.map((i) => ({
    symbol: i.symbol,
    name: i.name,
    sector: i.sector,
    groupLabel: i.groupLabel,
    ownerLabel: i.ownerLabel,
    price: i.price,
    changePct: i.changePct,
  }));
}

type WatchlistRow = { symbol: string; name?: string };

function parseWatchlist(raw: unknown): WatchlistRow[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchlistRow[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const sym = typeof o.symbol === "string" ? o.symbol.trim().toUpperCase() : "";
    if (sym.length < 1) continue;
    const name = typeof o.name === "string" ? o.name.trim() : undefined;
    out.push({ symbol: sym, ...(name ? { name } : {}) });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const briefingSlot = req.nextUrl.searchParams.get("slot") ?? "legacy";
  const slotLabel = BRIEFING_SLOT_LABELS[briefingSlot] ?? briefingSlot;

  const now = new Date();
  if (isKstWeekend(now)) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "kst_weekend",
      briefing_slot: briefingSlot,
      message: "KST 주말(토·일)에는 크론 텔레그램 자동 브리핑을 발송하지 않습니다.",
    });
  }

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });

  const alertSyncKey = process.env.TELEGRAM_ALERT_SYNC_KEY?.trim();
  if (!alertSyncKey || alertSyncKey.length < 8) {
    return NextResponse.json({
      ok: false,
      skipped: true,
      message:
        "TELEGRAM_ALERT_SYNC_KEY 미설정: 텔레그램 자동 발송을 건너뜁니다. Vercel 환경 변수에 본인 동기화 키(문자열)를 설정하세요.",
    });
  }

  const { data: snap, error: snapLoadErr } = await admin
    .from("portfolio_snapshots")
    .select("sync_key, positions, cash_by_owner, watchlist")
    .eq("sync_key", alertSyncKey)
    .maybeSingle();

  if (snapLoadErr) {
    const msg = snapLoadErr.message ?? "";
    if (msg.includes("watchlist") || msg.includes("column")) {
      return NextResponse.json(
        {
          error: "Supabase에 watchlist 컬럼이 없습니다. supabase/watchlist_column.sql 을 실행하세요.",
          detail: msg,
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (!snap) {
    return NextResponse.json({
      ok: false,
      message: `TELEGRAM_ALERT_SYNC_KEY(${alertSyncKey.slice(0, 4)}…)에 해당하는 portfolio_snapshots 행이 없습니다.`,
    });
  }

  const snaps = [snap];
  const dateKst = todayKST();

  const yst = yesterdayKST();
  const marketOpen = {
    DOMESTIC: isKrEquityTradingSessionDay(now),
    OVERSEAS: isUsEquityTradingSessionDay(now),
  } as const;

  const allSyms = new Set<string>();
  for (const snap of snaps) {
    for (const p of normalizeDbPositions(snap.positions)) {
      allSyms.add(p.symbol);
    }
  }
  const { quotes, usdKrw: fxUsd, eurKrw: fxEur } = await fetchPrices([...allSyms]);
  const usdKrw = fxUsd ?? FALLBACK_USD_KRW;
  const eurKrw = fxEur ?? FALLBACK_EUR_KRW;

  let todayLiveKrw = 0;
  let yesterdayPortfolioSum = 0;
  let hasYesterdayPortfolio = false;
  const ownerYesterdayTotals = new Map<string, number>();
  for (const snap of snaps) {
    const pos = normalizeDbPositions(snap.positions);
    const cash = normalizeCash(snap.cash_by_owner);
    todayLiveKrw += computeLivePortfolioKrw(pos, cash, quotes, usdKrw, eurKrw);

    const { data: yday } = await admin
      .from("portfolio_daily_snapshots")
      .select("total_value, owner_values")
      .eq("sync_key", String(snap.sync_key))
      .eq("date", yst)
      .maybeSingle();
    if (yday?.total_value != null && Number.isFinite(Number(yday.total_value))) {
      yesterdayPortfolioSum += Number(yday.total_value);
      hasYesterdayPortfolio = true;
    }
    const yOwners =
      yday?.owner_values && typeof yday.owner_values === "object" && !Array.isArray(yday.owner_values)
        ? (yday.owner_values as Record<string, unknown>)
        : null;
    if (yOwners) {
      for (const [owner, raw] of Object.entries(yOwners)) {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          ownerYesterdayTotals.set(owner, (ownerYesterdayTotals.get(owner) ?? 0) + n);
        }
      }
    }
  }

  const snapPortfolioChangePct =
    hasYesterdayPortfolio && yesterdayPortfolioSum > 0
      ? ((todayLiveKrw - yesterdayPortfolioSum) / yesterdayPortfolioSum) * 100
      : null;

  const sentSet = new Set<string>();
  const { data: logs } = await admin
    .from("price_move_alert_logs")
    .select("sync_key,symbol,date,briefing_slot")
    .eq("date", dateKst)
    .eq("briefing_slot", briefingSlot);
  for (const l of logs ?? []) {
    sentSet.add(`${l.sync_key}:${l.symbol}:${l.date}:${l.briefing_slot}`);
  }

  const items: AlertItem[] = [];
  const logRows: Array<{
    sync_key: string;
    symbol: string;
    date: string;
    change_pct: number | null;
    briefing_slot: string;
  }> = [];

  const quoteMemoBySymbol = new Map<string, Quote>();
  async function memoizedQuote(inputSymbol: string): Promise<Quote> {
    const k = inputSymbol.trim().toUpperCase();
    const hit = quoteMemoBySymbol.get(k);
    if (hit !== undefined) return hit;
    const q = await fetchQuoteForSymbol(inputSymbol);
    quoteMemoBySymbol.set(k, q);
    return q;
  }

  for (const snap of snaps) {
    const syncKey = String(snap.sync_key);
    const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Position[];

    const symbolMap = new Map<string, { ownerLabel: string; name: string; sector: string; groupLabel: string }>();
    for (const p of positions) {
      const owner = typeof p.owner === "string" ? p.owner.trim() : "";
      if (!owner) continue; // 보유자 이름 있는 모든 종목 대상 (보유자 하드코딩 제거)
      const keyedSymbol = `${owner}::${p.symbol}`;
      if (p.symbol && !symbolMap.has(keyedSymbol)) {
        symbolMap.set(keyedSymbol, {
          ownerLabel: owner,
          name: p.name || p.symbol,
          sector: p.sector || p.accountType || "기타",
          groupLabel: resolveAlertGroupLabel(p),
        });
      }
    }

    for (const [ownerSymbol, info] of symbolMap) {
      const symbol = ownerSymbol.split("::")[1] ?? "";
      if (!symbol) continue;
      const marketGroup = marketGroupOfSymbol(symbol);
      if (!isMarketTradingDay(marketGroup, now)) continue;
      const dedupeKey = `${syncKey}:${ownerSymbol}:${dateKst}:${briefingSlot}`;
      if (sentSet.has(dedupeKey)) continue;

      const q = await memoizedQuote(symbol);
      const pct =
        q.price && q.previousClose && q.previousClose > 0
          ? ((q.price - q.previousClose) / q.previousClose) * 100
          : null;

      items.push({
        syncKey,
        symbol,
        name: info.name,
        sector: info.sector,
        groupLabel: info.groupLabel,
        ownerLabel: info.ownerLabel,
        price: q.price,
        changePct: pct,
      });
      logRows.push({
        sync_key: syncKey,
        symbol: ownerSymbol,
        date: dateKst,
        change_pct: pct ?? null, // null = 시세 조회 실패
        briefing_slot: briefingSlot,
      });
    }
  }

  const posForHybrid = normalizeDbPositions(snap.positions);
  const cashForHybrid = normalizeCash(snap.cash_by_owner);
  const quoteWeights: QuoteWeightedOwnerInput[] = [];
  // 총수익률용 현재가: 배치 quotes에 종목별 라이브 시세(memoizedQuote)를 덮어써 정확도 보강
  // (배치 fetchPrices가 비면 스냅샷 저장가로 폴백돼 손익이 어긋나는 것 방지)
  const totalReturnQuotes: typeof quotes = { ...quotes };
  for (const row of posForHybrid) {
    const qRow = await memoizedQuote(row.symbol);
    if (typeof qRow.price === "number" && Number.isFinite(qRow.price) && qRow.price > 0) {
      totalReturnQuotes[row.symbol] = {
        price: qRow.price,
        currency: totalReturnQuotes[row.symbol]?.currency ?? null,
      };
    }
    const pctRow =
      qRow.price && qRow.previousClose && qRow.previousClose > 0
        ? ((qRow.price - qRow.previousClose) / qRow.previousClose) * 100
        : null;
    quoteWeights.push({ ownerLabel: row.owner.trim(), symbol: row.symbol, changePct: pctRow });
  }
  const yesterdayRecord =
    ownerYesterdayTotals.size > 0
      ? Object.fromEntries([...ownerYesterdayTotals.entries()].map(([k, v]) => [k.trim(), v]))
      : undefined;

  const quotePortfolioChangePct = computeQuoteWeightedPortfolioReturnPct(
    posForHybrid,
    cashForHybrid,
    quotes,
    usdKrw,
    eurKrw,
    quoteWeights,
  );

  const portfolioChangeVsYesterdayPct =
    quotePortfolioChangePct !== null &&
    (snapPortfolioChangePct === null || Math.abs(snapPortfolioChangePct) < 0.005)
      ? quotePortfolioChangePct
      : snapPortfolioChangePct ?? quotePortfolioChangePct;

  const ownerDailyReturns = computeOwnerDailyReturnsHybrid(
    posForHybrid,
    cashForHybrid,
    quotes,
    usdKrw,
    eurKrw,
    quoteWeights,
    yesterdayRecord,
  );

  const ownerTotalReturns = computeOwnerTotalReturns(
    normalizeCostPositions(snap.positions),
    cashForHybrid,
    totalReturnQuotes,
    usdKrw,
    eurKrw,
  );

  if (items.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "발송할 내용 없음 (영업일/보유 종목 없음 또는 이미 발송됨)",
      count: 0,
      briefing_slot: briefingSlot,
      marketOpen,
    });
  }

  async function sendHoldings(itemsForMessage: AlertItem[]): Promise<Response | null> {
    if (itemsForMessage.length === 0) return null;
    const briefingItems = toBriefingItems(itemsForMessage);
    const miniTrends = await collectMiniTrends(briefingItems);
    const holdTransitions = await collectHoldTransitions(briefingItems);
    const text = buildTelegramBriefingHtml({
      slotLabel,
      dateLabel: mmddKST(),
      portfolioChangeVsYesterdayPct,
      ownerDailyReturns,
      ownerTotalReturns,
      items: briefingItems,
      miniTrends,
      holdTransitions,
    });
    const send = await sendTelegramMessage(text);
    if (!send.ok) {
      return NextResponse.json({ error: send.error ?? "텔레그램 전송 실패" }, { status: 500 });
    }
    return null;
  }

  // 중복 방지 로그를 전송 전에 먼저 저장합니다.
  // 전송 중 실패해도 다음 크론에서 이미 로그된 종목은 건너뛰어 중복 발송을 방지합니다.
  if (logRows.length > 0) {
    await admin.from("price_move_alert_logs").upsert(logRows, {
      onConflict: "sync_key,symbol,date,briefing_slot",
    });
  }

  const holdingsSendError = await sendHoldings(items);
  if (holdingsSendError) return holdingsSendError;

  return NextResponse.json({
    ok: true,
    sentHoldings: items.length,
    sentHoldingsDomestic: items.filter((item) => marketGroupOfSymbol(item.symbol) === "DOMESTIC").length,
    sentHoldingsOverseas: items.filter((item) => marketGroupOfSymbol(item.symbol) === "OVERSEAS").length,
    sentWatchlist: 0,
    sentWatchlistDomestic: 0,
    sentWatchlistOverseas: 0,
    briefing_slot: briefingSlot,
    marketOpen,
  });
}

/**
 * POST /api/alert/kakao-price-move  { sync_key: string, dry_run?: boolean, force_resend?: boolean }
 *
 * 수동 테스트용. sync_key 소유자의 종목만 체크합니다.
 * dry_run: true → 실제 전송 없이 점검 결과만 반환 (기본값 true)
 * dry_run: false → 실제로 텔레그램 전송 (기본: 오늘 manual 슬롯으로 이미 보낸 종목은 건너뜀)
 * force_resend: true → manual 중복 기록을 무시하고 전 종목 다시 전송 (UI 테스트 버튼에서 사용)
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }
  const b = body as { sync_key?: unknown; dry_run?: unknown; force_resend?: unknown };
  const syncKey = typeof b.sync_key === "string" ? b.sync_key : null;
  if (!syncKey || syncKey.length < 8) {
    return NextResponse.json({ error: "sync_key가 필요합니다." }, { status: 400 });
  }
  const dryRun = b.dry_run !== false; // 기본값 true (실전 전송 안 함)
  const forceResend = b.force_resend === true;
  const now = new Date();
  const marketOpen = {
    DOMESTIC: isKrEquityTradingSessionDay(now),
    OVERSEAS: isUsEquityTradingSessionDay(now),
  } as const;

  // 환경변수 점검
  const hasBotToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasChatId = !!process.env.TELEGRAM_CHAT_ID;
  if (!hasBotToken || !hasChatId) {
    return NextResponse.json({
      ok: false,
      error: "Vercel 환경변수 미설정",
      detail: {
        TELEGRAM_BOT_TOKEN: hasBotToken ? "✅ 설정됨" : "❌ 미설정",
        TELEGRAM_CHAT_ID: hasChatId ? "✅ 설정됨" : "❌ 미설정",
      },
    }, { status: 500 });
  }

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });

  const { data: snap, error: snapErr } = await admin
    .from("portfolio_snapshots")
    .select("positions, cash_by_owner, watchlist")
    .eq("sync_key", syncKey)
    .maybeSingle();

  if (snapErr) {
    const msg = snapErr.message ?? "";
    if (msg.includes("watchlist") || msg.includes("column")) {
      return NextResponse.json(
        { error: "Supabase에 watchlist 컬럼이 없습니다. supabase/watchlist_column.sql 을 실행하세요.", detail: msg },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (!snap) return NextResponse.json({ error: "portfolio_snapshots에 해당 sync_key가 없습니다." }, { status: 404 });

  const watchEntries = parseWatchlist(snap.watchlist);

  const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Position[];

  // 종목별 대표 정보 추출
  const symbolMap = new Map<string, { ownerLabel: string; name: string; sector: string; groupLabel: string }>();
  for (const p of positions) {
    const owner = typeof p.owner === "string" ? p.owner.trim() : "";
    if (!owner) continue; // 보유자 이름 있는 모든 종목 대상 (보유자 하드코딩 제거)
    const keyedSymbol = `${owner}::${p.symbol}`;
    if (p.symbol && !symbolMap.has(keyedSymbol)) {
      symbolMap.set(keyedSymbol, {
        ownerLabel: owner,
        name: p.name || p.symbol,
        sector: p.sector || p.accountType || "기타",
        groupLabel: resolveAlertGroupLabel(p),
      });
    }
  }

  const dateKst = todayKST();
  const manualSlot = "manual";
  const results: Array<{ symbol: string; name: string; price: number | null; previousClose: number | null; changePct: number | null; willAlert: boolean; sector: string }> = [];
  const items: AlertItem[] = [];
  const logRows: Array<{
    sync_key: string;
    symbol: string;
    date: string;
    change_pct: number | null;
    briefing_slot: string;
  }> = [];

  // 오늘 수동 발송으로 이미 기록된 종목 확인 (Cron 슬롯과 별개). force_resend면 스킵
  let alreadySent = new Set<string>();
  if (!forceResend) {
    const { data: logs } = await admin
      .from("price_move_alert_logs")
      .select("symbol")
      .eq("sync_key", syncKey)
      .eq("date", dateKst)
      .eq("briefing_slot", manualSlot);
    alreadySent = new Set((logs ?? []).map((l) => l.symbol));
  }

  const postQuoteMemoBySymbol = new Map<string, Quote>();
  async function postMemoizedQuote(inputSymbol: string): Promise<Quote> {
    const k = inputSymbol.trim().toUpperCase();
    const hit = postQuoteMemoBySymbol.get(k);
    if (hit !== undefined) return hit;
    const q = await fetchQuoteForSymbol(inputSymbol);
    postQuoteMemoBySymbol.set(k, q);
    return q;
  }

  for (const [ownerSymbol, info] of symbolMap) {
    const symbol = ownerSymbol.split("::")[1] ?? "";
    if (!symbol) continue;
    const marketGroup = marketGroupOfSymbol(symbol);
    if (!isMarketTradingDay(marketGroup, now)) {
      results.push({
        symbol,
        name: info.name,
        price: null,
        previousClose: null,
        changePct: null,
        willAlert: false,
        sector: info.sector,
      });
      continue;
    }
    const q = await postMemoizedQuote(symbol);
    const pct = (q.price && q.previousClose && q.previousClose > 0)
      ? ((q.price - q.previousClose) / q.previousClose) * 100
      : null;
    const willAlert = !alreadySent.has(ownerSymbol); // 보유자+종목 단위 중복 방지
    results.push({ symbol, name: info.name, price: q.price, previousClose: q.previousClose, changePct: pct, willAlert, sector: info.sector });
    if (willAlert) {
      items.push({
        syncKey,
        symbol,
        name: info.name,
        sector: info.sector,
        groupLabel: info.groupLabel,
        ownerLabel: info.ownerLabel,
        price: q.price,
        changePct: pct,
      });
      logRows.push({
        sync_key: syncKey,
        symbol: ownerSymbol,
        date: dateKst,
        change_pct: pct ?? null, // null = 시세 조회 실패
        briefing_slot: manualSlot,
      });
    }
  }

  const watchlistPreview: FourSignalsResult[] = [];
  for (const w of watchEntries) {
    if (!isMarketTradingDay(marketGroupOfSymbol(w.symbol), now)) continue;
    const label = w.name && w.name.length > 0 ? w.name : w.symbol;
    watchlistPreview.push(await analyzeFourSignals(w.symbol, label));
    await new Promise((r) => setTimeout(r, 80));
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      date: dateKst,
      env: { TELEGRAM_BOT_TOKEN: "✅", TELEGRAM_CHAT_ID: "✅" },
      symbols: results,
      alertCount: items.length,
      alreadySentToday: [...alreadySent],
      watchlistCount: watchlistPreview.length,
      watchlistSignals: watchlistPreview,
      marketOpen,
      message:
        items.length > 0 || watchlistPreview.length > 0
          ? `보유 ${items.length}종목 · 관심 ${watchlistPreview.length}종목 발송 예정(실전 전송 아님)`
          : "오늘 영업일 기준 발송 대상 없음 또는 이미 발송됨",
    });
  }

  // dry_run: false → 실제 전송 (관심종목 별도 텔레그램은 발송하지 않음)
  if (items.length === 0) {
    return NextResponse.json({
      ok: true,
      dry_run: false,
      message: "발송할 내용 없음 (보유 종목 없음 또는 이미 발송됨)",
      count: 0,
      marketOpen,
    });
  }

  const posNorm = normalizeDbPositions(snap.positions);
  const allSyms = [...new Set(posNorm.map((p) => p.symbol))];
  const { quotes, usdKrw: pUsd, eurKrw: pEur } = await fetchPrices(allSyms);
  const usdK = pUsd ?? FALLBACK_USD_KRW;
  const eurK = pEur ?? FALLBACK_EUR_KRW;
  const cashNorm = normalizeCash(snap.cash_by_owner);
  const todayLiveKrw = computeLivePortfolioKrw(posNorm, cashNorm, quotes, usdK, eurK);

  const { data: ydayRow } = await admin
    .from("portfolio_daily_snapshots")
    .select("total_value, owner_values")
    .eq("sync_key", syncKey)
    .eq("date", yesterdayKST())
    .maybeSingle();
  const yVal = ydayRow?.total_value != null && Number.isFinite(Number(ydayRow.total_value))
    ? Number(ydayRow.total_value)
    : null;
  const snapPortfolioChangePct = yVal !== null && yVal > 0 ? ((todayLiveKrw - yVal) / yVal) * 100 : null;
  const yOwners =
    ydayRow?.owner_values && typeof ydayRow.owner_values === "object" && !Array.isArray(ydayRow.owner_values)
      ? (ydayRow.owner_values as Record<string, unknown>)
      : null;
  const yesterdayRecordManual =
    yOwners && typeof yOwners === "object"
      ? Object.fromEntries(
          Object.entries(yOwners)
            .map(([k, v]) => [k.trim(), Number(v)] as [string, number])
            .filter(([, n]) => Number.isFinite(n)),
        )
      : undefined;
  const quoteWeightsManual: QuoteWeightedOwnerInput[] = [];
  // 총수익률용 현재가: 배치 quotes에 종목별 라이브 시세를 덮어써 정확도 보강
  const totalReturnQuotes: typeof quotes = { ...quotes };
  for (const row of posNorm) {
    const qRow = await postMemoizedQuote(row.symbol);
    if (typeof qRow.price === "number" && Number.isFinite(qRow.price) && qRow.price > 0) {
      totalReturnQuotes[row.symbol] = {
        price: qRow.price,
        currency: totalReturnQuotes[row.symbol]?.currency ?? null,
      };
    }
    const pctRow =
      qRow.price && qRow.previousClose && qRow.previousClose > 0
        ? ((qRow.price - qRow.previousClose) / qRow.previousClose) * 100
        : null;
    quoteWeightsManual.push({ ownerLabel: row.owner.trim(), symbol: row.symbol, changePct: pctRow });
  }
  const quotePortfolioChangePct = computeQuoteWeightedPortfolioReturnPct(
    posNorm,
    cashNorm,
    quotes,
    usdK,
    eurK,
    quoteWeightsManual,
  );
  const portfolioChangeVsYesterdayPct =
    quotePortfolioChangePct !== null &&
    (snapPortfolioChangePct === null || Math.abs(snapPortfolioChangePct) < 0.005)
      ? quotePortfolioChangePct
      : snapPortfolioChangePct ?? quotePortfolioChangePct;

  const ownerDailyReturns = computeOwnerDailyReturnsHybrid(
    posNorm,
    cashNorm,
    quotes,
    usdK,
    eurK,
    quoteWeightsManual,
    yesterdayRecordManual,
  );

  const ownerTotalReturns = computeOwnerTotalReturns(
    normalizeCostPositions(snap.positions),
    cashNorm,
    totalReturnQuotes,
    usdK,
    eurK,
  );

  async function sendHoldings(itemsForMessage: AlertItem[]): Promise<Response | null> {
    if (itemsForMessage.length === 0) return null;
    const briefingItems = toBriefingItems(itemsForMessage);
    const miniTrends = await collectMiniTrends(briefingItems);
    const holdTransitions = await collectHoldTransitions(briefingItems);
    const text = buildTelegramBriefingHtml({
      slotLabel: BRIEFING_SLOT_LABELS.manual,
      dateLabel: mmddKST(),
      portfolioChangeVsYesterdayPct,
      ownerDailyReturns,
      ownerTotalReturns,
      items: briefingItems,
      miniTrends,
      holdTransitions,
    });
    const send = await sendTelegramMessage(text);
    if (!send.ok) return NextResponse.json({ ok: false, error: send.error }, { status: 500 });
    return null;
  }

  const holdingsSendError = await sendHoldings(items);
  if (holdingsSendError) return holdingsSendError;

  await admin.from("price_move_alert_logs").upsert(logRows, {
    onConflict: "sync_key,symbol,date,briefing_slot",
  });

  return NextResponse.json({
    ok: true,
    dry_run: false,
    sentHoldings: items.length,
    sentHoldingsDomestic: items.filter((item) => marketGroupOfSymbol(item.symbol) === "DOMESTIC").length,
    sentHoldingsOverseas: items.filter((item) => marketGroupOfSymbol(item.symbol) === "OVERSEAS").length,
    sentWatchlist: 0,
    sentWatchlistDomestic: 0,
    sentWatchlistOverseas: 0,
    marketOpen,
    items,
  });
}

/*
 * 기존 POST 구현이 아래에 중복으로 남지 않도록 정리됨
 */
