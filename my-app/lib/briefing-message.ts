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

function fmtPctPlain(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

/** +3%↑ 🚀, +2%↑ 📈, 음봉 📉 (2~3% 구간은 📈). 등락 문자열에 붙여 한 줄 폭을 줄임 */
function rowTrendEmoji(changePct: number | null): string {
  if (changePct === null || !Number.isFinite(changePct)) return "";
  if (changePct >= 3) return "🚀";
  if (changePct >= 2) return "📈";
  if (changePct < 0) return "📉";
  return "";
}

/** 좁은 화면: 한 줄(가격+등락)이 대략 이 폭을 넘지 않도록 (한글 폭 2 기준) */
const MOBILE_BLOCK_W = 26;

/** 가격 표기 (원화는 전액·쉼표, 모바일 폭은 buildRightColumnLine에서 잘림) */
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

/** 가격·등락·이모지 한 줄을 블록 폭에 맞춤 (가격부터 짧게) */
function buildRightColumnLine(item: BriefingItem): string {
  const pc = fmtPctPlain(item.changePct);
  const em = rowTrendEmoji(item.changePct);
  let px = fmtPriceCompactForMobile(item);
  for (let n = 0; n < 8; n++) {
    const right = em ? `${px} ${pc}${em}` : `${px} ${pc}`;
    if (stringDisplayWidth(right) <= MOBILE_BLOCK_W) return right;
    const nextW = Math.max(3, stringDisplayWidth(px) - 1);
    const shortened = truncateDisplay(px, nextW);
    if (shortened === px) break;
    px = shortened;
  }
  const right = em ? `${px} ${pc}${em}` : `${px} ${pc}`;
  return truncateDisplay(right, MOBILE_BLOCK_W);
}

/** 종목당 2줄: 1줄 종목명, 2줄 가격·등락(우측 정렬) — 모바일에서 한 줄이 너무 길어 꺾이지 않게 함 */
function buildMobileStackedBlock(rows: BriefingItem[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    const rawName = (r.name || r.symbol).trim() || r.symbol;
    const nameLine = truncateDisplay(rawName, MOBILE_BLOCK_W);
    const line2 = padDisplayStart(buildRightColumnLine(r), MOBILE_BLOCK_W);
    lines.push(nameLine);
    lines.push(line2);
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
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
  items: BriefingItem[];
  signalHits: SignalHit[];
}): string {
  const { slotLabel, dateLabel, portfolioChangeVsYesterdayPct, items, signalHits } = opts;

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

  const header =
    `${timeLine}${cronHint}` +
    `📊 <b>포트폴리오 브리핑</b> (${escapeHtml(dateLabel)})\n` +
    `${portfolioPctLine}\n`;

  const movers = items
    .filter((i) => i.changePct !== null && Math.abs(i.changePct) >= 2)
    .sort(sortByChangePctDesc);
  const rest = items.filter((i) => i.changePct === null || Math.abs(i.changePct) < 2);
  const restSorted = [...rest].sort(sortByChangePctDesc);

  const tableParts: string[] = [];
  if (movers.length > 0) {
    tableParts.push("🚨 주요 변동 (전일대비 ±2% 이상)");
    tableParts.push(buildMobileStackedBlock(movers));
  } else {
    tableParts.push("🚨 주요 변동 (전일대비 ±2% 이상)");
    tableParts.push("(해당 없음)");
  }

  if (restSorted.length > 0) {
    tableParts.push("");
    tableParts.push(`📋 기타 (${restSorted.length}종, ±2% 미만)`);
    tableParts.push(buildMobileStackedBlock(restSorted));
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

  return `${header}<b>보유 종목</b>\n${preBlock}${restSummary}${signalBlock}`.trim();
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
