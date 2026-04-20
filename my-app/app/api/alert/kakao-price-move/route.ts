import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchPrices } from "@/lib/market-prices";
import {
  buildTelegramBriefingHtml,
  collectMiniTrends,
  collectHoldTransitions,
  computeLivePortfolioKrw,
  type BriefingItem,
} from "@/lib/briefing-message";
import { isKrxCommodity, toYahooSymbol } from "@/lib/finance-symbols";
import { analyzeFourSignals, type FourSignalsResult } from "@/lib/technical-signals";
import { isKrEquityTradingSessionDay, isUsEquityTradingSessionDay } from "@/lib/trading-calendar";

type Position = {
  symbol: string;
  name: string;
  owner: string;
  quantity?: number;
  currentPrice?: number;
  currency?: "USD" | "EUR" | "KRW";
  sector?: string;
  accountType?: string;
};
type CashByOwner = Record<string, { usd: number; krw: number }>;

type Quote = {
  price: number | null;
  previousClose: number | null;
};

type OwnerValueMap = Record<string, number>;

type AlertItem = {
  syncKey: string;
  symbol: string;
  name: string;
  sector: string;
  price: number | null;
  changePct: number | null;
};

type MarketGroup = "DOMESTIC" | "OVERSEAS";

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function marketGroupOfSymbol(symbol: string): MarketGroup {
  const normalized = normalizeSymbol(symbol);
  if (isKrxCommodity(normalized)) return "DOMESTIC";
  if (normalized.startsWith("KRX:") || normalized.startsWith("KQ:")) return "DOMESTIC";
  if (/^[0-9][0-9A-Z]{5}$/.test(normalized)) return "DOMESTIC";
  return "OVERSEAS";
}

function isMarketTradingDay(group: MarketGroup, at: Date): boolean {
  if (group === "DOMESTIC") return isKrEquityTradingSessionDay(at);
  return isUsEquityTradingSessionDay(at);
}

async function fetchYahooQuote(symbol: string): Promise<Quote> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { price: null, previousClose: null };
    const data = await res.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } };
    const meta = data.chart?.result?.[0]?.meta ?? {};
    const price = ["regularMarketPrice", "postMarketPrice", "preMarketPrice", "chartPreviousClose", "previousClose"]
      .map((k) => meta[k])
      .find((v) => typeof v === "number" && Number.isFinite(v) && v > 0) as number | undefined;
    const prev = ["chartPreviousClose", "previousClose"]
      .map((k) => meta[k])
      .find((v) => typeof v === "number" && Number.isFinite(v) && v > 0) as number | undefined;
    return { price: price ?? null, previousClose: prev ?? null };
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

function todayKST(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 전일 KST 날짜 (일별 스냅·전일대비용) */
function yesterdayKST(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 - 86400000).toISOString().slice(0, 10);
}

function mmddKST(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
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
    const q = typeof x.quantity === "number" && Number.isFinite(x.quantity) ? x.quantity : 0;
    const cp = typeof x.currentPrice === "number" && Number.isFinite(x.currentPrice) ? x.currentPrice : 0;
    const cur = x.currency === "USD" || x.currency === "EUR" || x.currency === "KRW" ? x.currency : "KRW";
    const owner = typeof x.owner === "string" ? x.owner : "";
    out.push({ symbol: sym, quantity: q, currentPrice: cp, currency: cur, owner });
  }
  return out;
}

