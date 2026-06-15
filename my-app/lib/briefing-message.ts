import type { DailyPrice, TradeSignal } from "@/lib/signals";
import {
  buildSignalAnalysis,
  calculateBollingerSignal,
  calculateMACrossoverSignal,
  calculateRSISignal,
  calculateVolumeSignal,
} from "@/lib/signals";
import type { PricesResult } from "@/lib/market-prices";

export type BriefingItem = {
  symbol: string;
  name: string;
  sector: string;
  groupLabel?: string;
  ownerLabel?: string;
  price: number | null;
  changePct: number | null;
};

export type MiniTrendMap = Record<string, string>;
export type OwnerDailyReturn = {
  owner: string;
  changePct: number | null;
};

/** 보유자별 누적(총) 수익률 — 현재 평가액 대비 매입원가 기준 평가손익률(%) */
export type OwnerTotalReturn = {
  owner: string;
  /** (현재평가 − 매입원가) / 매입원가 × 100. 원가 정보가 전혀 없으면 null */
  returnPct: number | null;
  /** 평가손익 원화 금액 (현재평가 − 매입원가) */
  profitKrw: number;
  /** 매입원가 + 현금 (총 수익률 분모) — 전체 합산용 */
  costBasisKrw: number;
};

/** 지표 한 줄 (MA/RSI/BB/VOL) — HOLD→BUY|SELL 전환 시에만 */
export type HoldTransitionRow = {
  key: "MA" | "RSI" | "BB" | "VOL";
  to: "BUY" | "SELL";
  /** 앱 `buildSignalAnalysis`와 동일한 요약 근거 */
  summary: string;
};

export type HoldTransitionSymbol = {
  symbol: string;
  name: string;
  rows: HoldTransitionRow[];
};

type DbPos = {
  symbol: string;
  quantity: number;
  currentPrice: number;
  currency: "USD" | "EUR" | "KRW";
  owner: string;
};

const OWNER_DISPLAY_ORDER = ["김승주", "강희진"] as const;

