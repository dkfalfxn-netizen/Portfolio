import type { DailyPrice } from "@/lib/signals";
import { calculateMACrossoverSignal, calculateRSISignal } from "@/lib/signals";
import type { PricesResult } from "@/lib/market-prices";

export type BriefingItem = {
  symbol: string;
  name: string;
  sector: string;
  price: number | null;
  changePct: number | null;
};

export type SignalHit = {
  symbol: string;
  name: string;
  rsi: "BUY" | "SELL" | "HOLD";
  ma: "BUY" | "SELL" | "HOLD";
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

function fmtPriceCell(item: BriefingItem): string {
  if (item.price === null || !Number.isFinite(item.price)) return "—";
  // 해외는 USD 표기, 국내·그 외는 원화로 표시(브리핑에서 통일하기 어려워 심볼로 추정)
  const sym = item.symbol.trim();
  const isSixKr = /^[0-9][0-9A-Z]{5}$/i.test(sym);
  if (isSixKr || sym.startsWith("KRX:") || sym.startsWith("KQ:") || /^M\d{8}$/i.test(sym)) {
    return fmtKrw(item.price);
  }
  return `$${item.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "   —  ";
  const s = `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
  return s.padStart(8, " ");
}

/** 고정폭: 종목명(최대 w), 가격, 전일대비% */
function buildAlignedTable(rows: BriefingItem[], nameWidth: number): string {
  const lines: string[] = [];
  const hdr = `${"종목명".padEnd(nameWidth, " ")}  ${"가격".padStart(14, " ")}  전일대비`;
  lines.push(hdr);
  lines.push("-".repeat(Math.min(48, hdr.length + 10)));
  for (const r of rows) {
    const nm = escapeHtml((r.name || r.symbol).slice(0, nameWidth)).padEnd(nameWidth, " ");
    const px = fmtPriceCell(r).padStart(14, " ");
    const pc = fmtPct(r.changePct);
    lines.push(`${nm}  ${px}  ${pc}`);
  }
  return lines.join("\n");
}

/**
 * 텔레그램 HTML 브리핑 (parse_mode: HTML).
 * 총액 상단 강조, 주요 변동(±2%) 상단 + 코드블록, 나머지 요약, 시그널은 포찬 시만.
 */
export function buildTelegramBriefingHtml(opts: {
  slotLabel?: string;
  dateLabel: string;
  /** 오늘 기준 총 평가액(KRW) */
  totalKrw: number | null;
  /** 전일 DB 스냅 합계 대비 포트폴리오 수익률(%) — 없으면 null */
  portfolioChangeVsYesterdayPct: number | null;
  items: BriefingItem[];
  signalHits: SignalHit[];
}): string {
  const { slotLabel, dateLabel, totalKrw, portfolioChangeVsYesterdayPct, items, signalHits } = opts;

  const timeLine = slotLabel ? `⏰ ${escapeHtml(slotLabel)}\n` : "";
  const totalLine =
    totalKrw !== null && Number.isFinite(totalKrw) && totalKrw > 0
      ? `<b>${fmtKrw(totalKrw)}</b>`
      : "<b>—</b> <i>(포지션·시세로 합산 불가)</i>";

  let portfolioPctLine = "";
  if (portfolioChangeVsYesterdayPct !== null && Number.isFinite(portfolioChangeVsYesterdayPct)) {
    const p = portfolioChangeVsYesterdayPct;
    const arrow = p >= 0 ? "▲" : "▼";
    portfolioPctLine = `\n전일 대비 포트폴리오: <b>${arrow} ${p >= 0 ? "+" : ""}${p.toFixed(2)}%</b>`;
  } else {
    portfolioPctLine = "\n전일 대비 포트폴리오: <i>전일 일별 스냅 없음 (저장 후 비교 가능)</i>";
  }

  const header = `${timeLine}📊 <b>포트폴리오 브리핑</b> (${escapeHtml(dateLabel)})\n💰 총 평가금액: ${totalLine}${portfolioPctLine}\n`;

  const movers = items
    .filter((i) => i.changePct !== null && Math.abs(i.changePct) >= 2)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
  const rest = items.filter((i) => i.changePct === null || Math.abs(i.changePct) < 2);

  const nameW = 14;
  let moversBlock = "";
  if (movers.length > 0) {
    moversBlock =
      `\n<b>🚨 주요 변동 타겟 (전일대비 ±2% 이상)</b>\n` +
      `<pre>${buildAlignedTable(movers, nameW)}</pre>\n`;
  } else {
    moversBlock = `\n<b>🚨 주요 변동 타겟</b>\n<i>해당 없음</i>\n`;
  }

  let restSummary = "";
  if (rest.length > 0) {
    const valid = rest.map((i) => i.changePct).filter((v): v is number => v !== null && Number.isFinite(v));
    const avg = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    restSummary =
      `\n<b>📋 기타 ${rest.length}종</b> (±2% 미만)\n` +
      (avg !== null
        ? `평균 전일대비 등락: <b>${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%</b> (종목별 상세는 앱에서 확인)\n`
        : `시세·등락 일부 누락 가능\n`);
  }

  const activeSignals = signalHits.filter(
    (s) => s.rsi === "BUY" || s.rsi === "SELL" || s.ma === "BUY" || s.ma === "SELL",
  );
  let signalBlock = "";
  if (activeSignals.length > 0) {
    const lines = activeSignals.map((s) => {
      const bits: string[] = [];
      if (s.rsi === "BUY" || s.rsi === "SELL") bits.push(`RSI:${s.rsi}`);
      if (s.ma === "BUY" || s.ma === "SELL") bits.push(`이평20/60:${s.ma}`);
      return `· ${escapeHtml(s.name)} (${escapeHtml(s.symbol)}): ${bits.join(" · ")}`;
    });
    signalBlock =
      `\n<b>🛰️ 기술적 시그널 (포착)</b>\n` +
      `<i>RSI·이평 교차 — 앱과 동일 규칙</i>\n` +
      lines.join("\n");
  }

  return `${header}${moversBlock}${restSummary}${signalBlock}`.trim();
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

export async function collectSignalHits(items: BriefingItem[]): Promise<SignalHit[]> {
  const hits: SignalHit[] = [];
  const unique = [...new Map(items.map((i) => [i.symbol, i])).values()];
  await Promise.all(
    unique.map(async (item) => {
      const hist = await fetchDailyHistoryForSignal(item.symbol);
      if (hist.length < 61) return;
      const rsi = calculateRSISignal(hist);
      const ma = calculateMACrossoverSignal(hist);
      hits.push({ symbol: item.symbol, name: item.name, rsi, ma });
    }),
  );
  return hits;
}