function computeOwnerLiveValuesKrw(
  positions: Array<{
    symbol: string;
    quantity: number;
    currentPrice: number;
    currency: "USD" | "EUR" | "KRW";
    owner: string;
  }>,
  cashByOwner: CashByOwner,
  quotes: Record<string, { price?: number | null } | undefined>,
  usdKrw: number,
  eurKrw: number,
): OwnerValueMap {
  const owners = [...new Set([...positions.map((p) => p.owner), ...Object.keys(cashByOwner)])];
  const out: OwnerValueMap = {};

  for (const owner of owners) {
    const cash = cashByOwner[owner] ?? { usd: 0, krw: 0 };
    let sum = cash.krw + cash.usd * usdKrw;
    for (const p of positions) {
      if (p.owner !== owner) continue;
      const q = quotes[p.symbol];
      const price =
        typeof q?.price === "number" && Number.isFinite(q.price) && q.price > 0
          ? q.price
          : p.currentPrice;
      if (p.currency === "USD") sum += p.quantity * price * usdKrw;
      else if (p.currency === "EUR") sum += p.quantity * price * eurKrw;
      else sum += p.quantity * price;
    }
    out[owner] = sum;
  }

  return out;
}

/** Cron 쿼리 ?slot= 과 DB briefing_slot 값 (한국 시간 발송 시각) */
const BRIEFING_SLOT_LABELS: Record<string, string> = {
  "0100": "01:00 KST",
  "0930": "09:30 KST",
  "1200": "12:00 KST",
  "1540": "15:40 KST",
  "2300": "23:00 KST",
  legacy: "일일(레거시)",
  manual: "수동 테스트",
};

