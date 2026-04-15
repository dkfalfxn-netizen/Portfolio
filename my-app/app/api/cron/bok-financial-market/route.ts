import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const BOK_FINANCIAL_MARKET_URL =
  "https://www.bok.or.kr/portal/singl/newsData/list.do?pageIndex=&targetDepth=3&menuNo=201271&syncMenuChekKey=1&depthSubMain=&subMainAt=&searchCnd=1&searchKwd=&depth2=201157&depth3=201271&date=&sdate=&edate=&sort=1&pageUnit=10";

type BokItem = {
  title: string;
  date: string;
  href: string;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function todayLabelKst(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function toAbsoluteBokUrl(href: string): string {
  try {
    return new URL(href, "https://www.bok.or.kr").toString();
  } catch {
    return BOK_FINANCIAL_MARKET_URL;
  }
}

function parseBokFinancialMarketList(html: string): BokItem[] {
  const results: BokItem[] = [];
  const dedupe = new Set<string>();

  const anchorPattern =
    /<a[^>]*href="([^"]*newsData[^"]*|[^"]*menuNo=201271[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && results.length < 12) {
    const href = toAbsoluteBokUrl(match[1]);
    const inner = match[2];
    const text = normalizeWs(inner.replace(/<[^>]+>/g, " "));
    if (!text || text.length < 3) continue;

    if (
      text.includes("처음 목록") ||
      text.includes("이전 목록") ||
      text.includes("다음 목록") ||
      text.includes("끝 목록")
    ) {
      continue;
    }

    const key = `${href}::${text}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    const local = html.slice(Math.max(0, match.index - 220), Math.min(html.length, match.index + 220));
    const dateMatch = local.match(/(\d{4}\.\d{2}\.\d{2}|\d{4}-\d{2}-\d{2})/);

    results.push({
      title: text,
      date: dateMatch ? dateMatch[1].replace(/\./g, "-") : "",
      href,
    });
  }

  return results.slice(0, 10);
}

async function sendTelegramMessage(text: string): Promise<{ ok: boolean; error?: string }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return {
      ok: false,
      error: "TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수 미설정",
    };
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
    return { ok: false, error: `텔레그램 전송 실패: ${body.slice(0, 240)}` };
  }
  return { ok: true };
}

function buildTelegramText(items: BokItem[]): string {
  const header = `🏦 <b>한국은행 금융시장 일일 요약</b>\n기준일: ${todayLabelKst()}\n`;
  if (items.length === 0) {
    return `${header}\n- 목록에서 추출된 게시물이 없어 원문 링크를 확인해 주세요.\n${BOK_FINANCIAL_MARKET_URL}`;
  }

  const lines = items.slice(0, 10).map((item, idx) => {
    const datePart = item.date ? ` (${escapeHtml(item.date)})` : "";
    return `${idx + 1}. <a href="${item.href}">${escapeHtml(item.title)}</a>${datePart}`;
  });

  return `${header}\n${lines.join("\n")}\n\n원문: ${BOK_FINANCIAL_MARKET_URL}`;
}

async function run() {
  const response = await fetch(BOK_FINANCIAL_MARKET_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`BOK 페이지 조회 실패: ${response.status}`);
  }

  const html = await response.text();
  const items = parseBokFinancialMarketList(html);
  const message = buildTelegramText(items);
  const sent = await sendTelegramMessage(message);
  if (!sent.ok) throw new Error(sent.error ?? "텔레그램 전송 실패");

  return { fetched: items.length, sent: true };
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
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
