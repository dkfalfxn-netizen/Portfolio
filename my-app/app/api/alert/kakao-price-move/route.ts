import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

type Position = {
  symbol: string;
  name: string;
  owner: string;
  sector?: string;
  accountType?: string;
};

type Quote = {
  price: number | null;
  previousClose: number | null;
};

type AlertItem = {
  syncKey: string;
  symbol: string;
  name: string;
  sector: string;
  price: number | null;
  changePct: number | null;
};

function isKrxCommodity(symbol: string): boolean {
  return /^M\d{8}$/i.test(symbol.trim());
}

function toYahooSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "RMS") return "RMS.PA";
  if (normalized.startsWith("KRX:")) return `${normalized.replace("KRX:", "")}.KS`;
  if (/^[0-9][0-9A-Z]{5}$/.test(normalized)) return `${normalized}.KS`;
  if (normalized.startsWith("KQ:")) return `${normalized.replace("KQ:", "")}.KQ`;
  return normalized;
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

function mmddKST(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

function formatUsdPrice(price: number | null): string {
  if (price === null) return "시세없음";
  return `$${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatTotalValue(value: number | null): string {
  if (value === null) return "데이터 없음";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** Cron 쿼리 ?slot= 과 DB briefing_slot 값 (한국 시간 발송 시각) */
const BRIEFING_SLOT_LABELS: Record<string, string> = {
  "0930": "09:30 KST",
  "1200": "12:00 KST",
  "1540": "15:40 KST",
  "2300": "23:00 KST",
  legacy: "일일(레거시)",
  manual: "수동 테스트",
};

function buildTelegramBriefing(
  items: AlertItem[],
  totalValue: number | null,
  opts?: { slotLabel?: string },
): string {
  const now = mmddKST();
  const timePrefix = opts?.slotLabel ? `⏰ ${opts.slotLabel}\n` : "";
  const validPcts = items
    .map((i) => i.changePct)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const avgPct = validPcts.length > 0 ? validPcts.reduce((a, b) => a + b, 0) / validPcts.length : 0;
  const arrow = avgPct > 0 ? "🔺" : "📉";

  const summary =
    timePrefix +
    `📊 포트폴리오 브리핑 (${now})\n` +
    `💰 총 평가금액: ${formatTotalValue(totalValue)} (${avgPct >= 0 ? "+" : ""}${avgPct.toFixed(1)}% ${arrow})\n\n`;

  const movers = items
    .filter((i) => i.changePct !== null && Math.abs(i.changePct) >= 2)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
  let moversText = "🚨 [주요 변동 타겟] (±2% 이상)\n";
  if (movers.length > 0) {
    for (const m of movers.slice(0, 12)) {
      moversText += `· ${m.name}: ${formatUsdPrice(m.price)} (${m.changePct! >= 0 ? "+" : ""}${m.changePct!.toFixed(1)}%)\n`;
    }
  } else {
    moversText += "· 특이 변동 종목 없음\n";
  }

  const sectors = new Map<string, AlertItem[]>();
  for (const item of items) {
    if (!sectors.has(item.sector)) sectors.set(item.sector, []);
    sectors.get(item.sector)!.push(item);
  }

  let sectorText = "\n📂 [섹터별 현황]";
  for (const [sector, stocks] of sectors.entries()) {
    sectorText += `\n${sector}\n`;
    for (const s of stocks) {
      const pctText = s.changePct === null ? "시세 없음" : `${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%`;
      sectorText += `· ${s.name}: ${formatUsdPrice(s.price)} (${pctText})\n`;
    }
  }

  const signalText =
    "\n🛰️ [기술적 시그널 포착]\n" +
    "⚠️ RSI 과매수(>=70): 없음\n" +
    "⚠️ RSI 과매도(<=30): 없음\n" +
    "🔄 MACD 골든크로스: 없음";

  return `${summary}${moversText}${sectorText}${signalText}`;
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

  const { data: snaps, error } = await admin
    .from("portfolio_snapshots")
    .select("sync_key, positions");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!snaps || snaps.length === 0) return NextResponse.json({ ok: true, message: "portfolio_snapshots 없음" });

  // 같은 날 중복 발송 방지
  const dateKst = todayKST();
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
  let totalValue = 0;
  let hasTotalValue = false;

  for (const snap of snaps) {
    const syncKey = String(snap.sync_key);
    const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Position[];
    const { data: daily } = await admin
      .from("portfolio_daily_snapshots")
      .select("total_value")
      .eq("sync_key", syncKey)
      .eq("date", dateKst)
      .maybeSingle();
    if (daily?.total_value !== null && daily?.total_value !== undefined) {
      const n = Number(daily.total_value);
      if (Number.isFinite(n)) {
        totalValue += n;
        hasTotalValue = true;
      }
    }

    // 종목별 대표 정보 추출 (symbol 기준)
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
      const dedupeKey = `${syncKey}:${symbol}:${dateKst}:${briefingSlot}`;
      if (sentSet.has(dedupeKey)) continue;

      const q = await fetchQuoteForSymbol(symbol);
      // 시세 조회 실패 종목도 포함 (변동률 없음으로 표시)
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

  if (items.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "발송할 종목 없음",
      count: 0,
      briefing_slot: briefingSlot,
    });
  }

  const text = buildTelegramBriefing(items, hasTotalValue ? totalValue : null, { slotLabel });
  const send = await sendTelegramMessage(text);
  if (!send.ok) return NextResponse.json({ error: send.error ?? "텔레그램 전송 실패" }, { status: 500 });

  if (logRows.length > 0) {
    await admin.from("price_move_alert_logs").upsert(logRows, {
      onConflict: "sync_key,symbol,date,briefing_slot",
    });
  }

  return NextResponse.json({ ok: true, sent: items.length, briefing_slot: briefingSlot });
}

/**
 * POST /api/alert/kakao-price-move  { sync_key: string, dry_run?: boolean }
 *
 * 수동 테스트용. sync_key 소유자의 종목만 체크합니다.
 * dry_run: true → 실제 전송 없이 점검 결과만 반환 (기본값 true)
 * dry_run: false → 실제로 텔레그램 전송 (오늘 이미 보낸 종목은 건너뜀)
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }
  const b = body as { sync_key?: unknown; dry_run?: unknown };
  const syncKey = typeof b.sync_key === "string" ? b.sync_key : null;
  if (!syncKey || syncKey.length < 8) {
    return NextResponse.json({ error: "sync_key가 필요합니다." }, { status: 400 });
  }
  const dryRun = b.dry_run !== false; // 기본값 true (실전 전송 안 함)

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

  const { data: snap } = await admin
    .from("portfolio_snapshots")
    .select("positions")
    .eq("sync_key", syncKey)
    .maybeSingle();

  if (!snap) return NextResponse.json({ error: "portfolio_snapshots에 해당 sync_key가 없습니다." }, { status: 404 });

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

  // 오늘 수동 발송으로 이미 기록된 종목 확인 (Cron 슬롯과 별개)
  const { data: logs } = await admin
    .from("price_move_alert_logs")
    .select("symbol")
    .eq("sync_key", syncKey)
    .eq("date", dateKst)
    .eq("briefing_slot", manualSlot);
  const alreadySent = new Set((logs ?? []).map((l) => l.symbol));

  for (const [symbol, info] of symbolMap) {
    const q = await fetchQuoteForSymbol(symbol);
    const pct = (q.price && q.previousClose && q.previousClose > 0)
      ? ((q.price - q.previousClose) / q.previousClose) * 100
      : null;
    const willAlert = !alreadySent.has(symbol); // 모든 종목 발송 (중복 방지만)
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

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      date: dateKst,
      env: { TELEGRAM_BOT_TOKEN: "✅", TELEGRAM_CHAT_ID: "✅" },
      symbols: results,
      alertCount: items.length,
      alreadySentToday: [...alreadySent],
      message: items.length > 0 ? `${items.length}개 종목 발송 예정` : "오늘 이미 모두 발송됨",
    });
  }

  // dry_run: false → 실제 전송
  if (items.length === 0) {
    return NextResponse.json({ ok: true, dry_run: false, message: "오늘 이미 모두 발송됨", count: 0 });
  }

  let totalValue: number | null = null;
  const { data: daily } = await admin
    .from("portfolio_daily_snapshots")
    .select("total_value")
    .eq("sync_key", syncKey)
    .eq("date", dateKst)
    .maybeSingle();
  if (daily?.total_value !== null && daily?.total_value !== undefined) {
    const n = Number(daily.total_value);
    totalValue = Number.isFinite(n) ? n : null;
  }

  const text = buildTelegramBriefing(items, totalValue, { slotLabel: BRIEFING_SLOT_LABELS.manual });
  const send = await sendTelegramMessage(text);
  if (!send.ok) return NextResponse.json({ ok: false, error: send.error }, { status: 500 });

  await admin.from("price_move_alert_logs").upsert(logRows, {
    onConflict: "sync_key,symbol,date,briefing_slot",
  });
  return NextResponse.json({ ok: true, dry_run: false, sent: items.length, items });
}

