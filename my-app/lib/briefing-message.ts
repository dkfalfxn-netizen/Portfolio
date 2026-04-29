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

/** 시세 스냅샷으로 전체 포트폴리오 원화 평가액 (여러 계정 합산용으로 호출 가능) */
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

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtKrw(n: number): string {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

/** 전일 대비 % 높은 순(내림차순). 등락 없음/null 은 뒤로 */
function sortByChangePctDesc(a: BriefingItem, b: BriefingItem): number {
  const va = a.changePct;
  const vb = b.changePct;
  const fa = va !== null && Number.isFinite(va);
  const fb = vb !== null && Number.isFinite(vb);
  if (!fa && !fb) return 0;
  if (!fa) return 1;
  if (!fb) return -1;
  return vb - va;
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

function iconForGroupLabel(label: string): string {
  const s = label.trim().toLowerCase();
  if (!s) return "🧩";
  if (s.includes("attack")) return "🎯";
  if (s.includes("원자력") || s.includes("nuclear")) return "☢️";
  if (s.includes("국내주식")) return "🇰🇷";
  if (s.includes("s&p500") || s.includes("s&p 500") || s.includes("sp500")) return "🇺🇸";
  if (s.includes("에르메스") || s.includes("hermes")) return "👜";
  if (s === "xle" || s.includes("xle")) return "⛽";
  if (s.includes("에너지") || s.includes("energy")) return "⚡";
  if (s.includes("방산") || s.includes("defense")) return "🛡️";
  if (s.includes("반도체") || s.includes("semiconductor")) return "💾";
  if (s.includes("ai") || s.includes("tech") || s.includes("기술")) return "🤖";
  if (s.includes("금") || s.includes("gold")) return "🥇";
  if (s.includes("채권") || s.includes("bond")) return "💵";
  if (s.includes("현금") || s.includes("cash")) return "💰";
  return "🧩";
}

const OWNER_DISPLAY_ORDER = ["김승주", "강희진"] as const;
function ownerOrderIndex(owner: string): number {
  const idx = OWNER_DISPLAY_ORDER.indexOf(owner as (typeof OWNER_DISPLAY_ORDER)[number]);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
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
    items,
    holdTransitions,
  } = opts;

  function groupByChartLabel(rows: BriefingItem[]): Array<{ label: string; rows: BriefingItem[] }> {
    const map = new Map<string, BriefingItem[]>();
    for (const row of rows) {
      const key = (row.groupLabel ?? "").trim() || row.symbol;
      const prev = map.get(key);
      if (prev) prev.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()]
      .map(([label, gRows]) => ({
        label,
        rows: gRows.sort(sortByChangePctDesc),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }

  type GroupWithAvg = { label: string; rows: BriefingItem[]; avg: number | null };

  function computeGroupsWithAvg(rows: BriefingItem[]): GroupWithAvg[] {
    return groupByChartLabel(rows).map((g) => {
      const values = g.rows
        .map((r) => r.changePct)
        .filter((v): v is number => v !== null && Number.isFinite(v));
      const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
      return { ...g, avg };
    });
  }

  function sortGroupsByAbsMagnitude(groups: GroupWithAvg[]): GroupWithAvg[] {
    return [...groups].sort((a, b) => {
      const af = a.avg !== null && Number.isFinite(a.avg);
      const bf = b.avg !== null && Number.isFinite(b.avg);
      if (!af && !bf) return 0;
      if (!af) return 1;
      if (!bf) return -1;
      return Math.abs(b.avg!) - Math.abs(a.avg!);
    });
  }

  /** 보유자 보유종목 등락 중 |평균| 최대 그룹으로 짧은 괄호 설명 */
  function inferOwnerDriverPhrase(owner: string, slice: BriefingItem[]): string | null {
    const mine = slice.filter((i) => (i.ownerLabel ?? "").trim() === owner);
    if (mine.length === 0) return null;
    const gs = computeGroupsWithAvg(mine).filter((g) => g.avg !== null && Number.isFinite(g.avg));
    if (gs.length === 0) return null;
    let best = gs[0]!;
    for (const g of gs) {
      if (Math.abs(g.avg!) > Math.abs(best.avg!)) best = g;
    }
    const label = escapeHtml(best.label.trim());
    if (best.avg! >= 0.2) return `${label} 강세`;
    if (best.avg! <= -0.2) return `${label} 조정`;
    return label;
  }

  const timeLine = slotLabel ? `⏰ <i>${escapeHtml(slotLabel)}</i>\n\n` : "";
  const cronFooter =
    "\n\n<i>📡 자동(KST): 01:00 · 09:30 · 12:00 · 15:40 · 23:00</i>";

  let portfolioLine = "";
  if (portfolioChangeVsYesterdayPct !== null && Number.isFinite(portfolioChangeVsYesterdayPct)) {
    const p = portfolioChangeVsYesterdayPct;
    const arrow = p >= 0 ? "▲" : "▼";
    portfolioLine = `전체 수익률: <b>${arrow} ${p >= 0 ? "+" : ""}${p.toFixed(2)}%</b>`;
  } else {
    portfolioLine = "전체 수익률: <i>전일 일별 스냅 없음 (저장 후 비교 가능)</i>";
  }

  let ownerBlock = "";
  if (ownerDailyReturns && ownerDailyReturns.length > 0) {
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
      const hint = inferOwnerDriverPhrase(r.owner, items);
      const tail = hint ? ` <i>(${hint})</i>` : "";
      return `• ${escapeHtml(r.owner)}: <b>${arrow} ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%</b>${tail}`;
    });
    ownerBlock = `\n\n<b>👤 보유자별 요약</b>\n${lines.join("\n")}`;
  }

  /** 전 종목 통합 그룹 — 차트 라벨(섹터) 단위 평균등락 */
  const allGroups = computeGroupsWithAvg(items);
  const moverGroups = sortGroupsByAbsMagnitude(
    allGroups.filter((g) => g.avg !== null && Math.abs(g.avg) >= 2),
  );
  const restGroups = allGroups.filter(
    (g) => g.avg === null || !Number.isFinite(g.avg) || Math.abs(g.avg) < 2,
  );

  let moversBlock = "";
  if (moverGroups.length > 0) {
    const lines = moverGroups.map((g) => {
      const arrow = g.avg! >= 0 ? "▲" : "▼";
      const signed = `${g.avg! >= 0 ? "+" : ""}${g.avg!.toFixed(2)}%`;
      return `${iconForGroupLabel(g.label)} <b>${escapeHtml(g.label)}</b>: ${signed} ${arrow}`;
    });
    moversBlock = `\n\n<b>🔥 주요 변동 종목 (±2% 이상)</b>\n${lines.join("\n")}`;
  } else {
    moversBlock = `\n\n<b>🔥 주요 변동 종목 (±2% 이상)</b>\n<i>(해당 없음)</i>`;
  }

  let restFoot = "";
  if (restGroups.length > 0) {
    restFoot = `\n\n📌 <i>그 외 ${restGroups.length}개 구간은 ±2% 미만 — 앱에서 상세 확인</i>`;
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
    `${moversBlock}` +
    `${restFoot}` +
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
