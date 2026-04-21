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
  if (s.includes("에너지") || s.includes("energy")) return "⚡";
  if (s.includes("방산") || s.includes("defense")) return "🛡️";
  if (s.includes("반도체") || s.includes("semiconductor")) return "💾";
  if (s.includes("ai") || s.includes("tech") || s.includes("기술")) return "🤖";
  if (s.includes("금") || s.includes("gold")) return "🥇";
  if (s.includes("채권") || s.includes("bond")) return "💵";
  if (s.includes("현금") || s.includes("cash")) return "💰";
  return "🧩";
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
 * 총액 미표시·전일 대비 포트폴리오 %만. 종목 목록은 모바일 줄바꿈을 피하기 위해 종목당 2줄·폭 제한 `<pre>`.
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
    miniTrends,
    holdTransitions,
  } = opts;

  const timeLine = slotLabel ? `⏰ ${escapeHtml(slotLabel)}\n` : "";
  const cronHint =
    "자동 발송(KST): <b>01:00 · 09:30 · 12:00 · 15:40 · 23:00</b> (<code>vercel.json</code> Cron)\n";

  let portfolioPctLine = "";
  if (portfolioChangeVsYesterdayPct !== null && Number.isFinite(portfolioChangeVsYesterdayPct)) {
    const p = portfolioChangeVsYesterdayPct;
    const arrow = p >= 0 ? "▲" : "▼";
    portfolioPctLine = `전일 대비 포트폴리오 수익률: <b>${arrow} ${p >= 0 ? "+" : ""}${p.toFixed(2)}%</b>\n`;
  } else {
    portfolioPctLine =
      "전일 대비 포트폴리오 수익률: <i>전일 일별 스냅 없음 (저장 후 비교 가능)</i>\n";
  }

  let ownerSummaryBlock = "";
  if (ownerDailyReturns && ownerDailyReturns.length > 0) {
    const rows = [...ownerDailyReturns].sort((a, b) => a.owner.localeCompare(b.owner, "ko"));
    const lines = rows.map((r) => {
      if (r.changePct === null || !Number.isFinite(r.changePct)) {
        return `· ${escapeHtml(r.owner)}: <i>전일 스냅 없음</i>`;
      }
      const arrow = r.changePct >= 0 ? "▲" : "▼";
      return `· ${escapeHtml(r.owner)}: <b>${arrow} ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%</b>`;
    });
    ownerSummaryBlock = `👤 <b>보유자별 전일 대비 수익률</b>\n${lines.join("\n")}\n\n`;
  }

  const header =
    `${timeLine}${cronHint}` +
    `📊 <b>포트폴리오 브리핑</b> (${escapeHtml(dateLabel)})\n` +
    `${portfolioPctLine}${ownerSummaryBlock}`;

  const movers = items
    .filter((i) => i.changePct !== null && Math.abs(i.changePct) >= 2)
    .sort(sortByChangePctDesc);
  const rest = items.filter((i) => i.changePct === null || Math.abs(i.changePct) < 2);
  const restSorted = [...rest].sort(sortByChangePctDesc);

  function groupByOwner(rows: BriefingItem[]): Array<{ owner: string; rows: BriefingItem[] }> {
    const map = new Map<string, BriefingItem[]>();
    for (const row of rows) {
      const owner = (row.ownerLabel ?? "").trim() || "기타";
      const prev = map.get(owner);
      if (prev) prev.push(row);
      else map.set(owner, [row]);
    }
    return [...map.entries()]
      .map(([owner, ownerRows]) => ({ owner, rows: ownerRows }))
      .sort((a, b) => a.owner.localeCompare(b.owner, "ko"));
  }

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

  function renderTable(rows: BriefingItem[]): string {
    const NAME_W = 8;
    const lines: string[] = [];
    lines.push(`${padDisplayEnd("종목", NAME_W)} | 가격 | 등락 | 차트`);
    lines.push(`${"-".repeat(NAME_W)}-+------+------+-${"-".repeat(10)}`);
    for (const r of rows) {
      const name = padDisplayEnd(truncateDisplay((r.name || r.symbol).trim() || r.symbol, NAME_W), NAME_W);
      const price = fmtPriceCompactForMobile(r);
      const pct = fmtPctPlain(r.changePct);
      const trendLine = (miniTrends?.[r.symbol] ?? "—").trim() || "—";
      const dir = r.changePct === null || !Number.isFinite(r.changePct) ? "⚪" : r.changePct >= 0 ? "🟢" : "🔴";
      const trend = `${dir}${trendLine}`;
      lines.push(`${name} | ${price} | ${pct} | ${trend}`);
    }
    return lines.join("\n");
  }

  const tableParts: string[] = [];
  if (movers.length > 0) {
    tableParts.push("🚨 주요 변동 (전일대비 ±2% 이상)");
    for (const ownerGroup of groupByOwner(movers)) {
      tableParts.push(`👤 ${ownerGroup.owner}`);
      for (const g of groupByChartLabel(ownerGroup.rows)) {
        tableParts.push(`${iconForGroupLabel(g.label)} 그룹: ${g.label}`);
        tableParts.push(renderTable(g.rows));
        tableParts.push("");
      }
      tableParts.push("");
    }
    while (tableParts.length > 0 && tableParts[tableParts.length - 1] === "") {
      tableParts.pop();
    }
  } else {
    tableParts.push("🚨 주요 변동 (전일대비 ±2% 이상)");
    tableParts.push("(해당 없음)");
  }

  if (restSorted.length > 0) {
    tableParts.push("");
    tableParts.push(`📋 기타 (${restSorted.length}종, ±2% 미만)`);
    for (const ownerGroup of groupByOwner(restSorted)) {
      tableParts.push(`👤 ${ownerGroup.owner}`);
      for (const g of groupByChartLabel(ownerGroup.rows)) {
        tableParts.push(`${iconForGroupLabel(g.label)} 그룹: ${g.label}`);
        tableParts.push(renderTable(g.rows));
        tableParts.push("");
      }
      tableParts.push("");
    }
    while (tableParts.length > 0 && tableParts[tableParts.length - 1] === "") {
      tableParts.pop();
    }
  }

  const tablePlain = tableParts.join("\n");
  const preBlock = `<pre>${escapeHtml(tablePlain)}</pre>\n`;

  let restSummary = "";
  if (restSorted.length > 0) {
    const valid = restSorted.map((i) => i.changePct).filter((v): v is number => v !== null && Number.isFinite(v));
    const avg = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    restSummary =
      avg !== null
        ? `<i>기타 종목 평균 등락: ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%</i>\n`
        : "";
  }

  let holdBlock = "";
  if (holdTransitions.length > 0) {
    const lines: string[] = [
      `<b>🔄 HOLD에서 전환된 지표</b>`,
      `<i>전일까지 일봉만 반영 시 HOLD → 최신 일봉 포함 시 BUY/SELL (앱과 동일 MA·RSI·BB·VOL)</i>`,
      "",
    ];
    for (const h of holdTransitions) {
      lines.push(
        `· <b>${escapeHtml(h.name)}</b> (<code>${escapeHtml(h.symbol)}</code>)`,
      );
      for (const r of h.rows) {
        lines.push(
          `  ${escapeHtml(r.key)}→<b>${r.to}</b>: ${escapeHtml(r.summary)}`,
        );
      }
      // 종목 단위로 한 줄 띄워 가독성 향상
      lines.push("");
    }
    holdBlock = `\n\n${lines.join("\n")}`;
  }

  return `${header}<b>보유 종목</b>\n${preBlock}${restSummary}${holdBlock}`.trim();
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