function ownerDisplayOrderIndex(owner: string): number {
  const idx = OWNER_DISPLAY_ORDER.indexOf(owner as (typeof OWNER_DISPLAY_ORDER)[number]);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

/** 보유자별 원화 순자산(NAV). 전체 포트 순자산은 이 맵 값들의 합과 같음 */
export function computeOwnerNavKrwMap(
  positions: DbPos[],
  cashByOwner: Record<string, { usd: number; krw: number }>,
  quotes: PricesResult["quotes"],
  usdKrw: number,
  eurKrw: number,
): Record<string, number> {
  const lookupCash = (canonical: string): { usd: number; krw: number } => {
    const direct = cashByOwner[canonical];
    if (direct) return direct;
    for (const [k, v] of Object.entries(cashByOwner)) {
      if (k.trim() === canonical) return v;
    }
    return { usd: 0, krw: 0 };
  };

  const owners = [
    ...new Set([
      ...positions.map((p) => p.owner.trim()),
      ...Object.keys(cashByOwner).map((k) => k.trim()),
    ]),
  ];
  const out: Record<string, number> = {};
  for (const owner of owners) {
    const cash = lookupCash(owner);
    let sum = cash.krw + cash.usd * usdKrw;
    for (const p of positions) {
      if (p.owner.trim() !== owner) continue;
      const q = quotes[p.symbol];
      const price =
        typeof q?.price === "number" && Number.isFinite(q.price) && q.price > 0 ? q.price : p.currentPrice;
      if (p.currency === "USD") sum += p.quantity * price * usdKrw;
      else if (p.currency === "EUR") sum += p.quantity * price * eurKrw;
      else sum += p.quantity * price;
    }
    out[owner] = sum;
  }
  return out;
}

export function computeLivePortfolioKrw(
  positions: DbPos[],
  cashByOwner: Record<string, { usd: number; krw: number }>,
  quotes: PricesResult["quotes"],
  usdKrw: number,
  eurKrw: number,
): number {
  const owners = [
    ...new Set([...positions.map((p) => p.owner), ...Object.keys(cashByOwner)]),
  ];
  let sum = 0;
  for (const owner of owners) {
    const cash = cashByOwner[owner] ?? { usd: 0, krw: 0 };
    sum += cash.krw + cash.usd * usdKrw;
    for (const p of positions.filter((x) => x.owner === owner)) {
      const q = quotes[p.symbol];
      const price = typeof q?.price === "number" && Number.isFinite(q.price) && q.price > 0 ? q.price : p.currentPrice;
      if (p.currency === "USD") sum += p.quantity * price * usdKrw;
      else if (p.currency === "EUR") sum += p.quantity * price * eurKrw;
      else sum += p.quantity * price;
    }
  }
  return sum;
}

export type QuoteWeightedOwnerInput = { ownerLabel: string; symbol: string; changePct: number | null };

export function mergeQuoteWeightsDedupe(rows: QuoteWeightedOwnerInput[]): QuoteWeightedOwnerInput[] {
  const m = new Map<string, QuoteWeightedOwnerInput>();
  for (const it of rows) {
    const k = normOwnerSym(it.ownerLabel, it.symbol);
    if (!m.has(k)) m.set(k, { ownerLabel: it.ownerLabel.trim(), symbol: it.symbol.trim(), changePct: it.changePct });
  }
  return [...m.values()];
}

function normOwnerSym(owner: string, symbol: string): string {
  return `${owner.trim()}:::${symbol.trim().toUpperCase()}`;
}

function quotePriceForSymbol(
  quotes: PricesResult["quotes"],
  symbol: string,
  fallback: number,
): number {
  const s = symbol.trim();
  const q = quotes[s] ?? quotes[s.toUpperCase()];
  const px = typeof q?.price === "number" && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
  return px ?? fallback;
}

/**
 * 전체 포트폴리오: 보유 주식 구간의 일중 손익(KRW) 합 / 전체 NAV. (현금·시세 실패 구간은 등락 0%로 반영)
 */
export function computeQuoteWeightedPortfolioReturnPct(
  positions: DbPos[],
  cashByOwner: Record<string, { usd: number; krw: number }>,
  quotes: PricesResult["quotes"],
  usdKrw: number,
  eurKrw: number,
  quotedItems: QuoteWeightedOwnerInput[],
): number | null {
  const navTotal = Object.values(
    computeOwnerNavKrwMap(positions, cashByOwner, quotes, usdKrw, eurKrw),
  ).reduce((a, b) => a + b, 0);
  if (!(navTotal > 0)) return null;

  const merged = mergeQuoteWeightsDedupe(quotedItems);
  let gainKrw = 0;
  for (const it of merged) {
    const owner = it.ownerLabel.trim();
    const symU = it.symbol.trim().toUpperCase();
    const posRows = positions.filter(
      (p) => p.owner.trim() === owner && p.symbol.trim().toUpperCase() === symU,
    );
    if (posRows.length === 0) continue;
    const r = typeof it.changePct === "number" && Number.isFinite(it.changePct) ? it.changePct : 0;
    for (const p of posRows) {
      const price = quotePriceForSymbol(quotes, p.symbol, p.currentPrice);
      const v =
        p.currency === "USD"
          ? p.quantity * price * usdKrw
          : p.currency === "EUR"
            ? p.quantity * price * eurKrw
            : p.quantity * price;
      if (!Number.isFinite(v) || v <= 0) continue;
      gainKrw += v * (r / 100);
    }
  }
  return (gainKrw / navTotal) * 100;
}

/**
 * 보유자별 오늘 변동 추정(%).
 *
 * - 보유 종목마다 전일 대비 등락(changePct)×당일 평가액 가중 (현금 0%). **모든 보유자·종목**을 `quotedItems`에 넣는 것을 권장.
 * - 가중 손익이 0에 가깝고 전일 스냅 대비 %가 의미 있으면 스냅을 보조로 사용.
 */
export function computeOwnerDailyReturnsHybrid(
  positions: DbPos[],
  cashByOwner: Record<string, { usd: number; krw: number }>,
  quotes: PricesResult["quotes"],
  usdKrw: number,
  eurKrw: number,
  quotedItems: QuoteWeightedOwnerInput[],
  yesterdayByOwner: Record<string, number> | null | undefined,
): OwnerDailyReturn[] {
  const liveNav = computeOwnerNavKrwMap(positions, cashByOwner, quotes, usdKrw, eurKrw);
  const yMap = yesterdayByOwner && typeof yesterdayByOwner === "object" ? yesterdayByOwner : null;

  const mergedItems = mergeQuoteWeightsDedupe(quotedItems);

  const gainKrwFromQuotes = new Map<string, number>();
  const ownersTouched = new Set<string>();

  for (const it of mergedItems) {
    const owner = it.ownerLabel.trim();
    const symU = it.symbol.trim().toUpperCase();
    const rows = positions.filter(
      (p) => p.owner.trim() === owner && p.symbol.trim().toUpperCase() === symU,
    );
    if (rows.length === 0) continue;
    ownersTouched.add(owner);

    const r = typeof it.changePct === "number" && Number.isFinite(it.changePct) ? it.changePct : 0;
    for (const p of rows) {
      const price = quotePriceForSymbol(quotes, p.symbol, p.currentPrice);
      const v =
        p.currency === "USD"
          ? p.quantity * price * usdKrw
          : p.currency === "EUR"
            ? p.quantity * price * eurKrw
            : p.quantity * price;
      if (!Number.isFinite(v) || v <= 0) continue;
      gainKrwFromQuotes.set(owner, (gainKrwFromQuotes.get(owner) ?? 0) + v * (r / 100));
    }
  }

  const ownersSorted = [...Object.keys(liveNav)].sort((a, b) => {
    const ao = ownerDisplayOrderIndex(a);
    const bo = ownerDisplayOrderIndex(b);
    if (ao !== bo) return ao - bo;
    return a.localeCompare(b, "ko");
  });

  return ownersSorted.map((owner): OwnerDailyReturn => {
    const nav = liveNav[owner] ?? 0;
    if (!(nav > 0)) return { owner, changePct: null };

    const snapPct =
      yMap !== null
        ? ((raw) => {
            const v = typeof raw === "number" ? raw : Number(raw);
            if (!Number.isFinite(v) || v <= 0) return null;
            return ((nav - v) / v) * 100;
          })(yMap[owner])
        : null;

    if (!ownersTouched.has(owner)) {
      if (snapPct !== null && Number.isFinite(snapPct)) return { owner, changePct: snapPct };
      return { owner, changePct: null };
    }

    const g = gainKrwFromQuotes.get(owner) ?? 0;
    const quotePct = (g / nav) * 100;

    if (Math.abs(g) <= 1e-3 && snapPct !== null && Number.isFinite(snapPct) && Math.abs(snapPct) >= 0.005) {
      return { owner, changePct: snapPct };
    }
    return { owner, changePct: quotePct };
  });
}

/** 대시보드와 동일한 매매 수수료율 (매입원가에 반영) */
const TRADING_FEE_RATE = 0.001;

/** 총 수익률 계산용 포지션 — 평가/원가에 매입단가·매입환율이 필요 */
export type CostBasisPos = {
  symbol: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  currency: "USD" | "EUR" | "KRW";
  owner: string;
  purchaseUsdKrw?: number | null;
  purchaseEurKrw?: number | null;
};

/**
 * 보유자별 총 수익률(평가손익률).
 *
 * - 주식: 현재 평가액(KRW) vs 매입원가(KRW, 매입환율·수수료 반영) — 대시보드 enrichedPositions와 동일 규칙.
 * - 현금: 원가=평가(손익 0)로 분모에만 포함 → 대시보드 헤더의 "투입 대비 평가" %와 일치.
 */
export function computeOwnerTotalReturns(
  positions: CostBasisPos[],
  cashByOwner: Record<string, { usd: number; krw: number }>,
  quotes: PricesResult["quotes"],
  usdKrw: number,
  eurKrw: number,
): OwnerTotalReturn[] {
  const lookupCash = (canonical: string): { usd: number; krw: number } => {
    const direct = cashByOwner[canonical];
    if (direct) return direct;
    for (const [k, v] of Object.entries(cashByOwner)) {
      if (k.trim() === canonical) return v;
    }
    return { usd: 0, krw: 0 };
  };

  const owners = [
    ...new Set([
      ...positions.map((p) => p.owner.trim()),
      ...Object.keys(cashByOwner).map((k) => k.trim()),
    ]),
  ].filter((o) => o.length > 0);

  const ownersSorted = owners.sort((a, b) => {
    const ao = ownerDisplayOrderIndex(a);
    const bo = ownerDisplayOrderIndex(b);
    if (ao !== bo) return ao - bo;
    return a.localeCompare(b, "ko");
  });

  return ownersSorted.map((owner): OwnerTotalReturn => {
    const cash = lookupCash(owner);
    const cashKrw = cash.krw + cash.usd * usdKrw;

    let stockValue = 0;
    let stockCost = 0;
    for (const p of positions) {
      if (p.owner.trim() !== owner) continue;
      const price = quotePriceForSymbol(quotes, p.symbol, p.currentPrice);
      const effAvg = p.avgPrice * (1 + TRADING_FEE_RATE);
      const purchaseFx =
        p.currency === "USD"
          ? (typeof p.purchaseUsdKrw === "number" && p.purchaseUsdKrw > 0 ? p.purchaseUsdKrw : usdKrw)
          : p.currency === "EUR"
            ? (typeof p.purchaseEurKrw === "number" && p.purchaseEurKrw > 0 ? p.purchaseEurKrw : eurKrw)
            : 1;
      const valueFx = p.currency === "USD" ? usdKrw : p.currency === "EUR" ? eurKrw : 1;
      const valueKrw = p.quantity * price * valueFx;
      const costKrw = p.quantity * effAvg * purchaseFx;
      if (Number.isFinite(valueKrw) && valueKrw > 0) stockValue += valueKrw;
      if (Number.isFinite(costKrw) && costKrw > 0) stockCost += costKrw;
    }

    const costBasis = stockCost + cashKrw;
    const totalValue = stockValue + cashKrw;
    const profitKrw = totalValue - costBasis;
    const returnPct = costBasis > 0 && stockCost > 0 ? (profitKrw / costBasis) * 100 : null;
    return { owner, returnPct, profitKrw, costBasisKrw: costBasis };
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtKrw(n: number): string {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

/** 터미널/고정폭 정렬용: 한글·전각 등은 폭 2, 영문·숫자·기호는 폭 1로 계산 */
function codePointDisplayWidth(cp: number): number {
  if (cp >= 0x1100 && cp <= 0x115f) return 2;
  if (cp >= 0x2e80 && cp <= 0x9fff) return 2;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
  if (cp >= 0xff00 && cp <= 0xffef) return 2;
  if (cp >= 0x3000 && cp <= 0x303f) return 2;
  return 1;
}

function stringDisplayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x10000) {
      w += 2;
      continue;
    }
    w += codePointDisplayWidth(cp);
  }
  return w;
}

function truncateDisplay(str: string, maxW: number): string {
  let out = "";
  for (const ch of str) {
    const next = out + ch;
    if (stringDisplayWidth(next) > maxW) break;
    out = next;
  }
  if (out === str) return out;
  let ell = `${out}…`;
  while (stringDisplayWidth(ell) > maxW && out.length > 0) {
    out = out.slice(0, -1);
    ell = `${out}…`;
  }
  return ell;
}

function padDisplayStart(str: string, target: number): string {
  if (stringDisplayWidth(str) > target) return truncateDisplay(str, target);
  let out = str;
  while (stringDisplayWidth(out) < target) out = ` ${out}`;
  return out;
}

function padDisplayEnd(str: string, target: number): string {
  if (stringDisplayWidth(str) > target) return truncateDisplay(str, target);
  let out = str;
  while (stringDisplayWidth(out) < target) out = `${out} `;
  return out;
}

function fmtPctPlain(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

function ownerOrderIndex(owner: string): number {
  return ownerDisplayOrderIndex(owner);
}

/** 가격 표기 (원화는 전액·쉼표) */
function fmtPriceCompactForMobile(item: BriefingItem): string {
  if (item.price === null || !Number.isFinite(item.price)) return "—";
  const sym = item.symbol.trim();
  const isSixKr = /^[0-9][0-9A-Z]{5}$/i.test(sym);
  const isKrw =
    isSixKr || sym.startsWith("KRX:") || sym.startsWith("KQ:") || /^M\d{8}$/i.test(sym);
  if (isKrw) {
    return fmtKrw(Math.round(item.price));
  }
  const p = item.price;
  if (p >= 1000) return `$${(p / 1000).toFixed(2)}k`;
  return `$${p.toFixed(2)}`;
}

/**
 * 텔레그램 HTML 브리핑 (parse_mode: HTML).
 * 가독성을 위해 섹션별 줄바꿈·이모지·굵게 위주 구성 (<pre> 대량 나열 없음).
 */
export function buildTelegramBriefingHtml(opts: {
  slotLabel?: string;
  dateLabel: string;
  /** 전일 DB 스냅 합계 대비 포트폴리오 수익률(%) — 없으면 null */
  portfolioChangeVsYesterdayPct: number | null;
  ownerDailyReturns?: OwnerDailyReturn[];
  /** 보유자별 총 수익률(평가손익률) — 주어지면 일일 변동률 대신 이 블록을 표시 */
  ownerTotalReturns?: OwnerTotalReturn[];
  items: BriefingItem[];
  miniTrends?: MiniTrendMap;
  /** 전일 일봉까지만 보면 HOLD였다가, 최신 일봉 반영 후 BUY/SELL로 바뀐 지표만 */
  holdTransitions: HoldTransitionSymbol[];
}): string {
  const {
    slotLabel,
    dateLabel,
    portfolioChangeVsYesterdayPct,
    ownerDailyReturns,
    ownerTotalReturns,
    holdTransitions,
  } = opts;

  const timeLine = slotLabel ? `⏰ <i>${escapeHtml(slotLabel)}</i>\n\n` : "";
  const cronFooter =
    "\n\n<i>📡 자동(KST): 01:00 · 09:30 · 12:00 · 15:40 · 23:00</i>";

  // 전체 총 수익률(평가손익률) — 보유자별 합산. ownerTotalReturns가 있으면 일일 대신 이 값 사용
  const overallTotal = (() => {
    if (!ownerTotalReturns || ownerTotalReturns.length === 0) return null;
    let profit = 0;
    let cost = 0;
    let hasCost = false;
    for (const r of ownerTotalReturns) {
      profit += r.profitKrw;
      cost += r.costBasisKrw;
      if (r.returnPct !== null) hasCost = true;
    }
    if (!hasCost || cost <= 0) return null;
    return { pct: (profit / cost) * 100, profitKrw: profit };
  })();

  let portfolioLine = "";
  if (overallTotal !== null) {
    const arrow = overallTotal.pct >= 0 ? "▲" : "▼";
    const pctStr = `${overallTotal.pct >= 0 ? "+" : ""}${overallTotal.pct.toFixed(2)}%`;
    const profitStr = `${overallTotal.profitKrw >= 0 ? "+" : "-"}${fmtKrw(Math.abs(overallTotal.profitKrw))}`;
    portfolioLine = `전체 총 수익률: <b>${arrow} ${pctStr}</b> <i>(${profitStr})</i>`;
  } else if (portfolioChangeVsYesterdayPct !== null && Number.isFinite(portfolioChangeVsYesterdayPct)) {
    const p = portfolioChangeVsYesterdayPct;
    const arrow = p >= 0 ? "▲" : "▼";
    portfolioLine = `전체 수익률: <b>${arrow} ${p >= 0 ? "+" : ""}${p.toFixed(2)}%</b>`;
  } else {
    portfolioLine = "전체 수익률: <i>전일 일별 스냅 없음 (저장 후 비교 가능)</i>";
  }

  let ownerBlock = "";
  if (ownerTotalReturns && ownerTotalReturns.length > 0) {
    // 보유자별 총 수익률(평가손익률) — 일일 변동률 대신 표시
    const sorted = [...ownerTotalReturns].sort((a, b) => {
      const ao = ownerOrderIndex(a.owner);
      const bo = ownerOrderIndex(b.owner);
      if (ao !== bo) return ao - bo;
      return a.owner.localeCompare(b.owner, "ko");
    });
    const lines = sorted.map((r) => {
      if (r.returnPct === null || !Number.isFinite(r.returnPct)) {
        return `• ${escapeHtml(r.owner)}: <i>원가 정보 없음</i>`;
      }
      const arrow = r.returnPct >= 0 ? "▲" : "▼";
      const pctStr = `${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(2)}%`;
      const profitStr = `${r.profitKrw >= 0 ? "+" : "-"}${fmtKrw(Math.abs(r.profitKrw))}`;
      return `• ${escapeHtml(r.owner)}: <b>${arrow} ${pctStr}</b> <i>(${profitStr})</i>`;
    });
    ownerBlock = `\n\n<b>👤 보유자별 총 수익률</b>\n${lines.join("\n")}`;
  } else if (ownerDailyReturns && ownerDailyReturns.length > 0) {
    const sorted = [...ownerDailyReturns].sort((a, b) => {
      const ao = ownerOrderIndex(a.owner);
      const bo = ownerOrderIndex(b.owner);
      if (ao !== bo) return ao - bo;
      return a.owner.localeCompare(b.owner, "ko");
    });
    const lines = sorted.map((r) => {
      if (r.changePct === null || !Number.isFinite(r.changePct)) {
        return `• ${escapeHtml(r.owner)}: <i>전일 스냅 없음</i>`;
      }
      const arrow = r.changePct >= 0 ? "▲" : "▼";
      return `• ${escapeHtml(r.owner)}: <b>${arrow} ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%</b>`;
    });
    ownerBlock = `\n\n<b>👤 보유자별 요약</b>\n${lines.join("\n")}`;
  }

  /** HOLD→전환 종목을 BUY / SELL 한 줄로 묶음 */
  let signalBlock = "";
  if (holdTransitions.length > 0) {
    const buyShown: string[] = [];
    const sellShown: string[] = [];
    for (const h of holdTransitions) {
      const pretty =
        `${escapeHtml(h.name.trim() || h.symbol)} (<code>${escapeHtml(h.symbol)}</code>)`;
      const hasBuy = h.rows.some((row) => row.to === "BUY");
      const hasSell = h.rows.some((row) => row.to === "SELL");
      if (hasBuy) buyShown.push(pretty);
      if (hasSell) sellShown.push(pretty);
    }
    const buyUnique = [...new Set(buyShown)];
    const sellUnique = [...new Set(sellShown)];

    signalBlock =
      `\n\n<b>🎯 매매 시그널 (MA·RSI·BB·VOL 기준)</b>\n` +
      `<i>전일 HOLD → 오늘 BUY·SELL로 바뀐 종목만</i>`;

    if (buyUnique.length === 0 && sellUnique.length === 0) {
      signalBlock += "\n<i>(표시 가능한 전환 없음)</i>";
    } else {
      signalBlock +=
        `\n🟢 <b>BUY</b>: ${buyUnique.length ? buyUnique.join(", ") : "—"}\n` +
        `🔴 <b>SELL</b>: ${sellUnique.length ? sellUnique.join(", ") : "—"}`;
    }
  }

  const header =
    `${timeLine}` +
    `📊 <b>포트폴리오 데일리 리포트</b> (${escapeHtml(dateLabel)})\n\n` +
    `${portfolioLine}` +
    `${ownerBlock}` +
    `${signalBlock}` +
    `${cronFooter}`;

  return header;
}

/** Yahoo 6개월 일봉 — 시그널용 */
export async function fetchDailyHistoryForSignal(symbol: string): Promise<DailyPrice[]> {
  const { isKrxCommodity, toYahooSymbol } = await import("@/lib/market-prices");
  if (isKrxCommodity(symbol)) return [];
  const yahoo = toYahooSymbol(symbol);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?interval=1d&range=6mo`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    return parseYahooSeries(data);
  } catch {
    return [];
  }
}

const SPARK_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPARK_POINTS = 8;

function buildSparkline(values: number[], points = 10): string {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0);
  if (clean.length < 2) return "—";
  const sliced = clean.slice(-points);
  const min = Math.min(...sliced);
  const max = Math.max(...sliced);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "—";
  if (max === min) return "▅".repeat(sliced.length);

  return sliced
    .map((v) => {
      const idx = Math.round(((v - min) / (max - min)) * (SPARK_BARS.length - 1));
      return SPARK_BARS[Math.max(0, Math.min(SPARK_BARS.length - 1, idx))];
    })
    .join("");
}

export async function collectMiniTrends(items: BriefingItem[]): Promise<MiniTrendMap> {
  const uniqueSymbols = [...new Set(items.map((i) => i.symbol))];
  const out: MiniTrendMap = {};

  await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      const hist = await fetchDailyHistoryForSignal(symbol);
      out[symbol] = hist.length >= 2 ? buildSparkline(hist.map((h) => h.close), SPARK_POINTS) : "—";
    }),
  );
  return out;
}

function parseYahooSeries(data: unknown): DailyPrice[] {
  const r0 = (data as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        timestamp?: unknown[];
        indicators?: { quote?: Array<{ close?: unknown[]; high?: unknown[]; low?: unknown[]; volume?: unknown[] }> };
      }
    | undefined;
  if (!r0?.timestamp || !Array.isArray(r0.timestamp)) return [];
  const q = r0.indicators?.quote?.[0];
  const close = Array.isArray(q?.close) ? q.close : [];
  const high = Array.isArray(q?.high) ? q.high : [];
  const low = Array.isArray(q?.low) ? q.low : [];
  const volume = Array.isArray(q?.volume) ? q.volume : [];
  const out: DailyPrice[] = [];
  for (let i = 0; i < r0.timestamp.length; i++) {
    const ts = r0.timestamp[i];
    const c = close[i];
    const h = high[i];
    const l = low[i];
    const v = volume[i];
    if (typeof ts !== "number" || typeof c !== "number" || typeof h !== "number" || typeof l !== "number") continue;
    if (!Number.isFinite(c) || !Number.isFinite(h) || !Number.isFinite(l) || c <= 0 || h <= 0 || l <= 0) continue;
    const d = new Date(ts * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push({
      date: `${y}-${m}-${day}`,
      close: c,
      high: h,
      low: l,
      volume: typeof v === "number" && Number.isFinite(v) ? v : 0,
    });
  }
  return out;
}

const MIN_BARS_FOR_TRANSITION = 63;

type QuadKey = "ma" | "rsi" | "bb" | "vol";

const IND_ORDER: QuadKey[] = ["ma", "rsi", "bb", "vol"];

const IND_LABEL: Record<QuadKey, HoldTransitionRow["key"]> = {
  ma: "MA",
  rsi: "RSI",
  bb: "BB",
  vol: "VOL",
};

function signalsQuad(prices: DailyPrice[]): Record<QuadKey, TradeSignal> {
  return {
    ma: calculateMACrossoverSignal(prices),
    rsi: calculateRSISignal(prices),
    bb: calculateBollingerSignal(prices),
    vol: calculateVolumeSignal(prices),
  };
}

/**
 * 전일 일봉까지만 쓴 시뮬레이션에서는 네 지표가 HOLD였는데,
 * 최신 일봉을 포함하면 BUY/SELL로 바뀐 경우만 모읍니다. (앱 로직과 동일)
 */
export async function collectHoldTransitions(
  items: BriefingItem[],
): Promise<HoldTransitionSymbol[]> {
  const unique = [...new Map(items.map((i) => [i.symbol, i])).values()];
  const out: HoldTransitionSymbol[] = [];

  await Promise.all(
    unique.map(async (item) => {
      const hist = await fetchDailyHistoryForSignal(item.symbol);
      if (hist.length < MIN_BARS_FOR_TRANSITION) return;

      const prevHist = hist.slice(0, -1);
      const was = signalsQuad(prevHist);
      const cur = signalsQuad(hist);

      const keys: QuadKey[] = [];
      for (const k of IND_ORDER) {
        if (was[k] === "HOLD" && (cur[k] === "BUY" || cur[k] === "SELL")) {
          keys.push(k);
        }
      }
      if (keys.length === 0) return;

      const analysis = buildSignalAnalysis(hist);
      if (!analysis) return;

      const explain = {
        ma: analysis.maExplain,
        rsi: analysis.rsiExplain,
        bb: analysis.bbExplain,
        vol: analysis.volExplain,
      };

      const rows: HoldTransitionRow[] = keys.map((k) => ({
        key: IND_LABEL[k],
        to: cur[k] as "BUY" | "SELL",
        summary: explain[k].summary,
      }));

      out.push({
        symbol: item.symbol,
        name: item.name,
        rows,
      });
    }),
  );

  out.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return out;
}
