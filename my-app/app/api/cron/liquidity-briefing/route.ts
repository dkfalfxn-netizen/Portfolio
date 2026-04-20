import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 30;

type SeriesPoint = { date: string; value: number };
type QuotePoint = { symbol: string; price: number | null; previousClose: number | null };

const FRED_GRAPH_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function todayLabelKst(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toSignedPct(current: number, prev: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prev) || prev === 0) return null;
  return ((current - prev) / prev) * 100;
}

async function fetchFredSeriesLatest(seriesId: string): Promise<{ latest: SeriesPoint | null; previous: SeriesPoint | null }> {
  const res = await fetch(`${FRED_GRAPH_BASE}${encodeURIComponent(seriesId)}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });
  if (!res.ok) return { latest: null, previous: null };

  const text = await res.text();
  const lines = text.split(/\r?\n/).slice(1);
  const points: SeriesPoint[] = [];
  for (const line of lines) {
    const [date, valueRaw] = line.split(",");
    if (!date || !valueRaw || valueRaw.trim() === ".") continue;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) continue;
    points.push({ date: date.trim(), value });
  }
  if (points.length === 0) return { latest: null, previous: null };
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const latest = points[points.length - 1] ?? null;
  const previous = points.length >= 2 ? points[points.length - 2] : null;
  return { latest, previous };
}

async function fetchYahooQuote(symbol: string): Promise<QuotePoint> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { symbol, price: null, previousClose: null };
    const data = await res.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown>; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
    const result = data.chart?.result?.[0];
    const meta = result?.meta ?? {};
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
    const price =
      (typeof meta.regularMarketPrice === "number" && Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : null) ??
      (validCloses.length > 0 ? validCloses[validCloses.length - 1] : null);
    const previousClose =
      (typeof meta.previousClose === "number" && Number.isFinite(meta.previousClose) ? meta.previousClose : null) ??
      (validCloses.length > 1 ? validCloses[validCloses.length - 2] : null);
    return { symbol, price, previousClose };
  } catch {
    return { symbol, price: null, previousClose: null };
  }
}

async function sendTelegramMessage(text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수 미설정");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`텔레그램 전송 실패: ${body.slice(0, 240)}`);
  }
}

type LiquiditySnapshot = {
  date: string;
  netLiquidity: number;
  netLiquidityPct: number | null;
  walcl: number;
  tga: number;
  rrp: number;
  dxy: number | null;
  dxyPct: number | null;
  us10y: number | null;
  us10yPct: number | null;
  hySpread: number | null;
  hySpreadDiffBp: number | null;
  vix: number | null;
  vixPct: number | null;
  btc: number | null;
  btcPct: number | null;
  gold: number | null;
  goldPct: number | null;
  aiSummary: string;
};

function fallbackAiSummary(v: LiquiditySnapshot): string {
  const liqDir = v.netLiquidityPct !== null && v.netLiquidityPct >= 0 ? "유동성은 확대" : "유동성은 축소";
  const riskDir = v.vixPct !== null && v.vixPct <= 0 ? "리스크 선호는 개선" : "리스크 경계는 유지";
  const rateDir = v.us10yPct !== null && v.us10yPct > 0 ? "금리 상승 압력은 부담" : "금리 부담은 완화";
  return `${liqDir} 흐름입니다. ${riskDir}되는 가운데 ${rateDir}되는 구간으로 보입니다.`;
}

async function generateAiSummary(snapshot: LiquiditySnapshot): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallbackAiSummary(snapshot);

  try {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 140,
      messages: [
        {
          role: "system",
          content:
            "너는 매크로 데일리 브리핑 작성자다. 한국어로 1~2문장만 작성하고, 과장 없이 지표 변화 중심으로 요약한다.",
        },
        {
          role: "user",
          content: [
            `날짜: ${snapshot.date}`,
            `순유동성: ${snapshot.netLiquidity.toFixed(2)} (전일대비 ${snapshot.netLiquidityPct?.toFixed(2) ?? "N/A"}%)`,
            `DXY: ${snapshot.dxy?.toFixed(2) ?? "N/A"} (${snapshot.dxyPct?.toFixed(2) ?? "N/A"}%)`,
            `미10년물: ${snapshot.us10y?.toFixed(2) ?? "N/A"}% (${snapshot.us10yPct?.toFixed(2) ?? "N/A"}%)`,
            `하이일드스프레드: ${snapshot.hySpread?.toFixed(2) ?? "N/A"}%p (${snapshot.hySpreadDiffBp?.toFixed(1) ?? "N/A"}bp)`,
            `VIX: ${snapshot.vix?.toFixed(2) ?? "N/A"} (${snapshot.vixPct?.toFixed(2) ?? "N/A"}%)`,
            `BTC: ${snapshot.btc?.toFixed(2) ?? "N/A"} (${snapshot.btcPct?.toFixed(2) ?? "N/A"}%)`,
            `금: ${snapshot.gold?.toFixed(2) ?? "N/A"} (${snapshot.goldPct?.toFixed(2) ?? "N/A"}%)`,
          ].join("\n"),
        },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text && text.length > 0 ? text.slice(0, 220) : fallbackAiSummary(snapshot);
  } catch {
    return fallbackAiSummary(snapshot);
  }
}

async function saveSnapshot(snapshot: LiquiditySnapshot): Promise<void> {
  const admin = createSupabaseAdmin();
  if (!admin) {
    console.error("[liquidity-briefing] Supabase admin 클라이언트 초기화 실패 — DB 저장 건너뜀");
    return;
  }
  const { error } = await admin.from("liquidity_briefings").upsert(
    {
      report_date: snapshot.date,
      net_liquidity: snapshot.netLiquidity,
      net_liquidity_pct: snapshot.netLiquidityPct,
      walcl: snapshot.walcl,
      tga: snapshot.tga,
      rrp: snapshot.rrp,
      dxy: snapshot.dxy,
      dxy_pct: snapshot.dxyPct,
      us10y: snapshot.us10y,
      us10y_pct: snapshot.us10yPct,
      hy_spread: snapshot.hySpread,
      hy_spread_diff_bp: snapshot.hySpreadDiffBp,
      vix: snapshot.vix,
      vix_pct: snapshot.vixPct,
      btc: snapshot.btc,
      btc_pct: snapshot.btcPct,
      gold: snapshot.gold,
      gold_pct: snapshot.goldPct,
      ai_summary: snapshot.aiSummary,
    },
    { onConflict: "report_date" },
  );
  if (error) {
    console.error("[liquidity-briefing] DB upsert 실패:", error.message);
  }
}

async function run() {
  const [
    walcl,
    tga,
    rrp,
    hyYield,
    igYield,
    dxy,
    us10y,
    vix,
    btc,
    gold,
  ] = await Promise.all([
    fetchFredSeriesLatest("WALCL"),
    fetchFredSeriesLatest("WTREGEN"),
    fetchFredSeriesLatest("RRPONTSYD"),
    fetchFredSeriesLatest("BAMLH0A0HYM2EY"),
    fetchFredSeriesLatest("BAMLC0A4CBBBEY"),
    fetchYahooQuote("DX-Y.NYB"),
    fetchYahooQuote("^TNX"),
    fetchYahooQuote("^VIX"),
    fetchYahooQuote("BTC-USD"),
    fetchYahooQuote("GC=F"),
  ]);

  if (!walcl.latest || !tga.latest || !rrp.latest) {
    throw new Error("순유동성 계산용 FRED 데이터(WALCL/WTREGEN/RRPONTSYD) 수집 실패");
  }

  const netLiquidity = walcl.latest.value - (tga.latest.value + rrp.latest.value);
  const prevNetLiquidity =
    walcl.previous && tga.previous && rrp.previous
      ? walcl.previous.value - (tga.previous.value + rrp.previous.value)
      : null;
  const netLiquidityPct = prevNetLiquidity !== null ? toSignedPct(netLiquidity, prevNetLiquidity) : null;

  const hySpread =
    hyYield.latest && igYield.latest
      ? hyYield.latest.value - igYield.latest.value
      : null;
  const prevHySpread =
    hyYield.previous && igYield.previous
      ? hyYield.previous.value - igYield.previous.value
      : null;
  const hySpreadDiffBp =
    hySpread !== null && prevHySpread !== null
      ? (hySpread - prevHySpread) * 100
      : null;

  const dxyPct = dxy.price !== null && dxy.previousClose !== null ? toSignedPct(dxy.price, dxy.previousClose) : null;
  const us10yPct = us10y.price !== null && us10y.previousClose !== null ? toSignedPct(us10y.price, us10y.previousClose) : null;
  const vixPct = vix.price !== null && vix.previousClose !== null ? toSignedPct(vix.price, vix.previousClose) : null;
  const btcPct = btc.price !== null && btc.previousClose !== null ? toSignedPct(btc.price, btc.previousClose) : null;
  const goldPct = gold.price !== null && gold.previousClose !== null ? toSignedPct(gold.price, gold.previousClose) : null;
  const date = todayLabelKst();
  const baseSnapshot: LiquiditySnapshot = {
    date,
    netLiquidity,
    netLiquidityPct,
    walcl: walcl.latest.value,
    tga: tga.latest.value,
    rrp: rrp.latest.value,
    dxy: dxy.price,
    dxyPct,
    us10y: us10y.price,
    us10yPct,
    hySpread,
    hySpreadDiffBp,
    vix: vix.price,
    vixPct,
    btc: btc.price,
    btcPct,
    gold: gold.price,
    goldPct,
    aiSummary: "",
  };
  const aiSummary = await generateAiSummary(baseSnapshot);
  const snapshot: LiquiditySnapshot = { ...baseSnapshot, aiSummary };
  await saveSnapshot(snapshot);

  const text = [
    "🌊 <b>오전 9시 유동성 브리핑</b>",
    `기준일: ${escapeHtml(date)}`,
    "",
    `<b>AI 한줄 코멘트</b> ${escapeHtml(aiSummary)}`,
    "",
    "<i>참고: 본 브리핑은 투자 권유가 아닌 시장 모니터링용 요약입니다.</i>",
  ].join("\n");

  await sendTelegramMessage(text);

  return {
    ok: true,
    date,
    netLiquidity,
    netLiquidityPct,
    dxy: dxy.price,
    us10y: us10y.price,
    hySpread,
    vix: vix.price,
    btc: btc.price,
    gold: gold.price,
    aiSummary,
  };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await run();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
