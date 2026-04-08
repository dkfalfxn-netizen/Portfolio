import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

type Position = {
  symbol: string;
  name: string;
  owner: string;
};

type Quote = {
  price: number | null;
  previousClose: number | null;
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

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });

  const thresholdPct = 3;
  const { data: snaps, error } = await admin
    .from("portfolio_snapshots")
    .select("sync_key, positions");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!snaps || snaps.length === 0) return NextResponse.json({ ok: true, message: "portfolio_snapshots 없음" });

  // 로그 테이블이 있으면 같은 날 중복 발송 방지
  const dateKst = todayKST();
  const sentSet = new Set<string>();
  const { data: logs } = await admin
    .from("price_move_alert_logs")
    .select("sync_key,symbol,date")
    .eq("date", dateKst);
  for (const l of logs ?? []) sentSet.add(`${l.sync_key}:${l.symbol}:${l.date}`);

  const messages: string[] = [];
  const logRows: Array<{ sync_key: string; symbol: string; date: string; change_pct: number }> = [];

  for (const snap of snaps) {
    const syncKey = String(snap.sync_key);
    const positions = (Array.isArray(snap.positions) ? snap.positions : []) as Position[];
    const unique = [...new Set(positions.map((p) => p.symbol).filter(Boolean))];
    for (const symbol of unique) {
      const dedupeKey = `${syncKey}:${symbol}:${dateKst}`;
      if (sentSet.has(dedupeKey)) continue;

      const q = await fetchQuoteForSymbol(symbol);
      if (!q.price || !q.previousClose || q.previousClose <= 0) continue;
      const pct = ((q.price - q.previousClose) / q.previousClose) * 100;
      if (Math.abs(pct) < thresholdPct) continue;

      messages.push(`• ${symbol} ${pct > 0 ? "+" : ""}${pct.toFixed(2)}% (기준 3%)`);
      logRows.push({ sync_key: syncKey, symbol, date: dateKst, change_pct: pct });
    }
  }

  if (messages.length === 0) {
    return NextResponse.json({ ok: true, message: "3% 이상 변동 종목 없음", count: 0 });
  }

  const text = `<b>[포트폴리오 가격 변동 알림]</b>\n${dateKst}\n\n${messages.slice(0, 30).join("\n")}\n\n🔗 <a href="https://portfolio-one-xi-86.vercel.app/">대시보드 열기</a>`;
  const send = await sendTelegramMessage(text);
  if (!send.ok) return NextResponse.json({ error: send.error ?? "텔레그램 전송 실패" }, { status: 500 });

  if (logRows.length > 0) {
    await admin.from("price_move_alert_logs").upsert(logRows, { onConflict: "sync_key,symbol,date" });
  }

  return NextResponse.json({ ok: true, sent: messages.length });
}