function toBriefingItems(items: AlertItem[]): BriefingItem[] {
  return items.map((i) => ({
    symbol: i.symbol,
    name: i.name,
    sector: i.sector,
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

function overallLabelKo(o: FourSignalsResult["overall"]): string {
  switch (o) {
    case "STRONG_BUY":
      return "강한 매수 참고";
    case "BUY":
      return "매수 참고";
    case "WAIT":
      return "관망";
    case "CAUTION":
      return "주의";
    case "HOLD":
    default:
      return "HOLD";
  }
}

async function buildWatchlistTelegramBlock(entries: WatchlistRow[]): Promise<string> {
  if (entries.length === 0) return "";
  const now = mmddKST();
  let t = `⭐ <b>관심종목 매수 타이밍 참고</b> (${now})\n`;
  t += "MA·RSI·볼린저·거래량 기준 (참고용, 투자 권유 아님)\n\n";
  for (const e of entries) {
    const label = e.name && e.name.length > 0 ? e.name : e.symbol;
    const sig = await analyzeFourSignals(e.symbol, label);
    const line =
      `● ${sig.name} (<code>${sig.symbol}</code>)\n` +
      `<b>${overallLabelKo(sig.overall)}</b>\n` +
      `MA:${sig.ma} RSI:${sig.rsi} BB:${sig.bb} VOL:${sig.vol}\n` +
      `${sig.summaryKo}` +
      (sig.rsi14 != null ? ` (RSI ${sig.rsi14.toFixed(1)})` : "") +
      (sig.error ? `\n⚠️ ${sig.error}` : "") +
      "\n\n";
    t += line;
    await new Promise((r) => setTimeout(r, 120));
  }
  return t.trimEnd();
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
  const watchEntries = parseWatchlist(snap.watchlist);

  const dateKst = todayKST();
  const yst = yesterdayKST();
  const now = new Date();
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
  const usdKrw = fxUsd ?? 1400;
  const eurKrw = fxEur ?? 1500;

  let todayLiveKrw = 0;
  let yesterdayPortfolioSum = 0;
  let hasYesterdayPortfolio = false;
  const ownerLiveTotals = new Map<string, number>();
  const ownerYesterdayTotals = new Map<string, number>();
  for (const snap of snaps) {
    const pos = normalizeDbPositions(snap.positions);
    const cash = normalizeCash(snap.cash_by_owner);
    todayLiveKrw += computeLivePortfolioKrw(pos, cash, quotes, usdKrw, eurKrw);
    const ownerLive = computeOwnerLiveValuesKrw(pos, cash, quotes, usdKrw, eurKrw);
    for (const [owner, value] of Object.entries(ownerLive)) {
      ownerLiveTotals.set(owner, (ownerLiveTotals.get(owner) ?? 0) + value);
    }

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

  const portfolioChangeVsYesterdayPct =
    hasYesterdayPortfolio && yesterdayPortfolioSum > 0
      ? ((todayLiveKrw - yesterdayPortfolioSum) / yesterdayPortfolioSum) * 100
      : null;
  const ownerDailyReturns = [...ownerLiveTotals.entries()]
    .map(([owner, today]) => {
      const y = ownerYesterdayTotals.get(owner);
      const changePct = y !== undefined && y > 0 ? ((today - y) / y) * 100 : null;
      return { owner, changePct };
    })
    .sort((a, b) => a.owner.localeCompare(b.owner, "ko"));

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
    change_pct: number;
    briefing_slot: string;
  }> = [];

  for (const snap of snaps) {
    const syncKey = String(snap.sync_key);
    const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Position[];

    const symbolMap = new Map<string, { name: string; sector: string }>();
    for (const p of positions) {
      if (p.symbol && !symbolMap.has(p.symbol)) {
        symbolMap.set(p.symbol, {
          name: p.name || p.symbol,
          sector: p.sector || p.accountType || "기타",
        });
      }
    }

    for (const [symbol, info] of symbolMap) {
      const marketGroup = marketGroupOfSymbol(symbol);
      if (!isMarketTradingDay(marketGroup, now)) continue;

      const dedupeKey = `${syncKey}:${symbol}:${dateKst}:${briefingSlot}`;
      if (sentSet.has(dedupeKey)) continue;

      const q = await fetchQuoteForSymbol(symbol);
      const pct = (q.price && q.previousClose && q.previousClose > 0)
        ? ((q.price - q.previousClose) / q.previousClose) * 100
        : null;

      items.push({
        syncKey,
        symbol,
        name: info.name,
        sector: info.sector,
        price: q.price,
        changePct: pct,
      });
      logRows.push({
        sync_key: syncKey,
        symbol,
        date: dateKst,
        change_pct: pct ?? 0,
        briefing_slot: briefingSlot,
      });
    }
  }

  const domesticItems = items.filter((item) => marketGroupOfSymbol(item.symbol) === "DOMESTIC");
  const overseasItems = items.filter((item) => marketGroupOfSymbol(item.symbol) === "OVERSEAS");
  const domesticWatchEntries = watchEntries.filter((w) => marketGroupOfSymbol(w.symbol) === "DOMESTIC");
  const overseasWatchEntries = watchEntries.filter((w) => marketGroupOfSymbol(w.symbol) === "OVERSEAS");

  const eligibleWatchCount =
    (marketOpen.DOMESTIC ? domesticWatchEntries.length : 0) +
    (marketOpen.OVERSEAS ? overseasWatchEntries.length : 0);

  if (items.length === 0 && eligibleWatchCount === 0) {
    return NextResponse.json({
      ok: true,
      message: "발송할 내용 없음 (영업일/보유·관심 기준)",
      count: 0,
      briefing_slot: briefingSlot,
      marketOpen,
    });
  }

  async function sendHoldingsByMarket(itemsForMarket: AlertItem[], label: string): Promise<Response | null> {
    if (itemsForMarket.length === 0) return null;
    const briefingItems = toBriefingItems(itemsForMarket);
    const miniTrends = await collectMiniTrends(briefingItems);
    const holdTransitions = await collectHoldTransitions(briefingItems);
    const text = buildTelegramBriefingHtml({
      slotLabel: `${slotLabel} · ${label}`,
      dateLabel: mmddKST(),
      portfolioChangeVsYesterdayPct,
      ownerDailyReturns,
      items: briefingItems,
      miniTrends,
      holdTransitions,
    });
    const send = await sendTelegramMessage(text);
    if (!send.ok) {
      return NextResponse.json({ error: send.error ?? `${label} 텔레그램 전송 실패` }, { status: 500 });
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

  const domesticSendError = await sendHoldingsByMarket(domesticItems, "국내주식");
  if (domesticSendError) return domesticSendError;
  const overseasSendError = await sendHoldingsByMarket(overseasItems, "해외주식");
  if (overseasSendError) return overseasSendError;

  async function sendWatchlistByMarket(entries: WatchlistRow[], label: string): Promise<Response | null> {
    if (entries.length === 0) return null;
    const block = await buildWatchlistTelegramBlock(entries);
    if (!block) return null;
    const text = `⭐ <b>${label} 관심종목</b>\n\n${block}`;
    const send = await sendTelegramMessage(text);
    if (!send.ok) {
      return NextResponse.json({ error: send.error ?? `${label} 관심종목 텔레그램 전송 실패` }, { status: 500 });
    }
    return null;
  }

  if (marketOpen.DOMESTIC) {
    const watchSendError = await sendWatchlistByMarket(domesticWatchEntries, "국내주식");
    if (watchSendError) return watchSendError;
  }
  if (marketOpen.OVERSEAS) {
    const watchSendError = await sendWatchlistByMarket(overseasWatchEntries, "해외주식");
    if (watchSendError) return watchSendError;
  }

  return NextResponse.json({
    ok: true,
    sentHoldings: items.length,
    sentHoldingsDomestic: domesticItems.length,
    sentHoldingsOverseas: overseasItems.length,
    sentWatchlist: eligibleWatchCount,
    sentWatchlistDomestic: marketOpen.DOMESTIC ? domesticWatchEntries.length : 0,
    sentWatchlistOverseas: marketOpen.OVERSEAS ? overseasWatchEntries.length : 0,
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
  const symbolMap = new Map<string, { name: string; sector: string }>();
  for (const p of positions) {
    if (p.symbol && !symbolMap.has(p.symbol)) {
      symbolMap.set(p.symbol, {
        name: p.name || p.symbol,
        sector: p.sector || p.accountType || "기타",
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
    change_pct: number;
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

  for (const [symbol, info] of symbolMap) {
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

    const q = await fetchQuoteForSymbol(symbol);
    const pct = (q.price && q.previousClose && q.previousClose > 0)
      ? ((q.price - q.previousClose) / q.previousClose) * 100
      : null;
    const willAlert = !alreadySent.has(symbol); // 모든 종목 발송 (중복 방지만, force_resend 시 무시)
    results.push({ symbol, name: info.name, price: q.price, previousClose: q.previousClose, changePct: pct, willAlert, sector: info.sector });
    if (willAlert) {
      items.push({
        syncKey,
        symbol,
        name: info.name,
        sector: info.sector,
        price: q.price,
        changePct: pct,
      });
      logRows.push({
        sync_key: syncKey,
        symbol,
        date: dateKst,
        change_pct: pct ?? 0,
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

  // dry_run: false → 실제 전송
  if (items.length === 0 && watchlistPreview.length === 0) {
    return NextResponse.json({ ok: true, dry_run: false, message: "발송할 내용 없음 (영업일/보유·관심 기준)", count: 0, marketOpen });
  }

  const domesticItems = items.filter((item) => marketGroupOfSymbol(item.symbol) === "DOMESTIC");
  const overseasItems = items.filter((item) => marketGroupOfSymbol(item.symbol) === "OVERSEAS");
  const domesticWatchEntries = watchEntries.filter((w) => marketGroupOfSymbol(w.symbol) === "DOMESTIC");
  const overseasWatchEntries = watchEntries.filter((w) => marketGroupOfSymbol(w.symbol) === "OVERSEAS");

  if (items.length > 0) {
    const syms = [...symbolMap.keys()];
    const { quotes, usdKrw: pUsd, eurKrw: pEur } = await fetchPrices(syms);
    const usdK = pUsd ?? 1400;
    const eurK = pEur ?? 1500;
    const posNorm = normalizeDbPositions(snap.positions);
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
    const portfolioChangeVsYesterdayPct =
      yVal !== null && yVal > 0 ? ((todayLiveKrw - yVal) / yVal) * 100 : null;
    const ownerLive = computeOwnerLiveValuesKrw(posNorm, cashNorm, quotes, usdK, eurK);
    const yOwners =
      ydayRow?.owner_values && typeof ydayRow.owner_values === "object" && !Array.isArray(ydayRow.owner_values)
        ? (ydayRow.owner_values as Record<string, unknown>)
        : null;
    const ownerDailyReturns = Object.entries(ownerLive)
      .map(([owner, today]) => {
        const yRaw = yOwners?.[owner];
        const y = yRaw === undefined ? null : Number(yRaw);
        const changePct = y !== null && Number.isFinite(y) && y > 0 ? ((today - y) / y) * 100 : null;
        return { owner, changePct };
      })
      .sort((a, b) => a.owner.localeCompare(b.owner, "ko"));

    async function sendHoldingsByMarket(itemsForMarket: AlertItem[], label: string): Promise<Response | null> {
      if (itemsForMarket.length === 0) return null;
      const briefingItems = toBriefingItems(itemsForMarket);
      const miniTrends = await collectMiniTrends(briefingItems);
      const holdTransitions = await collectHoldTransitions(briefingItems);
      const text = buildTelegramBriefingHtml({
        slotLabel: `${BRIEFING_SLOT_LABELS.manual} · ${label}`,
        dateLabel: mmddKST(),
        portfolioChangeVsYesterdayPct,
        ownerDailyReturns,
        items: briefingItems,
        miniTrends,
        holdTransitions,
      });
      const send = await sendTelegramMessage(text);
      if (!send.ok) return NextResponse.json({ ok: false, error: send.error }, { status: 500 });
      return null;
    }

    const domesticSendError = await sendHoldingsByMarket(domesticItems, "국내주식");
    if (domesticSendError) return domesticSendError;
    const overseasSendError = await sendHoldingsByMarket(overseasItems, "해외주식");
    if (overseasSendError) return overseasSendError;

    await admin.from("price_move_alert_logs").upsert(logRows, {
      onConflict: "sync_key,symbol,date,briefing_slot",
    });
  }

  async function sendWatchlistByMarket(entries: WatchlistRow[], label: string): Promise<Response | null> {
    if (entries.length === 0) return null;
    const block = await buildWatchlistTelegramBlock(entries);
    if (!block) return null;
    const text = `⭐ <b>${label} 관심종목</b>\n\n${block}`;
    const sendW = await sendTelegramMessage(text);
    if (!sendW.ok) return NextResponse.json({ ok: false, error: sendW.error }, { status: 500 });
    return null;
  }

  if (marketOpen.DOMESTIC) {
    const watchSendError = await sendWatchlistByMarket(domesticWatchEntries, "국내주식");
    if (watchSendError) return watchSendError;
  }
  if (marketOpen.OVERSEAS) {
    const watchSendError = await sendWatchlistByMarket(overseasWatchEntries, "해외주식");
    if (watchSendError) return watchSendError;
  }

  return NextResponse.json({
    ok: true,
    dry_run: false,
    sentHoldings: items.length,
    sentHoldingsDomestic: domesticItems.length,
    sentHoldingsOverseas: overseasItems.length,
    sentWatchlist: (marketOpen.DOMESTIC ? domesticWatchEntries.length : 0) + (marketOpen.OVERSEAS ? overseasWatchEntries.length : 0),
    sentWatchlistDomestic: marketOpen.DOMESTIC ? domesticWatchEntries.length : 0,
    sentWatchlistOverseas: marketOpen.OVERSEAS ? overseasWatchEntries.length : 0,
    marketOpen,
    items,
  });
}

/*
 * 기존 POST 구현이 아래에 중복으로 남지 않도록 정리됨
 */
